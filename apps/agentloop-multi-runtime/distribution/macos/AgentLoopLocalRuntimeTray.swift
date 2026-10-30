import AppKit
import Foundation

@main
final class AgentLoopLocalRuntimeTray: NSObject, NSApplicationDelegate {
  private let label = "com.agentloop.local-runtime-agent"
  private var statusItem: NSStatusItem!
  private var agentURL: URL { Bundle.main.resourceURL!.appendingPathComponent("agentloop-local-runtime-agent") }

  static func main() {
    let app = NSApplication.shared
    let delegate = AgentLoopLocalRuntimeTray()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let iconURL = Bundle.main.resourceURL!.appendingPathComponent("xuanwu-mascot-icon.png")
    if let image = NSImage(contentsOf: iconURL) {
      image.size = NSSize(width: 18, height: 18)
      image.isTemplate = false
      statusItem.button?.image = image
      statusItem.button?.imageScaling = .scaleProportionallyDown
      statusItem.button?.toolTip = "玄武 · AgentLoop Local Runtime"
    } else {
      statusItem.button?.title = "AgentLoop"
    }
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Local Runtime Agent", action: nil, keyEquivalent: ""))
    menu.addItem(actionItem(title: "启动或重连", action: #selector(startAgent), keyEquivalent: "r"))
    menu.addItem(actionItem(title: "打开 AgentLoop Web", action: #selector(openWeb), keyEquivalent: "o"))
    menu.addItem(actionItem(title: "查看本地日志", action: #selector(openLogs), keyEquivalent: "l"))
    menu.addItem(.separator())
    menu.addItem(actionItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
    statusItem.menu = menu
    NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:withReplyEvent:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    startAgent()
  }

  private func actionItem(title: String, action: Selector, keyEquivalent: String) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
    // Status-item menus do not reliably resolve actions through the responder
    // chain. Bind every actionable item to this delegate explicitly so a click
    // cannot silently do nothing.
    item.target = self
    return item
  }

  @objc private func handleURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
    guard let raw = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
          let url = URL(string: raw), url.scheme == "agentloop-local-runtime" else { return }
    let values = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let router = values.first(where: { $0.name == "routerUrl" })?.value
    let webOrigin = values.first(where: { $0.name == "webOrigin" })?.value
    if url.host == "configure" || url.host == "start" {
      if let router { configure(router: router, webOrigin: webOrigin) }
      startAgent()
    }
  }

  @objc private func startAgent() {
    do {
      guard FileManager.default.isExecutableFile(atPath: agentURL.path) else {
        throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: agentURL.path])
      }
      let plist = try LocalRuntimeInstallation.launchAgentPath(resources: Bundle.main.resourceURL!, home: FileManager.default.homeDirectoryForCurrentUser, label: label)
      try LocalRuntimeInstallation.restartAgent(plist: plist, label: label, uid: getuid())
      statusItem.button?.title = "AgentLoop ✓"
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
        self?.statusItem.button?.title = "AgentLoop"
      }
    } catch {
      statusItem.button?.title = "AgentLoop !"
      let alert = NSAlert()
      alert.messageText = "Local Runtime Agent 启动失败"
      alert.informativeText = error.localizedDescription
      alert.runModal()
    }
  }

  private func configure(router: String, webOrigin: String?) {
    var arguments = ["--configure-server-url", router]
    if let webOrigin { arguments += ["--web-origin", webOrigin] }
    run(agentURL.path, arguments, allowFailure: false)
  }

  @objc private func openWeb() {
    do {
      NSWorkspace.shared.open(try LocalRuntimeInstallation.webURL(resources: Bundle.main.resourceURL!))
    } catch { statusItem.button?.title = "AgentLoop !" }
  }
  @objc private func openLogs() { NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentLoop Local Runtime/logs")) }
  @objc private func quit() {
    do {
      try LocalRuntimeInstallation.stopAgent(label: label, uid: getuid())
      NSApplication.shared.terminate(nil)
    } catch {
      let alert = NSAlert()
      alert.messageText = "Local Runtime Agent 停止失败"
      alert.informativeText = error.localizedDescription
      alert.runModal()
    }
  }

  private func run(_ executable: String, _ arguments: [String], allowFailure: Bool) {
    let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
    do { try process.run(); process.waitUntilExit() } catch { if !allowFailure { statusItem.button?.title = "AgentLoop !" } }
  }
}
