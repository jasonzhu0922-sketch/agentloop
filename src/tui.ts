import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  TuiApiClient,
  TuiApiError,
  type TuiAgent,
  type TuiProvider,
  type TuiRun,
  type TuiSkill,
  type TuiTool,
} from "./tui/api-client.ts";
import { parseSelection } from "./tui/selection.ts";
import { readMaskedSecret, setTerminalEcho, supportsMaskedSecretInput } from "./tui/secret-input.ts";

const COLORS = {
  accent: "\u001B[36m",
  muted: "\u001B[2m",
  error: "\u001B[31m",
  reset: "\u001B[0m",
} as const;

class TuiAbort extends Error {
  constructor() {
    super("TUI closed");
  }
}

class AgentLoopTui {
  private readonly client: TuiApiClient;
  private readline: Interface;
  private readonly color: boolean;

  constructor(client: TuiApiClient) {
    this.client = client;
    this.readline = this.createReadline();
    this.color = output.isTTY === true && process.env.NO_COLOR === undefined;
  }

  async run(): Promise<void> {
    this.heading("AgentLoop TUI", `API: ${this.client.endpoint}`);
    await this.requireHealthyService();
    await this.authenticate();
    await this.mainMenu();
  }

  close(): void {
    this.readline.close();
  }

  private async requireHealthyService(): Promise<void> {
    try {
      await this.client.health();
      this.info("服务已连接。");
    } catch (error) {
      this.fail(formatError(error));
      this.info("请先在另一个终端启动服务：npm start");
      throw error;
    }
  }

  private async authenticate(): Promise<void> {
    if (this.client.authenticated) {
      try {
        const { user } = await this.client.me();
        this.info(`已使用环境 Token 登录为 ${user.email}。`);
        return;
      } catch {
        this.client.clearToken();
        this.info("环境 Token 已失效，请重新登录。");
      }
    }
    for (;;) {
      this.write("\n1) 登录\n2) 注册\nq) 退出\n");
      const choice = (await this.ask("选择: ")).toLowerCase();
      if (choice === "q" || choice === "quit") throw new TuiAbort();
      if (choice !== "1" && choice !== "2") {
        this.fail("请输入 1、2 或 q。");
        continue;
      }
      const email = await this.askRequired("邮箱: ");
      const password = await this.askSecret("密码: ");
      if (choice === "2") {
        const confirmation = await this.askSecret("再次输入密码: ");
        if (password !== confirmation) {
          this.fail("两次密码不一致。");
          continue;
        }
      }
      try {
        const result = choice === "1"
          ? await this.client.login(email, password)
          : await this.client.register(email, password);
        this.info(`欢迎，${result.user.email}。`);
        return;
      } catch (error) {
        this.fail(formatError(error));
      }
    }
  }

  private async mainMenu(): Promise<void> {
    for (;;) {
      this.write("\n1) 运行已有 Agent\n2) 快速测试已有 Skill\n3) 查看 Agent\n4) 查看 Skill\n5) 查看 Tool\n6) 查看 Run 详情\n7) 高级：创建 Agent\n8) 注销\nq) 退出\n");
      const choice = (await this.ask("选择: ")).toLowerCase();
      try {
        if (choice === "1") await this.runTask();
        else if (choice === "2") await this.quickRunSkill();
        else if (choice === "3") await this.listAgents();
        else if (choice === "4") await this.listSkills();
        else if (choice === "5") await this.listTools();
        else if (choice === "6") await this.showRun(await this.askRequired("Run ID: "));
        else if (choice === "7") await this.createAgent();
        else if (choice === "8") {
          await this.client.logout();
          this.info("已注销。本次会话未在磁盘保存 Token。");
          await this.authenticate();
        } else if (choice === "q" || choice === "quit") return;
        else this.fail("请输入菜单中的选项。");
      } catch (error) {
        if (error instanceof TuiAbort) throw error;
        this.fail(formatError(error));
      }
    }
  }

  private async runTask(): Promise<void> {
    const { agents } = await this.client.agents();
    if (agents.length === 0) {
      this.fail("还没有 Agent，请先使用菜单 7 创建，或使用菜单 2 直接测试已有 Skill。\n");
      return;
    }
    const agent = await this.choose("选择 Agent", agents, (item) => `${item.name}  [${item.providerKey}/${item.modelId}]`);
    const task = await this.askMultiline("任务内容");
    const { tools } = await this.client.tools();
    await this.executeTask(agent, task, tools);
  }

