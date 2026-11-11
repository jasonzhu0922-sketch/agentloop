import AppKit
import Foundation

@main
final class DesktopTray: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var stateItem: NSMenuItem!
  private var versionItem: NSMenuItem!
  private var sequenceItem: NSMenuItem!
  private var updateMenuItem: NSMenuItem!
  private var updateWindow: DesktopUpdateWindowController!
  private var updateStage = "idle"
  private var updateVersion = ""
  private var updateSequence = 0
  private var updateMode = "module"
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
    if let image = NSImage(contentsOf: resources.appendingPathComponent("status-icon.png")) {
      image.size = NSSize(width: 18, height: 18); image.isTemplate = true; item.button?.image = image
    } else { item.button?.title = "玄武" }
    item.button?.toolTip = config["displayName"] as? String
    let menu = NSMenu()
    stateItem = NSMenuItem(title: "Desktop · 正在启动", action: nil, keyEquivalent: "")
    menu.addItem(stateItem)
    versionItem = NSMenuItem(title: "当前版本 · 获取中", action: nil, keyEquivalent: "")
    menu.addItem(versionItem)
    sequenceItem = NSMenuItem(title: "更新序号 · 获取中", action: nil, keyEquivalent: "")
    menu.addItem(sequenceItem)
    menu.addItem(action("启动本地服务", #selector(startBackend)))
    menu.addItem(action("在 Chrome 中打开", #selector(openChrome)))
    menu.addItem(action("查看日志", #selector(openLogs)))
    updateMenuItem = action("检查更新", #selector(showUpdates)); menu.addItem(updateMenuItem)
    menu.addItem(.separator())
    menu.addItem(action("退出 Desktop", #selector(quit)))
    item.menu = menu
    updateWindow = DesktopUpdateWindowController()
    updateWindow.onCommand = { [weak self] command in self?.sendUpdateCommand(command) }
    startBackend()
  }
  private func action(_ title: String, _ selector: Selector) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: selector, keyEquivalent: ""); entry.target = self; return entry
  }
  @objc private func startBackend() {
    if process?.isRunning == true { return }
    versionItem.title = "当前版本 · 获取中"
    sequenceItem.title = "更新序号 · 获取中"
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
      child.arguments = ["--use-system-ca", resources.appendingPathComponent("module-supervisor.mjs").path]
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
          else { self.stateItem.title = "Desktop · 已停止"; self.versionItem.title = "当前版本 · 未运行"; self.sequenceItem.title = "更新序号 · 未运行" }
        }
      }
      process = child; input = stdin; output = stdout
      try child.run(); stateItem.title = "Desktop · 正在启动"
      DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self, weak child] in
        guard let self, let child, self.process === child, child.isRunning, self.origin == nil else { return }
        child.terminate(); self.alert("本地服务启动超时，请查看日志后重试。")
      }
    } catch { process = nil; stateItem.title = "Desktop · 启动失败"; versionItem.title = "当前版本 · 未运行"; sequenceItem.title = "更新序号 · 未运行"; alert("无法启动随包运行环境，请查看日志或重新安装。") }
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
        origin = url; stateItem.title = "Desktop · 运行中"
        let version = (message["version"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let version, !version.isEmpty { versionItem.title = "当前版本 · \(version)" }
        else { versionItem.title = "当前版本 · 未知" }
        if let sequence = message["updateSequence"] as? Int, sequence > 0 { sequenceItem.title = "更新序号 · \(sequence)" }
        else { sequenceItem.title = "更新序号 · 未知" }
        openChrome()
      case "close-refused":
        quitting = false; NSApplication.shared.reply(toApplicationShouldTerminate: false)
        alert("仍有运行中的任务或请求，请等待完成或取消任务后退出。")
      case "startup-error": alert("本地服务启动失败，请查看日志或检查已有实例。")
      case "update-available":
        updateReleaseDetails(message)
        item.button?.title = " ↑"
        updateUI("available", "发现可用更新", "玄武 \(updateVersion) · 更新序号 \(updateSequence)\n下载期间可以继续使用，安装时间由你决定。", action: "下载更新", command: "download-update")
      case "update-checking": updateUI("checking", "正在检查更新", "正在连接更新服务…")
      case "update-current":
        item.button?.title = ""; updateStage = "idle"
        updateUI("idle", "已是最新版本", "当前版本和更新序号已是最新。", progress: 1, action: "重新检查", command: "check-update")
      case "update-unavailable": updateUI("idle", "更新服务尚未配置", "请使用配置了更新服务的正式安装包。", progress: 0)
      case "update-downloading":
        updateReleaseDetails(message)
        updateUI("downloading", "正在下载更新", "玄武 \(updateVersion) · 更新序号 \(updateSequence)\n下载期间可以继续使用。", progress: 0, cancellable: true)
      case "update-progress":
        let downloaded = (message["downloadedBytes"] as? Double) ?? 0, total = (message["totalBytes"] as? Double) ?? 0
        let completed = (message["completedFiles"] as? Double) ?? 0, files = (message["totalFiles"] as? Double) ?? 0
        let fraction = total > 0 ? downloaded / total : (files > 0 ? completed / files : 0)
        let detail = total > 0 ? "\(Int(min(1, max(0, fraction)) * 100))% · \(ByteCountFormatter.string(fromByteCount: Int64(downloaded), countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file))" : "正在准备更新文件…"
        updateWindow.setProgress(fraction, detail: detail)
        updateMenuItem.title = "正在下载更新 · \(Int(min(1, max(0, fraction)) * 100))%"
      case "update-verifying": updateUI("verifying", "正在校验更新", "下载已完成，正在核对文件完整性…")
      case "update-staged", "update-install-pending":
        updateReleaseDetails(message)
        let native = updateMode == "installer"
        let detail = native ? "此次更新包含菜单栏应用。系统安装器将引导安装及授权，完成后自动重启。" : "重启后应用更新。仍有任务运行时会暂停更新，请先完成或取消任务。"
        updateUI("staged", native ? "应用更新已准备好" : "更新已准备好", "玄武 \(updateVersion) · 更新序号 \(updateSequence)\n\(detail)", progress: 1, action: native ? "打开安装器" : "重启并更新", command: "apply-update", reveal: true)
      case "update-restarting": updateUI("restarting", "正在重启玄武", "正在安全关闭本地服务，稍后将自动打开…", reveal: true)
      case "update-installing": updateUI("installing", "请在系统安装器中完成更新", "玄武 \(updateVersion) · 更新序号 \(updateSequence)\n安装器将显示进度并引导授权。请先完成或取消运行中的任务；安装后玄武会自动重新启动。", action: "重新打开安装器", command: "apply-update", reveal: true)
      case "update-cancelled": updateUI("cancelled", "下载已取消", "当前版本继续运行，可以随时重新下载。", progress: 0, action: "重新下载", command: "download-update")
      case "update-busy": updateUI("staged", "任务仍在运行，更新已暂停", "请先等待任务完成或取消任务，再重试更新。", progress: 1, action: "重试更新", command: "apply-update", reveal: true)
      case "update-error":
        let phase = message["phase"] as? String ?? "download"
        let command = phase == "download" ? "download-update" : "check-update"
        updateUI("error", "更新未完成", phase == "install" ? "安装器未能打开或安装文件校验失败。当前版本仍可使用，请重新检查更新后再试。" : "连接或文件校验失败，当前版本继续运行。请检查网络后重试。", progress: 0, action: "重试", command: command, reveal: true)
      case "update-installed":
        updateReleaseDetails(message); item.button?.title = ""
        updateUI("idle", "更新完成", "玄武 \(updateVersion) · 更新序号 \(updateSequence)\n新版本已启动，可以继续使用。", progress: 1, action: "检查更新", command: "check-update", reveal: true)
      case "update-rolled-back": updateUI("error", "新版本启动失败，正在恢复", "正在重新启动之前的版本，下载的更新仍会保留。", action: "重试更新", command: "apply-update", reveal: true)
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
  private func updateReleaseDetails(_ message: [String: Any]) {
    if let version = message["version"] as? String { updateVersion = version }
    if let sequence = message["sequence"] as? Int { updateSequence = sequence }
    if let mode = message["mode"] as? String { updateMode = mode }
  }
  private func updateUI(_ stage: String, _ title: String, _ detail: String, progress: Double? = nil, action: String? = nil, command: String? = nil, cancellable: Bool = false, reveal: Bool = false) {
    updateStage = stage
    updateMenuItem.title = stage == "idle" ? "检查更新" : title
    item.button?.toolTip = "玄武 · \(title)"
    updateWindow.render(title: title, detail: detail, progress: progress, action: action, command: command, cancellable: cancellable)
    if reveal { updateWindow.present(activate: false) }
  }
  @objc private func showUpdates() {
    updateWindow.present(activate: true)
    if updateStage == "idle" { sendUpdateCommand("check-update") }
  }
  private func sendUpdateCommand(_ command: String) {
    guard process?.isRunning == true else { alert("请先启动本地服务。"); return }
    input?.fileHandleForWriting.write(Data("\(command)\n".utf8))
  }
  @objc private func quit() { NSApplication.shared.terminate(nil) }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard process?.isRunning == true else { return .terminateNow }
    if !quitting { quitting = true; input?.fileHandleForWriting.write(Data("close\n".utf8)) }
    return .terminateLater
  }
  private func alert(_ message: String) { let alert = NSAlert(); alert.messageText = config["displayName"] as? String ?? "玄武"; alert.informativeText = message; alert.runModal() }
}

/// A persistent modeless window: closing it never stops a download or a running task.
final class DesktopUpdateWindowController: NSWindowController {
  var onCommand: ((String) -> Void)?
  private let heading = NSTextField(labelWithString: "玄武更新")
  private let explanation = NSTextField(wrappingLabelWithString: "正在准备检查更新…")
  private let progress = NSProgressIndicator()
  private let detail = NSTextField(labelWithString: "")
  private let primary = NSButton(title: "检查更新", target: nil, action: nil)
  private let secondary = NSButton(title: "稍后", target: nil, action: nil)
  private var command: String? = "check-update"
  private var cancellable = false

  init() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 260), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "玄武更新"; window.isReleasedWhenClosed = false
    super.init(window: window)
    heading.font = .systemFont(ofSize: 21, weight: .semibold)
    explanation.font = .systemFont(ofSize: 13); explanation.textColor = .secondaryLabelColor
    explanation.preferredMaxLayoutWidth = 424
    progress.style = .bar; progress.minValue = 0; progress.maxValue = 1
    progress.identifier = NSUserInterfaceItemIdentifier("desktop-update-progress")
    detail.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular); detail.textColor = .secondaryLabelColor
    primary.target = self; primary.action = #selector(performPrimary); primary.bezelStyle = .rounded; primary.keyEquivalent = "\r"
    secondary.target = self; secondary.action = #selector(performSecondary); secondary.bezelStyle = .rounded
    let buttons = NSStackView(views: [secondary, primary]); buttons.orientation = .horizontal; buttons.spacing = 10
    let content = NSStackView(views: [heading, explanation, progress, detail, buttons])
    content.orientation = .vertical; content.alignment = .leading; content.spacing = 15
    content.translatesAutoresizingMaskIntoConstraints = false
    window.contentView!.addSubview(content)
    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
      content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
      content.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
      content.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor, constant: -20),
      progress.widthAnchor.constraint(equalTo: content.widthAnchor),
    ])
    window.center()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  func present(activate: Bool) {
    showWindow(nil)
    if activate { NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil) }
    else { window?.orderFront(nil) }
  }
  func render(title: String, detail: String, progress value: Double?, action: String?, command: String?, cancellable: Bool) {
    heading.stringValue = title; explanation.stringValue = detail
    self.command = command; self.cancellable = cancellable
    primary.title = action ?? ""; primary.isHidden = action == nil; primary.isEnabled = true
    secondary.title = cancellable ? "取消下载" : "稍后"; secondary.isEnabled = true
    progress.isIndeterminate = value == nil
    if let value { progress.stopAnimation(nil); progress.doubleValue = min(1, max(0, value)); self.detail.stringValue = "" }
    else { progress.startAnimation(nil); self.detail.stringValue = "请稍候…" }
  }
  func setProgress(_ value: Double, detail: String) {
    progress.isIndeterminate = false; progress.stopAnimation(nil); progress.doubleValue = min(1, max(0, value)); self.detail.stringValue = detail
  }
  @objc private func performPrimary() { guard let command else { return }; onCommand?(command) }
  @objc private func performSecondary() {
    if cancellable { secondary.isEnabled = false; onCommand?("cancel-update-download") }
    else { window?.orderOut(nil) }
  }
}
