import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import type { DesktopConfig } from "./config.ts";

export class LocalAgentProcess {
  private child: ChildProcess | undefined;

  constructor(private readonly config: DesktopConfig) {}

  async start(): Promise<void> {
    if (!this.config.manageLocalAgent) return;
    await access(this.config.localAgentEntry);
    this.child = spawn(process.execPath, [this.config.localAgentEntry], {
      cwd: this.config.appRoot,
      env: {
        ...process.env,
        LOCAL_AGENT_PORT: new URL(this.config.localAgentUrl).port || "8790",
        LOCAL_AGENT_DATA_ROOT: this.config.dataRoot + "/local-agent",
        WEB_ORIGIN: this.config.webOrigin,
      },
      stdio: "inherit",
    });
    this.child.once("exit", (code, signal) => {
      if (code !== 0 && signal === null) process.stderr.write("Local Agent exited with code " + String(code) + "\n");
    });
    await waitForHealth(this.config.localAgentUrl);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.killed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) return;
      lastError = "HTTP " + String(response.status);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Agent did not become healthy: " + lastError);
}
