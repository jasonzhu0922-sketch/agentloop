import { spawn } from "node:child_process";
import { loopbackOrigin } from "./instance-lock.ts";

/** No shell interpolation, profile flags or access-bearing launch URL. */
export async function openBrowser(origin: string): Promise<void> {
  loopbackOrigin(origin);
  const command = process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", `${origin}/`] : [`${origin}/`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true, shell: false });
    const timeout = setTimeout(() => { child.unref(); reject(new Error("desktop_browser_launch_timeout")); }, 5_000);
    timeout.unref();
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error("desktop_browser_launch_failed")); });
  });
}
