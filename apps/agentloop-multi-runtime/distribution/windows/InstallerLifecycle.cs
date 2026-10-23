using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AgentLoop.LocalRuntime;

internal static class InstallerLifecycle
{
    internal static void Stop(string installRoot)
    {
        var root = Path.GetFullPath(installRoot);
        // Stop the launcher first so it cannot create another Agent during replacement.
        StopExecutable(Path.Combine(root, "AgentLoop Local Runtime.exe"));
        StopExecutable(Path.Combine(root, "Resources", "agentloop-local-runtime-agent.exe"));
        StopExecutable(Path.Combine(root, "Resources", "agentloop-local-runtime-node.exe"));
    }

    private static void StopExecutable(string executable)
    {
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
        {
            using (process)
            {
                if (process.Id == Environment.ProcessId) continue;
                try
                {
                    // Names alone are insufficient: another checkout or installation
                    // may run an identically named executable. Query with limited rights
                    // so elevated MSI can identify processes in other login sessions.
                    if (process.HasExited) continue;
                    using var handle = OpenProcess(0x1000, false, process.Id);
                    if (handle.IsInvalid)
                    {
                        if (process.HasExited) continue;
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                    var path = new StringBuilder(32768);
                    var length = path.Capacity;
                    if (!QueryFullProcessImageName(handle, 0, path, ref length))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (!StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(path.ToString()), executable)) continue;
                    process.Kill(entireProcessTree: true);
                    if (!process.WaitForExit(10_000))
                        throw new TimeoutException($"Unable to stop {executable} (PID {process.Id}); installation aborted.");
                }
                catch (InvalidOperationException) when (process.HasExited) { }
                catch (Win32Exception) when (process.HasExited) { }
            }
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, StringBuilder name, ref int size);
}
