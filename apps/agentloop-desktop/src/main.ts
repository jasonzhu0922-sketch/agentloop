import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { OpenAICompatibleModel } from "@zhujun/agentloop";
import type { LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { startDesktop } from "./application.ts";
import { modelEndpoint } from "./security/model-endpoint.ts";
import { CloudAccountAuth } from "./auth/cloud-auth.ts";
import { registrationsFromEnvironment } from "@zhujun/agentloop-local-runtime/connectors";
import { builtinConnectorModules } from "./connectors/builtin-connector-modules.ts";

/** Development command port; Account Service uses 8795 by default. */
export const DESKTOP_DEVELOPMENT_PORT = 8796;

export function defaultDataDirectory(platform = process.platform, environment = process.env): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "AgentLoop Desktop Development");
  if (platform === "win32") {
    if (!environment.LOCALAPPDATA || !isAbsolute(environment.LOCALAPPDATA)) throw new Error("desktop_localappdata_required");
    return join(environment.LOCALAPPDATA, "AgentLoop Desktop Development");
  }
  return join(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentloop-desktop-development");
}
function configuredModels(): LocalModelProviderPort | undefined {
  const baseUrl = process.env.AGENTLOOP_DESKTOP_MODEL_BASE_URL;
  const model = process.env.AGENTLOOP_DESKTOP_MODEL;
  const apiKey = process.env.AGENTLOOP_DESKTOP_MODEL_API_KEY;
  if (![baseUrl, model, apiKey].some(Boolean)) return undefined;
  if (!baseUrl || !model || !apiKey) throw new Error("desktop_model_configuration_incomplete");
  modelEndpoint(baseUrl);
  return { modelKeys: () => ["configured"], create(key, onRetry) {
    if (key !== "configured") throw new Error("desktop_model_unknown");
    return new OpenAICompatibleModel({ baseUrl, model, apiKey, contextWindowTokens: 128_000, maxOutputTokens: 8192, onRetry });
  } };
}
export function desktopLaunchOptions(args: readonly string[]): { dataDirectory?: string; openBrowser: boolean } {
  if (!args.includes("--development")) throw new Error("desktop_requires_explicit_development_mode");
  let dataDirectory: string | undefined; let openBrowser = true;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--development") continue;
    if (args[index] === "--no-open") { openBrowser = false; continue; }
    if (args[index] === "--data-dir" && args[index + 1]) { dataDirectory = args[++index]; continue; }
    throw new Error("desktop_argument_invalid");
  }
  return { ...(dataDirectory === undefined ? {} : { dataDirectory }), openBrowser };
}
async function main(): Promise<void> {
  const { dataDirectory, openBrowser } = desktopLaunchOptions(process.argv.slice(2));
  const authUrl = process.env.AGENTLOOP_DESKTOP_AUTH_BASE_URL;
  const log = (entry: string) => console.log(`[AgentLoop Desktop] ${new Date().toISOString()} ${entry}`);
  const app = await startDesktop({ mode: "development", dataDirectory: dataDirectory ?? defaultDataDirectory(), models: configuredModels(), openBrowser, port: DESKTOP_DEVELOPMENT_PORT, log,
    cloudAuth: authUrl ? new CloudAccountAuth(authUrl) : undefined,
    // Built-ins are selected by the Desktop host, never by the browser. The
    // environment remains available for additional host-approved modules.
    connectorModules: [
      ...builtinConnectorModules(),
      ...registrationsFromEnvironment(process.env.AGENTLOOP_DESKTOP_CONNECTOR_MODULES_JSON ?? ""),
    ] });
  const expectedOrigin = `http://127.0.0.1:${DESKTOP_DEVELOPMENT_PORT}`;
  if (app.existing && app.origin !== expectedOrigin) {
    console.error(`Desktop 未启动：已有实例运行在 ${app.origin}，不是固定端口 ${DESKTOP_DEVELOPMENT_PORT}。请先在原终端停止该实例后重试。`);
    process.exitCode = 1;
    return;
  }
  console.log(`[AgentLoop Desktop / 开发模式] ${app.existing ? "已复用运行实例" : "本地服务就绪"}：${app.origin}/`);
  console.log(app.existing ? "[AgentLoop Desktop] 此实例由已有终端托管；请在原终端查看运行摘要。" : "[AgentLoop Desktop] 运行摘要将持续输出到此终端；按 Ctrl+C 关闭服务。");
  if (!app.browserOpened && openBrowser) console.log("浏览器未能自动打开，请手动访问以上本地地址。");
  if (!authUrl) console.log("云端账号服务未配置：请设置 AGENTLOOP_DESKTOP_AUTH_BASE_URL 为独立 Account Service 基址后重启；开发模式也不跳过登录。");
  if (!app.existing) for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    void app.close().catch(() => console.error("关闭被拒绝：仍有活动请求、Run 或未完成的资源回收。请等待或取消 Run 后重试。"));
  });
}
// No raw exceptions: initialization/provider messages can contain secrets.
if (import.meta.main) void main().catch(error => {
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") console.error(`Desktop 启动失败：固定端口 ${DESKTOP_DEVELOPMENT_PORT} 已被占用。请先停止该端口上的进程。`);
  else console.error("Desktop 启动失败。请检查显式 --development 参数、模型配置、独立数据目录或实例锁；不会自动接管旧锁。");
  process.exitCode = 1;
});
