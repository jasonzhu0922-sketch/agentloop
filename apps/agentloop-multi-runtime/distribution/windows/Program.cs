using System.Diagnostics;
using System.Text.Json;
using Microsoft.Win32;

namespace AgentLoop.LocalRuntime;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // MSI runs its embedded copy before touching installed files, including
        // when the installed tray predates the shutdown protocol.
        if (args.Length == 2 && args[0] == "--stop-for-install")
        {
            try { InstallerLifecycle.Stop(args[1]); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        using var singleton = new Mutex(true, "Global\\AgentLoop.LocalRuntime.Tray", out var isFirstInstance);
        if (!isFirstInstance) return 0;
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext(args));
        return 0;
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private const string StartupRegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string StartupValueName = "AgentLoop Local Runtime";
    private readonly NotifyIcon icon;
    private readonly string installRoot = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private readonly string resourceRoot;
    private readonly string agentCommand;
    private readonly string logRoot;
    private readonly string webOrigin;
    private Process? agentProcess;

    internal TrayContext(string[] args)
    {
        resourceRoot = Path.Combine(installRoot, "Resources");
        agentCommand = Path.Combine(resourceRoot, "agentloop-local-runtime-agent.cmd");
        logRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentLoop Local Runtime", "logs");
        webOrigin = LoadWebOrigin();
        EnsureStartup();
        icon = new NotifyIcon
        {
            Text = "AgentLoop Local Runtime",
            Icon = SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        StartAgent();
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Local Runtime Agent").Enabled = false;
        menu.Items.Add("启动或重连", null, (_, _) => StartAgent());
        menu.Items.Add("打开 AgentLoop Web", null, (_, _) => Open(webOrigin));
        menu.Items.Add("查看本地日志", null, (_, _) => Open(logRoot));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出托盘", null, (_, _) => ExitThread());
        return menu;
    }

    private void StartAgent()
    {
        try
        {
            if (agentProcess is { HasExited: false }) return;
            agentProcess?.Dispose();
            agentProcess = null;
            Directory.CreateDirectory(logRoot);
            var process = Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                Arguments = $"/d /s /c \"\"{agentCommand}\"\"",
                WorkingDirectory = resourceRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (process is null) throw new InvalidOperationException("Local Runtime Agent did not start");
            agentProcess = process;
            icon.Text = "AgentLoop Local Runtime";
        }
        catch
        {
            icon.Text = "AgentLoop Local Runtime - 未能启动";
        }
    }

    private void StopAgent()
    {
        var process = agentProcess;
        agentProcess = null;
        if (process is null) return;
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            process.WaitForExit(5_000);
        }
        catch { }
        finally { process.Dispose(); }
    }

    private void EnsureStartup()
    {
        using var key = Registry.CurrentUser.CreateSubKey(StartupRegistryKey);
        key?.SetValue(StartupValueName, $"\"{Environment.ProcessPath}\"", RegistryValueKind.String);
    }

    private string LoadWebOrigin()
    {
        try
        {
            var manifest = Path.Combine(resourceRoot, "agentloop-local-runtime.manifest.json");
            using var document = JsonDocument.Parse(File.ReadAllText(manifest));
            if (document.RootElement.TryGetProperty("webOrigin", out var value) && Uri.TryCreate(value.GetString(), UriKind.Absolute, out var url)) return url.ToString();
        }
        catch { }
        return "https://agentloop.local/";
    }

    private static void Open(string pathOrUrl)
    {
        Process.Start(new ProcessStartInfo { FileName = pathOrUrl, UseShellExecute = true });
    }

    protected override void ExitThreadCore()
    {
        StopAgent();
        icon.Visible = false;
        icon.Dispose();
        base.ExitThreadCore();
    }
}
