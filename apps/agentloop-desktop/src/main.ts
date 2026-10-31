import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadDesktopConfig } from "./config.ts";
import { LocalAgentProcess } from "./local-agent-process.ts";
import { openBrowser } from "./browser-launcher.ts";
import { createDesktopServer } from "./server.ts";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = loadDesktopConfig(appRoot);
await mkdir(config.dataRoot, { recursive: true });

const localAgent = new LocalAgentProcess(config);
const server = await createDesktopServer(config);
await localAgent.start();
server.listen(config.port, config.host, () => {
  process.stdout.write("AgentLoop Desktop listening on " + config.webOrigin + "\n");
  if (config.openBrowser) openBrowser(config.webOrigin, config.browserName);
});

const shutdown = async () => {
  server.close();
  await localAgent.stop();
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
