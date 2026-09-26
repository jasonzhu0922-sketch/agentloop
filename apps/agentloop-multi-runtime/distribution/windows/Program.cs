using System.Diagnostics;
using System.Text.Json;
using Microsoft.Win32;

namespace AgentLoop.LocalRuntime;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        using var singleton = new Mutex(true, "Global\\AgentLoop.LocalRuntime.Tray", out var isFirstInstance);
        if (!isFirstInstance) return;
        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext(args));
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
            Directory.CreateDirectory(logRoot);
            Process.Start(new ProcessStartInfo
            {
                FileName = agentCommand,
                WorkingDirectory = resourceRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            icon.Text = "AgentLoop Local Runtime";
        }
        catch
        {
            icon.Text = "AgentLoop Local Runtime - 未能启动";
        }
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
        icon.Visible = false;
        icon.Dispose();
        base.ExitThreadCore();
    }
}
