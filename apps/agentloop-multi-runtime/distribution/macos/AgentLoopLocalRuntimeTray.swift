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
    statusItem.button?.title = "AgentLoop"
    let menu = NSMenu()
    menu.addItem(NSMenuItem(title: "Local Runtime Agent", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem(title: "启动或重连", action: #selector(startAgent), keyEquivalent: "r"))
    menu.addItem(NSMenuItem(title: "打开 AgentLoop Web", action: #selector(openWeb), keyEquivalent: "o"))
    menu.addItem(NSMenuItem(title: "查看本地日志", action: #selector(openLogs), keyEquivalent: "l"))
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
    statusItem.menu = menu
    NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:withReplyEvent:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    startAgent()
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
    let plist = launchAgentPath()
    let uid = getuid()
    run("/bin/launchctl", ["bootstrap", "gui/\(uid)", plist.path], allowFailure: true)
    run("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(label)"], allowFailure: true)
  }

  private func configure(router: String, webOrigin: String?) {
    var arguments = ["--configure-server-url", router]
    if let webOrigin { arguments += ["--web-origin", webOrigin] }
    run(agentURL.path, arguments, allowFailure: false)
  }

  private func launchAgentPath() -> URL {
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let target = directory.appendingPathComponent("\(label).plist")
    let source = Bundle.main.resourceURL!.appendingPathComponent("\(label).plist")
    if !FileManager.default.fileExists(atPath: target.path) { try? FileManager.default.copyItem(at: source, to: target) }
    return target
  }

  @objc private func openWeb() { NSWorkspace.shared.open(URL(string: "https://agentloop.local")!) }
  @objc private func openLogs() { NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentLoop Local Runtime/logs")) }
  @objc private func quit() { NSApplication.shared.terminate(nil) }

  private func run(_ executable: String, _ arguments: [String], allowFailure: Bool) {
    let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
    do { try process.run(); process.waitUntilExit() } catch { if !allowFailure { statusItem.button?.title = "AgentLoop !" } }
  }
}
