import AppKit
import WebKit

final class AgentLoopApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var server: Process?
    private var logHandle: FileHandle?
    private var attempts = 0
    private var port = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try startServer()
            waitForServer()
        } catch {
            showStartupError(error.localizedDescription)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let server, server.isRunning {
            server.terminate()
            server.waitUntilExit()
        }
        try? logHandle?.close()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func startServer() throws {
        let resources = Bundle.main.resourceURL!
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AgentLoop", isDirectory: true)
        let config = support.appendingPathComponent("config", isDirectory: true)
        let workspace = support.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)

        let providers = config.appendingPathComponent("llm-providers.json")
        if !FileManager.default.fileExists(atPath: providers.path) {
            try FileManager.default.copyItem(
                at: resources.appendingPathComponent("llm-providers.example.json"), to: providers)
        }
        let envFile = support.appendingPathComponent(".env")
        if !FileManager.default.fileExists(atPath: envFile.path) {
            try "MY_LLM_API_KEY=\nOPENAI_API_KEY=\n".write(to: envFile, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: envFile.path)
        }

        let logURL = support.appendingPathComponent("agentloop.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        logHandle = try FileHandle(forWritingTo: logURL)
        try logHandle?.seekToEnd()

        port = Int.random(in: 20000...50000)
        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = ["--env-file-if-exists=\(envFile.path)", "src/main.ts"]
        process.currentDirectoryURL = resources.appendingPathComponent("server", isDirectory: true)
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(port)
        environment["HOST"] = "127.0.0.1"
        environment["DATABASE_PATH"] = support.appendingPathComponent("agentloop.db").path
        environment["WORKSPACE_ROOT"] = workspace.path
        environment["LLM_PROVIDER_CONFIG_PATH"] = providers.path
        environment["AGENTLOOP_WEB_DIST"] = resources.appendingPathComponent("web", isDirectory: true).path
        environment["WEB_ORIGINS_JSON"] = "[]"
        environment["CUSTOM_SKILL_DIRECTORIES_JSON"] = "[]"
        process.environment = environment
        process.standardOutput = logHandle
        process.standardError = logHandle
        try process.run()
        server = process
    }

    private func waitForServer() {
        guard let server, server.isRunning else {
            showStartupError("本地服务已退出。请查看 ~/Library/Application Support/AgentLoop/agentloop.log")
            return
        }
        guard attempts < 100 else {
            showStartupError("本地服务启动超时。请查看 ~/Library/Application Support/AgentLoop/agentloop.log")
            return
        }
        attempts += 1
        let url = URL(string: "http://127.0.0.1:\(port)/healthz")!
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.showWindow()
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForServer() }
                }
            }
        }.resume()
    }

    private func showWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "AgentLoop"
        window.center()
        let web = WKWebView(frame: window.contentView!.bounds)
        web.autoresizingMask = [.width, .height]
        window.contentView = web
        web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    private func showStartupError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "AgentLoop 无法启动"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AgentLoopApp()
app.delegate = delegate
app.run()