  private async quickRunSkill(): Promise<void> {
    const [{ skills }, { agents }, { providers, defaultProviderKey }, { tools }] = await Promise.all([
      this.client.skills(),
      this.client.agents(),
      this.client.providers(),
      this.client.tools(),
    ]);
    if (skills.length === 0) {
      this.fail("服务端尚未发现可测试的 Skill Package。请检查 SKILL_DIRECTORY。\n");
      return;
    }
    if (providers.length === 0) throw new Error("当前服务没有已配置的 Provider");
    const skill = await this.choose("选择已有 Skill", skills, (item) => `${item.name} — ${item.description}`);
    const runnerName = `TUI Skill Runner: ${skill.name}`;
    const allToolNames = tools.map((tool) => tool.name);
    let agent = agents.find((item) => item.name === runnerName);
    if (agent === undefined) {
      const provider = providers.find((item) => item.key === defaultProviderKey) ?? providers[0];
      agent = (await this.client.createAgent({
        name: runnerName,
        systemPrompt: [
          "You are a test runner for one bound Skill in a plan-first runtime.",
          "Follow the exact loaded Skill instructions and do not claim completion without persisted evidence and assessment.",
        ].join(" "),
        providerKey: provider.key,
        modelId: "default",
        skillIds: [skill.id],
        toolNames: allToolNames,
      })).agent;
      this.info(`已创建并绑定 ${skill.name} 的测试 Agent；未创建新的 Skill。`);
    } else if (!agent.skillIds.includes(skill.id)) {
      throw new Error(`同名测试 Agent 未绑定当前 ${skill.name} Package；请在高级菜单中使用另一个名称创建 Agent`);
    } else {
      this.info(`复用 ${skill.name} 的已有测试 Agent。`);
    }
    const task = await this.askMultiline(`${skill.name} 测试任务`);
    await this.executeTask(agent, task, tools);
  }

  private async executeTask(agent: TuiAgent, task: string, tools: readonly TuiTool[]): Promise<void> {
    const selectedDangerousTools = new Set(tools.filter((tool) => tool.dangerous).map((tool) => tool.name));
    const needsConsent = agent.toolNames.some((name) => selectedDangerousTools.has(name));
    const allowDangerousTools = needsConsent
      ? await this.confirm("这个 Agent 包含危险 Tool；本次允许写文件、运行命令或 GUI 操作吗？", false)
      : false;

    this.info("任务运行中；服务端会在 Plan、工具证据和 Assessment 完成后返回结果…");
    const { run } = await this.client.executeRun({
      agentId: agent.id,
      input: task,
      allowDangerousTools,
    });
    this.showRunSummary(run);
    await this.showRunDetails(run.id, false);
  }

  private async listAgents(): Promise<void> {
    const { agents } = await this.client.agents();
    if (agents.length === 0) return this.info("没有 Agent。\n");
    this.write("\nAgent\n");
    for (const agent of agents) {
      this.write(`- ${agent.name}\n  ${agent.id}\n  Provider: ${agent.providerKey}/${agent.modelId}; Skills: ${agent.skillIds.length}; Tools: ${agent.toolNames.length}\n`);
    }
  }

  private async listSkills(): Promise<void> {
    const { skills } = await this.client.skills();
    if (skills.length === 0) return this.info("没有可用 Skill。\n");
    this.write("\nSkill\n");
    for (const skill of skills) {
      this.write(`- ${skill.name} (${skill.sourceKind})\n  ${skill.description}\n  ${skill.id}\n`);
    }
  }

  private async listTools(): Promise<void> {
    const { tools } = await this.client.tools();
    if (tools.length === 0) return this.info("当前服务没有可用 Tool。\n");
    this.write("\nTool\n");
    for (const tool of tools) {
      this.write(`- ${tool.name}${tool.dangerous ? " [危险]" : ""}\n  ${tool.description}\n`);
    }
  }

  private async showRun(id: string): Promise<void> {
    await this.showRunDetails(id, true);
  }

  private async showRunDetails(id: string, includeRun: boolean): Promise<void> {
    if (includeRun) {
      const { run } = await this.client.run(id);
      this.showRunSummary(run);
    }
    try {
      const plan = await this.client.runPlan(id);
      this.write("\nPlan / Assessment\n");
      this.write(`${JSON.stringify(plan, null, 2)}\n`);
    } catch (error) {
      this.fail(`Plan 暂不可用：${formatError(error)}`);
    }
    try {
      const { events } = await this.client.runEvents(id);
      this.write("\n事件\n");
      for (const event of events) this.write(`#${event.seq} ${event.type}\n`);
    } catch (error) {
      this.fail(`事件暂不可用：${formatError(error)}`);
    }
  }

  private showRunSummary(run: TuiRun): void {
    this.write(`\nRun ${run.id}\n状态: ${run.status}\nAgent: ${run.agentId}\n`);
    if (run.errorCode !== undefined) this.fail(`错误码: ${run.errorCode}`);
    if (run.output !== undefined && run.output.length > 0) this.write(`输出:\n${run.output}\n`);
  }

  private async createAgent(): Promise<void> {
    const [{ providers }, { skills }, { tools }] = await Promise.all([
      this.client.providers(),
      this.client.skills(),
      this.client.tools(),
    ]);
    if (providers.length === 0) throw new Error("当前服务没有已配置的 Provider");
    const name = await this.askRequired("Agent 名称: ");
    const systemPrompt = await this.askMultiline("System Prompt");
    const provider = await this.choose("选择 Provider", providers, (item) => `${item.key} / ${item.defaultModel}`);
    const modelId = (await this.ask("模型 ID（留空使用 Provider 默认模型）: ")).trim() || "default";
    const skillIds = await this.chooseMany("绑定 Skill（输入序号，以逗号分隔；留空不绑定）", skills, (item) => item.name);
    const toolNames = await this.chooseMany(
      "启用 Tool（输入序号，以逗号分隔；留空不启用）",
      tools,
      (item) => `${item.name}${item.dangerous ? " [危险]" : ""}`,
    );
    const { agent } = await this.client.createAgent({
      name,
      systemPrompt,
      providerKey: provider.key,
      modelId,
      skillIds: skillIds.map((skill) => skill.id),
      toolNames: toolNames.map((tool) => tool.name),
    });
    this.info(`已创建 Agent ${agent.name} (${agent.id})。`);
  }

