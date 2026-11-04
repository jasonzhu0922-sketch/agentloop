import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

export async function pickNativeDirectory(): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execute("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "选择 AgentLoop 存储目录")']);
      return stdout.trim() || undefined;
    }
    if (process.platform === "win32") {
      const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择 AgentLoop 存储目录'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
      return stdout.trim() || undefined;
    }
    throw new Error("directory_picker_unavailable");
  } catch (error) {
    if (process.platform === "darwin" && /(-128|User canceled)/i.test(String((error as { stderr?: string }).stderr))) return undefined;
    throw new Error("directory_picker_unavailable");
  }
}
