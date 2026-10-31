import { spawn } from "node:child_process";
import { platform } from "node:os";

export function openBrowser(url: string, browserName: string): void {
  if (platform() === "darwin") {
    spawn("open", ["-a", browserName, url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (platform() === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const command = process.env.AGENTLOOP_DESKTOP_BROWSER_COMMAND ?? "google-chrome";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}
