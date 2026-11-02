import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@zhujun/agentloop";
import type { LocalModelProviderPort } from "@zhujun/agentloop-local-runtime";
import { createLocalRuntimeManager, EncryptedLocalRuntimeSecretStore } from "@zhujun/agentloop-local-runtime";
import { DesktopApi, DEFAULT_RUNTIME_ID, type StaticAsset } from "./api/desktop-api.ts";
import { claimInstance } from "./platform/instance-lock.ts";
import { openBrowser } from "./platform/browser.ts";
import { build } from "esbuild";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopOptions {
  readonly mode: "development";
  readonly dataDirectory: string;
  readonly models?: LocalModelProviderPort;
  readonly port?: number;
  readonly openBrowser?: boolean;
  readonly browserLauncher?: (origin: string) => Promise<void>;
  readonly bundledSkillDirectories?: readonly string[];
}
export type DesktopApplication = { existing: true; origin: string; browserOpened: boolean } | {
  existing: false; origin: string; browserOpened: boolean; close(): Promise<void>;
};
async function assets(): Promise<ReadonlyMap<string, StaticAsset>> {
  const entries = await Promise.all([
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/model-settings.js", "model-settings.js", "text/javascript; charset=utf-8"],
    ["/conversation.js", "conversation.js", "text/javascript; charset=utf-8"],
    ["/turn-projection.js", "turn-projection.js", "text/javascript; charset=utf-8"],
    ["/conversation.css", "conversation.css", "text/css; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
    ["/multi-runtime.css", "multi-runtime.css", "text/css; charset=utf-8"],
    ["/assets/xuanwu-mascot-icon.png", "xuanwu-mascot-icon.png", "image/png"],
    ...["presentation/assistant-message-presentation.js", "projections/assistant-event-projection.js", "projections/execution-detail-projection.js", "ui/scroll-follow.js", "ui/composer-input.js", "ui/message-selection.js"].map(file => [`/reference/${file}`, `reference/${file}`, "text/javascript; charset=utf-8"]),
  ].map(async ([route, file, type]) => [route!, { content: await readFile(new URL(`../web/${file}`, import.meta.url)), type: type! }] as const));
  // Bundle the same safe GFM renderer used by Multi Runtime, not raw HTML or
  // another App's code. Private development host; installer prebundling is later.
  const markdown = await build({ stdin: { contents: 'export { renderMarkdown } from "@zhujun/agentloop-artifact-preview";', resolveDir: dirname(fileURLToPath(import.meta.url)), loader: "js" }, bundle: true, write: false, format: "esm", platform: "browser", minify: true, logLevel: "silent" });
  entries.push(["/markdown.js", { content: Buffer.from(markdown.outputFiles![0]!.contents), type: "text/javascript; charset=utf-8" }]);
  entries.push(["/markdown.css", { content: await readFile(fileURLToPath(import.meta.resolve("@zhujun/agentloop-artifact-preview/markdown.css"))), type: "text/css; charset=utf-8" }]);
  return new Map(entries);
}
export async function startDesktop(options: DesktopOptions): Promise<DesktopApplication> {
  if (options.mode !== "development") throw new Error("desktop_production_auth_not_implemented");
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error("desktop_port_invalid");
  const browser = async (origin: string) => {
    if (options.openBrowser === false) return false;
    try { await (options.browserLauncher ?? openBrowser)(origin); return true; }
    catch { return false; } // Keep the ready host usable; CLI prints the local URL.
  };
  const claim = await claimInstance(options.dataDirectory);
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
    api = new DesktopApi(lock.instanceId, await assets());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("desktop_bind_failed");
    api.origin = new URL(`http://127.0.0.1:${address.port}`).origin;
    api.manager = await createLocalRuntimeManager({ dataDirectory: lock.dataDirectory, defaultRuntimeId: DEFAULT_RUNTIME_ID,
      models: options.models, bundledSkillDirectories: options.bundledSkillDirectories,
      modelSecrets: new EncryptedLocalRuntimeSecretStore(join(lock.dataDirectory, "private", "model-secrets")),
      identity: { installationId: async () => lock.installationId } });
    await lock.publish(api.origin);
    const activeApi = api;
    let closed = false; let closing: Promise<void> | undefined;
    return { existing: false, origin: api.origin, browserOpened: await browser(api.origin), close() {
      if (closed) return Promise.resolve(); if (closing) return closing;
      if (activeApi.activeRequests > 0) return Promise.reject(new Error("desktop_requests_prevent_close"));
      activeApi.stopping = true;
      let teardownStarted = false;
      closing = Promise.resolve().then(async () => {
        await activeApi.manager!.close(); teardownStarted = true;
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
    if (api?.manager) await api.manager.close();
    await closeServer(); await lock.release(); throw error;
  }
}
