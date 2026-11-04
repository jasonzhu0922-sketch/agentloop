using System.Diagnostics;
using System.Text.Json;
using System.Collections.Concurrent;
using Microsoft.Win32;

namespace AgentLoop.Desktop;
internal static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        try
        {
            var root = Path.Combine(AppContext.BaseDirectory, "Resources");
            using var config = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "desktop-config.json")));
            var name = config.RootElement.GetProperty("dataDirectoryName").GetString()!;
            using var singleton = new Mutex(true, @"Local\" + config.RootElement.GetProperty("appId").GetString(), out var first);
            if (!first) { MessageBox.Show("Desktop 已在系统托盘运行。", "AgentLoop Desktop"); return; }
            Application.Run(new TrayContext(root, name));
        }
        catch { MessageBox.Show("Desktop 启动失败，请检查应用配置或重新解压安装包。", "AgentLoop Desktop"); }
    }
}
internal sealed class TrayContext : ApplicationContext
{
    readonly string root, dataRoot, logRoot;
    readonly NotifyIcon icon;
    readonly ToolStripMenuItem state = new("Desktop · 正在启动") { Enabled = false };
    readonly System.Windows.Forms.Timer timer = new() { Interval = 150 };
    readonly ConcurrentQueue<string> messages = new();
    Process? child;
    StreamWriter? log;
    string? origin;
    bool closing;
    DateTime started;
    internal TrayContext(string root, string name)
    {
        this.root = root;
        dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), name);
        logRoot = Path.Combine(dataRoot, "logs");
        var menu = new ContextMenuStrip(); menu.Items.Add(state);
        menu.Items.Add("启动本地服务", null, (_, _) => Start());
        menu.Items.Add("在 Chrome 中打开", null, (_, _) => OpenChrome());
        menu.Items.Add("查看日志", null, (_, _) => Process.Start(new ProcessStartInfo(logRoot) { UseShellExecute = true }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 Desktop", null, (_, _) => Close());
        icon = new NotifyIcon { Text = name, Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application, Visible = true, ContextMenuStrip = menu };
        icon.DoubleClick += (_, _) => OpenChrome();
        timer.Tick += (_, _) => Poll(); timer.Start(); Start();
    }
    void Start()
    {
        if (child is { HasExited: false }) return;
        try
        {
            child?.Dispose(); child = null;
            Directory.CreateDirectory(logRoot);
            var logPath = Path.Combine(logRoot, "backend.log");
            if (File.Exists(logPath) && new FileInfo(logPath).Length > 5 * 1024 * 1024) File.Move(logPath, logPath + ".previous", true);
            log = new StreamWriter(logPath, true) { AutoFlush = true };
            var info = new ProcessStartInfo(Path.Combine(root, "runtime", "bin", "node.exe")) {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            info.ArgumentList.Add(Path.Combine(root, "backend.mjs"));
            info.Environment.Remove("NODE_OPTIONS"); info.Environment.Remove("NODE_PATH");
            info.Environment["AGENTLOOP_DESKTOP_DATA_DIR"] = Path.Combine(dataRoot, "runtime-data");
            child = new Process { StartInfo = info };
            child.OutputDataReceived += (_, e) => { if (e.Data != null) messages.Enqueue(e.Data); };
            child.ErrorDataReceived += (_, e) => { if (e.Data != null) { lock (messages) { log?.WriteLine(e.Data); } } };
            child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
            origin = null; closing = false; started = DateTime.UtcNow; state.Text = "Desktop · 正在启动";
        }
        catch { state.Text = "Desktop · 启动失败"; MessageBox.Show("无法启动随包 Node，请查看日志或重新解压安装包。", "AgentLoop Desktop"); }
    }
    void Poll()
    {
        while (messages.TryDequeue(out var line))
        {
            if (!line.StartsWith("AGENTLOOP_DESKTOP:")) continue;
            try
            {
                using var message = JsonDocument.Parse(line["AGENTLOOP_DESKTOP:".Length..]);
                switch (message.RootElement.GetProperty("type").GetString())
                {
                    case "ready":
                        var value = message.RootElement.GetProperty("origin").GetString();
                        if (Uri.TryCreate(value, UriKind.Absolute, out var url) && url.Scheme == "http" && url.Host == "127.0.0.1") { origin = value; state.Text = "Desktop · 运行中"; OpenChrome(); }
                        break;
                    case "close-refused": closing = false; MessageBox.Show("仍有运行中的任务或请求，请等待完成或取消任务后退出。", "AgentLoop Desktop"); break;
                    case "startup-error": MessageBox.Show("本地服务启动失败，请查看日志或检查已有实例。", "AgentLoop Desktop"); break;
                }
            }
            catch { state.Text = "Desktop · 状态读取失败"; }
        }
        if (child is { HasExited: true })
        {
            child.WaitForExit(); child.Dispose(); child = null; origin = null;
            lock (messages) { log?.Dispose(); log = null; }
            if (closing) ExitThread(); else state.Text = "Desktop · 已停止";
        }
        else if (child != null && origin == null && DateTime.UtcNow - started > TimeSpan.FromSeconds(45)) { child.Kill(true); state.Text = "Desktop · 启动超时"; }
    }
    void OpenChrome()
    {
        if (origin == null) { MessageBox.Show("本地服务尚未就绪，请先启动服务。", "AgentLoop Desktop"); return; }
        var candidates = new List<string>();
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var key = hive.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe");
            if (key?.GetValue(null) is string path) candidates.Add(path);
        }
        foreach (var folder in new[] { Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 }) candidates.Add(Path.Combine(Environment.GetFolderPath(folder), "Google", "Chrome", "Application", "chrome.exe"));
        var chrome = candidates.FirstOrDefault(File.Exists);
        if (chrome == null) { MessageBox.Show("请安装 Google Chrome 后再打开 Desktop 界面。", "AgentLoop Desktop"); return; }
        try { var start = new ProcessStartInfo(chrome) { UseShellExecute = false }; start.ArgumentList.Add(origin); Process.Start(start); }
        catch { MessageBox.Show("Chrome 打开失败，请检查浏览器安装。", "AgentLoop Desktop"); }
    }
    void Close()
    {
        if (child == null || child.HasExited) { ExitThread(); return; }
        if (closing) return;
        closing = true;
        try { child.StandardInput.WriteLine("close"); child.StandardInput.Flush(); }
        catch { closing = false; MessageBox.Show("关闭请求发送失败，请查看本地日志。", "AgentLoop Desktop"); }
    }
    protected override void ExitThreadCore()
    {
        timer.Stop(); timer.Dispose(); icon.Visible = false; icon.Dispose();
        child?.StandardInput.Close(); log?.Dispose(); base.ExitThreadCore();
    }
}
