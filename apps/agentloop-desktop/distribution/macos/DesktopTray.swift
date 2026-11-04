import AppKit
import Foundation

@main
final class DesktopTray: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var stateItem: NSMenuItem!
  private var process: Process?
  private var input: Pipe?
  private var output: Pipe?
  private var log: FileHandle?
  private var buffer = Data()
  private var origin: URL?
  private var quitting = false
  private var config: [String: Any] = [:]
  private var resources: URL { Bundle.main.resourceURL! }
  private var dataRoot: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support").appendingPathComponent(config["dataDirectoryName"] as! String) }

  static func main() {
    let app = NSApplication.shared
    let delegate = DesktopTray()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      config = try JSONSerialization.jsonObject(with: Data(contentsOf: resources.appendingPathComponent("desktop-config.json"))) as! [String: Any]
      guard config["dataDirectoryName"] is String else { throw CocoaError(.fileReadCorruptFile) }
    } catch { alert("应用配置损坏，请重新安装。"); NSApplication.shared.terminate(nil); return }
    // LaunchServices normally reuses an existing .app. Also guard direct executable launches.
    if let id = Bundle.main.bundleIdentifier, NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) { NSApplication.shared.terminate(nil); return }
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let image = NSImage(contentsOf: resources.appendingPathComponent("icon.png")) {
      image.size = NSSize(width: 18, height: 18); item.button?.image = image
    } else { item.button?.title = "AgentLoop" }
    item.button?.toolTip = config["productName"] as? String
    let menu = NSMenu()
    stateItem = NSMenuItem(title: "Desktop · 正在启动", action: nil, keyEquivalent: "")
    menu.addItem(stateItem)
    menu.addItem(action("启动本地服务", #selector(startBackend)))
    menu.addItem(action("在 Chrome 中打开", #selector(openChrome)))
    menu.addItem(action("查看日志", #selector(openLogs)))
    menu.addItem(.separator())
    menu.addItem(action("退出 Desktop", #selector(quit)))
    item.menu = menu
    startBackend()
  }
  private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: selector, keyEquivalent: ""); entry.target = self; return entry
  }
  @objc private func startBackend() {
    if process?.isRunning == true { return }
    do {
      let logs = dataRoot.appendingPathComponent("logs")
      try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
      let logURL = logs.appendingPathComponent("backend.log")
      if let size = try? logURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 5 * 1024 * 1024 {
        let previous = logs.appendingPathComponent("backend.previous.log")
        if FileManager.default.fileExists(atPath: previous.path) { try FileManager.default.removeItem(at: previous) }
        try FileManager.default.moveItem(at: logURL, to: previous)
      }
      if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
      log = try FileHandle(forWritingTo: logURL); try log?.seekToEnd()
      let child = Process(), stdin = Pipe(), stdout = Pipe()
      var environment = ProcessInfo.processInfo.environment
      environment.removeValue(forKey: "NODE_OPTIONS"); environment.removeValue(forKey: "NODE_PATH")
      // Match the Local Agent's macOS trust configuration while respecting a managed CA bundle.
      if (environment["NODE_EXTRA_CA_CERTS"] ?? "").isEmpty && FileManager.default.isReadableFile(atPath: "/etc/ssl/cert.pem") {
        environment["NODE_EXTRA_CA_CERTS"] = "/etc/ssl/cert.pem"
      }
      environment["AGENTLOOP_DESKTOP_DATA_DIR"] = dataRoot.appendingPathComponent("runtime-data").path
      child.executableURL = resources.appendingPathComponent("runtime/bin/node")
      child.arguments = ["--use-system-ca", resources.appendingPathComponent("backend.mjs").path]
      child.currentDirectoryURL = resources; child.environment = environment
      child.standardInput = stdin; child.standardOutput = stdout; child.standardError = log
      buffer = Data(); origin = nil; quitting = false
      stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
        let data = handle.availableData
        if data.isEmpty { handle.readabilityHandler = nil; return }
        DispatchQueue.main.async { self?.receive(data) }
      }
      child.terminationHandler = { [weak self] _ in
        DispatchQueue.main.async {
          guard let self else { return }
          self.output?.fileHandleForReading.readabilityHandler = nil
          self.process = nil; self.origin = nil; try? self.log?.close(); self.log = nil
          if self.quitting { NSApplication.shared.reply(toApplicationShouldTerminate: true) }
          else { self.stateItem.title = "Desktop · 已停止" }
        }
      }
      process = child; input = stdin; output = stdout
      try child.run(); stateItem.title = "Desktop · 正在启动"
      DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self, weak child] in
        guard let self, let child, self.process === child, child.isRunning, self.origin == nil else { return }
        child.terminate(); self.alert("本地服务启动超时，请查看日志后重试。")
      }
    } catch { process = nil; stateItem.title = "Desktop · 启动失败"; alert("无法启动随包运行环境，请查看日志或重新安装。") }
  }
  private func receive(_ data: Data) {
    buffer.append(data)
    while let newline = buffer.firstIndex(of: 10) {
      let line = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
      guard let text = String(data: line, encoding: .utf8), text.hasPrefix("AGENTLOOP_DESKTOP:"),
        let json = text.dropFirst("AGENTLOOP_DESKTOP:".count).data(using: .utf8),
        let message = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else { continue }
      switch message["type"] as? String {
      case "ready":
        guard let value = message["origin"] as? String, let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1", url.port != nil else { continue }
        origin = url; stateItem.title = "Desktop · 运行中"; openChrome()
      case "close-refused":
        quitting = false; NSApplication.shared.reply(toApplicationShouldTerminate: false)
        alert("仍有运行中的任务或请求，请等待完成或取消任务后退出。")
      case "startup-error": alert("本地服务启动失败，请查看日志或检查已有实例。")
      default: break
      }
    }
    if buffer.count > 1_048_576 { buffer.removeAll() }
  }
  @objc private func openChrome() {
    guard let url = origin else { alert("本地服务尚未就绪，请先启动服务。"); return }
    guard let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else { alert("请安装 Google Chrome 后再打开 Desktop 界面。"); return }
    NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration()) { _, error in
      if error != nil { DispatchQueue.main.async { self.alert("Chrome 打开失败，请检查浏览器安装。") } }
    }
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openChrome(); return false }
  @objc private func openLogs() { NSWorkspace.shared.open(dataRoot.appendingPathComponent("logs")) }
  @objc private func quit() { NSApplication.shared.terminate(nil) }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard process?.isRunning == true else { return .terminateNow }
    if !quitting { quitting = true; input?.fileHandleForWriting.write(Data("close\n".utf8)) }
    return .terminateLater
  }
  private func alert(_ message: String) { let alert = NSAlert(); alert.messageText = "AgentLoop Desktop"; alert.informativeText = message; alert.runModal() }
}
