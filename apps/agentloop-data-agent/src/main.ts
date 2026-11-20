import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDataAgent } from "./agent.ts";
import { createChatServer } from "./server.ts";
import { connectState } from "./tidb-state.ts";
import { ModelSettings } from "./model-settings.ts";
import { SettingsService } from "./settings.ts";
import { colorizeTerminalLogLabel, colorizeTerminalLogLine } from "@zhujun/agentloop";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.DATA_AGENT_PORT ?? "8810");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("DATA_AGENT_PORT 无效");
const stateUrl = process.env.DATA_AGENT_TIDB_URL;
if (!stateUrl) throw new Error("请配置 DATA_AGENT_TIDB_URL；本应用结构化状态使用 TiDB，大文件使用持久磁盘");
const fileDirectory = resolve(appRoot, process.env.DATA_AGENT_FILE_DIR ?? "data/files");
const terminalLogOptions = { colorMode: process.env.AGENTLOOP_LOG_COLOR, isTTY: process.stdout.isTTY, noColor: process.env.NO_COLOR };
const log = (entry: string) => console.log(`${colorizeTerminalLogLabel("[AgentLoop Data Agent]", "agentloop-data-agent", terminalLogOptions)} ${new Date().toISOString()} ${colorizeTerminalLogLine(entry, terminalLogOptions)}`);
let agent: Awaited<ReturnType<typeof createDataAgent>> | undefined;
try {
  const models = await new ModelSettings(resolve(appRoot, process.env.DATA_AGENT_MODEL_CONFIG ?? "config/llm-providers.json")).load();
  const modelKey = models.defaultModelKey;
  if (!models.registry.modelKeys().includes(modelKey)) throw new Error("DATA_AGENT_MODEL_KEY 未在配置中声明");
  agent = await createDataAgent({
    connection: await connectState(stateUrl), fileDirectory,
    skillRoot: join(appRoot, "skills", "data-analysis"), python: process.env.DATA_AGENT_PYTHON ?? "python3",
    modelFactory: (onRetry, key) => models.registry.create(key, onRetry),
    modelKeys: models.registry.modelKeys(), defaultModelKey: modelKey,
    runEventLogSink: log,
  });
  const settings = new SettingsService(models, { python: process.env.DATA_AGENT_PYTHON ?? "python3",
    script: join(appRoot, "scripts/manage_catalog.py"), skillRoot: join(appRoot, "skills/data-analysis") });
  const server = createChatServer(agent, { webRoot: join(appRoot, "web"), models: models.registry.modelCatalog(), defaultModelKey: modelKey, settings });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  console.log(`经营问数已启动：http://127.0.0.1:${port}`);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    await agent!.close();
  }
  process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
} catch (error) {
  await agent?.close();
  console.error("问数 Agent 启动失败：请检查 TiDB、端口、模型配置和 Skill 包。", error instanceof Error ? error.name : "Error");
  if (process.argv.includes("--diagnose") && error instanceof Error) console.error(error.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, "<url>"));
  process.exitCode = 1;
}
