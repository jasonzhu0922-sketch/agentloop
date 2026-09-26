import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Opens the operating system's native directory chooser on the user's device. */
export async function pickNativeDirectory(platform = process.platform): Promise<string | undefined> {
  try {
    if (platform === "darwin") {
      const { stdout } = await execute("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "选择授权给 AgentLoop 的目录")',
      ], { encoding: "utf8" });
      return normalized(stdout);
    }
    if (platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$dialog.Description = '选择授权给 AgentLoop 的目录'",
        "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }",
      ].join("; ");
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { encoding: "utf8" });
      return normalized(stdout);
    }
    const { stdout } = await execute("zenity", ["--file-selection", "--directory", "--title=选择授权给 AgentLoop 的目录"], { encoding: "utf8" });
    return normalized(stdout);
  } catch (error) {
    const code = (error as { readonly code?: string | number }).code;
    // Native dialogs use a non-zero exit when the user cancels.
    if (code === 1 || code === "1" || code === -128 || code === "-128") return undefined;
    throw new Error(`native_directory_picker_unavailable:${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalized(value: string): string | undefined {
  const path = value.trim().replace(/[\\/]$/, "");
  return path.length === 0 ? undefined : path;
}
