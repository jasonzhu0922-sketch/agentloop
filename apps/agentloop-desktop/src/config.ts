import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface DesktopConfig {
  readonly appRoot: string;
  readonly host: string;
  readonly port: number;
  readonly webOrigin: string;
  readonly dataRoot: string;
  readonly localAgentUrl: string;
  readonly localAgentEntry: string;
  readonly manageLocalAgent: boolean;
  readonly openBrowser: boolean;
  readonly browserName: string;
  readonly cloudAuthUrl?: string;
  readonly localSessionToken?: string;
}

export function loadDesktopConfig(appRoot: string): DesktopConfig {
  const host = process.env.AGENTLOOP_DESKTOP_HOST ?? "127.0.0.1";
  const port = positivePort(process.env.AGENTLOOP_DESKTOP_PORT, 5176);
  const webOrigin = "http://" + host + ":" + String(port);
  const dataRoot = resolve(process.env.AGENTLOOP_DESKTOP_DATA_ROOT ?? defaultDataRoot());
  const localAgentUrl = process.env.LOCAL_AGENT_URL ?? "http://127.0.0.1:8790";
  const localAgentEntry = resolve(process.env.AGENTLOOP_LOCAL_AGENT_ENTRY
    ?? join(appRoot, "..", "agentloop-multi-runtime", "local-agent-runtime", "src", "main.ts"));
  const manageLocalAgent = process.env.AGENTLOOP_DESKTOP_MANAGE_LOCAL_AGENT !== "0";
  return {
    appRoot,
    host,
    port,
    webOrigin,
    dataRoot,
    localAgentUrl,
    localAgentEntry,
    manageLocalAgent,
    openBrowser: process.env.AGENTLOOP_DESKTOP_OPEN_BROWSER !== "0",
    browserName: process.env.AGENTLOOP_DESKTOP_BROWSER ?? "Google Chrome",
    ...(process.env.AGENTLOOP_CLOUD_AUTH_URL === undefined ? {} : { cloudAuthUrl: process.env.AGENTLOOP_CLOUD_AUTH_URL }),
    ...(process.env.AGENTLOOP_DESKTOP_LOCAL_SESSION === undefined ? {} : { localSessionToken: process.env.AGENTLOOP_DESKTOP_LOCAL_SESSION }),
  };
}

function defaultDataRoot(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "AgentLoop Desktop");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AgentLoop Desktop");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "AgentLoop Desktop");
}

function positivePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("desktop port must be between 1 and 65535");
  return port;
}

export function appRootFromModule(moduleUrl: string): string {
  return resolve(dirname(new URL(moduleUrl).pathname), "..");
}