  private async choose<T>(title: string, values: readonly T[], label: (value: T) => string): Promise<T> {
    this.write(`\n${title}\n`);
    values.forEach((value, index) => this.write(`${index + 1}) ${label(value)}\n`));
    for (;;) {
      const answer = await this.ask("选择序号: ");
      const index = Number(answer) - 1;
      if (Number.isSafeInteger(index) && index >= 0 && index < values.length) return values[index];
      this.fail(`请输入 1 到 ${values.length} 之间的整数。`);
    }
  }

  private async chooseMany<T>(title: string, values: readonly T[], label: (value: T) => string): Promise<T[]> {
    if (values.length === 0) return [];
    this.write(`\n${title}\n`);
    values.forEach((value, index) => this.write(`${index + 1}) ${label(value)}\n`));
    for (;;) {
      const answer = await this.ask("选择: ");
      try {
        return parseSelection(answer, values);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : "选择无效");
      }
    }
  }

  private async askMultiline(title: string): Promise<string> {
    this.write(`\n${title}（逐行输入，单独输入 . 完成）\n`);
    const lines: string[] = [];
    for (;;) {
      const line = await this.ask("  > ");
      if (line === ".") break;
      lines.push(line);
    }
    const value = lines.join("\n").trim();
    if (value.length === 0) {
      this.fail("内容不能为空。");
      return this.askMultiline(title);
    }
    return value;
  }

  private async askRequired(prompt: string): Promise<string> {
    for (;;) {
      const value = (await this.ask(prompt)).trim();
      if (value.length > 0) return value;
      this.fail("此项不能为空。");
    }
  }

  private ask(prompt: string): Promise<string> {
    return this.readline.question(prompt).then((value) => value.trimEnd());
  }

  private async askSecret(prompt: string): Promise<string> {
    if (!supportsMaskedSecretInput(input, output)) return this.ask(prompt);
    // An Interface keeps its own input listener even after pause(). If it
    // remains attached while raw input resumes, it echoes each character.
    this.readline.close();
    let echoDisabled = false;
    try {
      await setTerminalEcho(false);
      echoDisabled = true;
      return await readMaskedSecret(input, output, prompt);
    } catch (error) {
      if (error instanceof Error && error.message === "TUI closed") throw new TuiAbort();
      throw error;
    } finally {
      if (echoDisabled) await setTerminalEcho(true);
      this.readline = this.createReadline();
    }
  }

  private createReadline(): Interface {
    return createInterface({ input, output, terminal: input.isTTY === true });
  }

  private async confirm(prompt: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";
    for (;;) {
      const value = (await this.ask(`${prompt}${suffix}`)).toLowerCase();
      if (value.length === 0) return defaultValue;
      if (value === "y" || value === "yes") return true;
      if (value === "n" || value === "no") return false;
      this.fail("请输入 y 或 n。");
    }
  }

  private heading(title: string, subtitle: string): void {
    this.write(`\n${this.paint(COLORS.accent, title)}\n${this.paint(COLORS.muted, subtitle)}\n`);
  }

  private info(message: string): void {
    this.write(`${this.paint(COLORS.accent, message)}\n`);
  }

  private fail(message: string): void {
    this.write(`${this.paint(COLORS.error, message)}\n`);
  }

  private paint(color: string, message: string): string {
    return this.color ? `${color}${message}${COLORS.reset}` : message;
  }

  private write(value: string): void {
    output.write(value);
  }
}

function formatError(error: unknown): string {
  if (error instanceof TuiApiError) {
    const trace = error.traceId === undefined ? "" : ` (traceId: ${error.traceId})`;
    return `${error.message}${trace}`;
  }
  return error instanceof Error ? error.message : "未知错误";
}

function parseArguments(args: readonly string[]): { url: string } {
  if (args.length === 0) return { url: process.env.AGENTLOOP_URL ?? "http://127.0.0.1:8787" };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    output.write("Usage: npm run tui -- [--url http://127.0.0.1:8787]\n");
    process.exit(0);
  }
  if (args.length === 2 && args[0] === "--url") return { url: args[1] };
  throw new Error("Usage: npm run tui -- [--url http://127.0.0.1:8787]");
}

try {
  const { url } = parseArguments(process.argv.slice(2));
  const tui = new AgentLoopTui(new TuiApiClient(url, process.env.AGENTLOOP_TOKEN));
  try {
    await tui.run();
  } finally {
    tui.close();
  }
} catch (error) {
  if (!(error instanceof TuiAbort)) {
    output.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}

export { AgentLoopTui };
