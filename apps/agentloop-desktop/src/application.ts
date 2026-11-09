import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@zhujun/agentloop";
import type { LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { DesktopAccountManagers } from "./accounts/account-managers.ts";
import { DesktopApi, DEFAULT_RUNTIME_ID, type StaticAsset } from "./api/desktop-api.ts";
import { claimInstance } from "./platform/instance-lock.ts";
import { openBrowser } from "./platform/browser.ts";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudAuthPort } from "./auth/cloud-auth.ts";
import type { ConnectorModuleRegistration } from "@zhujun/agentloop-local-runtime/connectors";

export interface DesktopOptions {
  readonly mode: "development" | "packaged";
  /** Required for packaged hosts; all renderer assets are prepared at build time. */
  readonly webDirectory?: string;
  readonly dataDirectory: string;
  readonly runtimeEnvironmentDirectory?: string;
  readonly runtimeTurnDefaults?: { readonly planningMaxTurns?: number; readonly stepMaxTurns?: number; readonly webSearch?: { readonly searchProvider?: "baidu" | "bing" | "bocha"; readonly searchEndpoint?: string; readonly searchApiKey?: string } };
  readonly models?: LocalModelProviderPort;
  readonly cloudAuth?: CloudAuthPort;
  readonly port?: number;
  readonly openBrowser?: boolean;
  readonly browserLauncher?: (origin: string) => Promise<void>;
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly bundledSkillDirectories?: readonly string[];
  /** Non-secret tool paths and settings supplied by the native host. */
  readonly computerCommandEnvironment?: Readonly<Record<string, string>>;
  readonly connectorModules?: readonly ConnectorModuleRegistration[];
  /** Optional development-only operational summary sink; request bodies are never logged. */
  readonly log?: (entry: string) => void;
}
export type DesktopApplication = { existing: true; origin: string; browserOpened: boolean } | {
  existing: false; origin: string; browserOpened: boolean; close(): Promise<void>;
};
async function assets(webDirectory?: string): Promise<ReadonlyMap<string, StaticAsset>> {
  const entries = await Promise.all([
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/login", "login.html", "text/html; charset=utf-8"],
    ["/register", "login.html", "text/html; charset=utf-8"],
    ["/login.js", "login.js", "text/javascript; charset=utf-8"],
    ["/login.css", "login.css", "text/css; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/composer-preferences.js", "composer-preferences.js", "text/javascript; charset=utf-8"],
    ["/model-settings.js", "model-settings.js", "text/javascript; charset=utf-8"],
    ["/capability-settings.js", "capability-settings.js", "text/javascript; charset=utf-8"],
    ["/artifact-workspace.js", "artifact-workspace.js", "text/javascript; charset=utf-8"],
    ["/conversation.js", "conversation.js", "text/javascript; charset=utf-8"],
    ["/human-loop.js", "human-loop.js", "text/javascript; charset=utf-8"],
    ["/turn-projection.js", "turn-projection.js", "text/javascript; charset=utf-8"],
    ["/run-polling.js", "run-polling.js", "text/javascript; charset=utf-8"],
    ["/conversation.css", "conversation.css", "text/css; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
    ["/multi-runtime.css", "multi-runtime.css", "text/css; charset=utf-8"],
    ["/assets/xuanwu-mascot-icon.png", "xuanwu-mascot-icon.png", "image/png"],
    ...["qinglong", "baihu", "zhuque", "qilin", "taotie", "yinglong", "pixiu"].map(key => [`/assets/runtime-${key}.png`, `runtime-${key}.png`, "image/png"]),
    ...["presentation/assistant-message-presentation.js", "projections/assistant-event-projection.js", "projections/execution-detail-projection.js", "ui/scroll-follow.js", "ui/composer-input.js", "ui/message-selection.js", "ui/steer-queue.js"].map(file => [`/reference/${file}`, `reference/${file}`, "text/javascript; charset=utf-8"]),
  ].map(async ([route, file, type]) => [route!, { content: await readFile(webDirectory ? join(webDirectory, file!) : new URL(`../web/${file}`, import.meta.url)), type: type! }] as const));
  if (webDirectory) {
    entries.push(["/markdown.js", { content: await readFile(join(webDirectory, "markdown.js")), type: "text/javascript; charset=utf-8" }]);
    entries.push(["/markdown.css", { content: await readFile(join(webDirectory, "markdown.css")), type: "text/css; charset=utf-8" }]);
  } else {
    const { build } = await import("esbuild");
    const markdown = await build({ stdin: { contents: 'export { renderMarkdown, artifactPreviewMode, renderBlobPreview, renderStructuredPreview, updateArtifactPreviewMarkup } from "@zhujun/agentloop-artifact-preview";', resolveDir: dirname(fileURLToPath(import.meta.url)), loader: "js" }, bundle: true, write: false, format: "esm", platform: "browser", minify: true, logLevel: "silent" });
    entries.push(["/markdown.js", { content: Buffer.from(markdown.outputFiles![0]!.contents), type: "text/javascript; charset=utf-8" }]);
    entries.push(["/markdown.css", { content: await readFile(fileURLToPath(import.meta.resolve("@zhujun/agentloop-artifact-preview/markdown.css"))), type: "text/css; charset=utf-8" }]);
  }
  return new Map(entries);
}
export async function startDesktop(options: DesktopOptions): Promise<DesktopApplication> {
  if (options.mode !== "development" && options.mode !== "packaged") throw new Error("desktop_production_auth_not_implemented");
  if (options.mode === "packaged" && (!options.cloudAuth || !options.webDirectory)) throw new Error("desktop_package_configuration_required");
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error("desktop_port_invalid");
  const browser = async (origin: string) => {
    if (options.openBrowser === false) return false;
    try { await (options.browserLauncher ?? openBrowser)(origin); return true; }
    catch { return false; } // Keep the ready host usable; CLI prints the local URL.
  };
  const claim = await claimInstance(options.dataDirectory, options.mode);
  if (claim.existing) return { existing: true, origin: claim.origin, browserOpened: await browser(claim.origin) };
  const lock = claim.lock;
  let api: DesktopApi | undefined;
  const server = createServer((request, response) => { void api!.handle(request, response); });
  server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000; server.maxConnections = 128;
  const closeServer = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
  });
  try {
    api = new DesktopApi(lock.instanceId, await assets(options.webDirectory), options.cloudAuth, options.log, options.directoryPicker);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("desktop_bind_failed");
    api.origin = new URL(`http://127.0.0.1:${address.port}`).origin;
    const accounts = new DesktopAccountManagers({ dataDirectory: lock.dataDirectory, defaultRuntimeId: DEFAULT_RUNTIME_ID,
      runtimeEnvironmentDirectory: options.runtimeEnvironmentDirectory,
      runtimeTurnDefaults: options.runtimeTurnDefaults,
      models: options.models, bundledSkillDirectories: options.bundledSkillDirectories,
      runEventLogSink: options.log === undefined ? undefined : (_runtime, line) => options.log!(line),
      connectorModules: options.connectorModules ?? [],
      computerCommandEnvironment: options.computerCommandEnvironment,
      identity: { installationId: async () => lock.installationId } });
    await accounts.ready(); api.accounts = accounts;
    await lock.publish(api.origin);
    const activeApi = api;
    let closed = false; let closing: Promise<void> | undefined;
    return { existing: false, origin: api.origin, browserOpened: await browser(api.origin), close() {
      if (closed) return Promise.resolve(); if (closing) return closing;
      if (activeApi.activeRequests > 0) return Promise.reject(new Error("desktop_requests_prevent_close"));
      activeApi.stopping = true;
      let teardownStarted = false;
      closing = Promise.resolve().then(async () => {
        await activeApi.accounts!.close(); teardownStarted = true;
        await closeServer(); activeApi.clearSessions(); await lock.release(); closed = true;
      }).catch(error => {
        const recoverable = !teardownStarted && error instanceof AppError && ["runtime_operations_prevent_close", "runtime_active_runs_prevent_close"].includes(error.message);
        if (recoverable) activeApi.stopping = false;
        else teardownStarted = true; // Unknown/partial teardown stays fail-closed.
        throw error;
      })
        .finally(() => { if (!teardownStarted || closed) closing = undefined; });
      return closing;
    } };
  } catch (error) {
    // Keep the lock if manager teardown fails; never permit another DB owner.
    if (api?.accounts) await api.accounts.close();
    await closeServer(); await lock.release(); throw error;
  }
}
