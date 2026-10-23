using System.Diagnostics;
using AgentLoop.LocalRuntime;

if (args.Length > 0 && args[0] == "--worker")
{
    Thread.Sleep(Timeout.Infinite);
    return;
}

var temporary = Path.Combine(Path.GetTempPath(), "agentloop-upgrade-" + Guid.NewGuid());
var install = Path.Combine(temporary, "Program Files", "AgentLoop Local Runtime");
var other = Path.Combine(temporary, "other-installation");
var data = Path.Combine(temporary, "LocalAppData", "AgentLoop Local Runtime");
Directory.CreateDirectory(data);
var processes = new List<Process>();
try
{
    foreach (var name in new[] { "agentloop.db", "device-identity.json", "model-secrets.bin", "mcp-secrets.bin", "runtime-definitions.json" })
        File.WriteAllText(Path.Combine(data, name), "preserved-" + name);
    Process Worker(string directory, string name)
    {
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, name);
        File.Copy(Environment.ProcessPath!, executable);
        var process = Process.Start(new ProcessStartInfo(executable) { UseShellExecute = false, ArgumentList = { "--worker" } })!;
        processes.Add(process);
        return process;
    }
    // Simulate a legacy tray and orphan SEA/Node Agents without any tray shutdown hook.
    var tray = Worker(install, "AgentLoop Local Runtime.exe");
    var sea = Worker(Path.Combine(install, "Resources"), "agentloop-local-runtime-agent.exe");
    var node = Worker(Path.Combine(install, "Resources"), "agentloop-local-runtime-node.exe");
    var unrelated = Worker(other, "agentloop-local-runtime-node.exe");
    Thread.Sleep(500);
    foreach (var process in processes)
        if (process.HasExited) throw new Exception("Process fixture failed to start");
    InstallerLifecycle.Stop(install);
    foreach (var process in new[] { tray, sea, node })
        if (!process.WaitForExit(10_000)) throw new Exception("Old process survived replacement");
    if (unrelated.HasExited) throw new Exception("Another installation was stopped");
    InstallerLifecycle.Stop(install); // First install / repeated cleanup must succeed too.
    // Stopped executables can be replaced, while device data stays byte-for-byte intact.
    File.WriteAllText(Path.Combine(install, "AgentLoop Local Runtime.exe"), "new version");
    foreach (var file in Directory.GetFiles(data))
        if (File.ReadAllText(file) != "preserved-" + Path.GetFileName(file)) throw new Exception("Device state changed");
    Console.WriteLine("Legacy/orphan process shutdown, path isolation, and data preservation passed.");
}
finally
{
    foreach (var process in processes)
    {
        if (!process.HasExited) { process.Kill(true); process.WaitForExit(); }
        process.Dispose();
    }
    Directory.Delete(temporary, true);
}
