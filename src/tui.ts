import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  TuiApiClient,
  TuiApiError,
  type TuiRun,
  type TuiTool,
} from "./tui/api-client.ts";
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
      this.write("\n1) 运行任务\n2) 查看 Tool\n3) 查看 Run 详情\n4) 注销\nq) 退出\n");
      const choice = (await this.ask("选择: ")).toLowerCase();
      try {
        if (choice === "1") await this.runTask();
        else if (choice === "2") await this.listTools();
        else if (choice === "3") await this.showRun(await this.askRequired("Run ID: "));
        else if (choice === "4") {
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
    const task = await this.askMultiline("任务内容");
    const { tools } = await this.client.tools();
    await this.executeTask(task, tools);
  }

  private async executeTask(task: string, tools: readonly TuiTool[]): Promise<void> {
    const selectedDangerousTools = new Set(tools.filter((tool) => tool.dangerous).map((tool) => tool.name));
    const allowDangerousTools = selectedDangerousTools.size > 0
      ? await this.confirm("当前服务包含危险 Tool；本次允许写文件、运行命令或 GUI 操作吗？", false)
      : false;

    this.info("任务运行中；服务端会在 Plan、工具证据和 Assessment 完成后返回结果…");
    const { run } = await this.client.executeRun({
      input: task,
      allowDangerousTools,
    });
    this.showRunSummary(run);
    await this.showRunDetails(run.id, false);
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
    this.write(`\nRun ${run.id}\n状态: ${run.status}\n`);
    if (run.errorCode !== undefined) this.fail(`错误码: ${run.errorCode}`);
    if (run.output !== undefined && run.output.length > 0) this.write(`输出:\n${run.output}\n`);
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
