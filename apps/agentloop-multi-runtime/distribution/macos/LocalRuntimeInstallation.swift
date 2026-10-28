import Foundation

enum LocalRuntimeInstallation {
  static func webURL(resources: URL) throws -> URL {
    let manifest = resources.appendingPathComponent("agentloop-local-runtime.manifest.json")
    let release = try JSONDecoder().decode(Release.self, from: Data(contentsOf: manifest))
    guard let url = URL(string: release.webOrigin), ["http", "https"].contains(url.scheme), url.host != nil else { throw URLError(.badURL) }
    return url
  }

  static func launchAgentPath(resources: URL, home: URL, label: String) throws -> URL {
    let directory = home.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    let logs = home.appendingPathComponent("Library/Application Support/AgentLoop Local Runtime/logs", isDirectory: true)
    let target = directory.appendingPathComponent("\(label).plist")
    let source = resources.appendingPathComponent("\(label).plist")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    guard var plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: source), format: nil) as? [String: Any] else { throw CocoaError(.propertyListReadCorrupt) }
    let executable = resources.appendingPathComponent("agentloop-local-runtime-launcher").path
    plist["ProgramArguments"] = [executable]
    // A previous job definition may contain Program as well as ProgramArguments.
    plist.removeValue(forKey: "Program")
    var environment = plist["EnvironmentVariables"] as? [String: String] ?? [:]
    environment["AGENTLOOP_AGENT_APP_ROOT"] = resources.path
    environment["AGENTLOOP_BUNDLED_SKILL_DIRECTORIES"] = resources.appendingPathComponent("skills").path
    plist["EnvironmentVariables"] = environment
    plist["StandardOutPath"] = logs.appendingPathComponent("agent.out.log").path
    plist["StandardErrorPath"] = logs.appendingPathComponent("agent.err.log").path
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: target, options: .atomic)
    return target
  }

  static func restartAgent(plist: URL, label: String, uid: UInt32, launchctl: URL = URL(fileURLWithPath: "/bin/launchctl")) throws {
    let domain = "gui/\(uid)"
    let service = "\(domain)/\(label)"
    // The installed Local Runtime is one long-lived per-user service. Reusing
    // the loaded job avoids tearing down and re-registering launchd on every
    // browser-triggered start/reconnect, which is where macOS commonly returns
    // the opaque "Bootstrap failed: 5" error.
    if try command(launchctl, ["print", service]).status == 0 {
      try checkedCommand(launchctl, ["kickstart", "-k", service])
      return
    }
    try checkedCommand(launchctl, ["bootstrap", domain, plist.path])
    try checkedCommand(launchctl, ["kickstart", "-k", service])
  }

  static func stopAgent(label: String, uid: UInt32, launchctl: URL = URL(fileURLWithPath: "/bin/launchctl")) throws {
    let service = "gui/\(uid)/\(label)"
    // The LaunchAgent owns the long-lived process and has KeepAlive enabled.
    // Unloading it before terminating the tray prevents launchd from bringing
    // the Local Agent straight back after the user chose Quit.
    guard try command(launchctl, ["print", service]).status == 0 else { return }
    try checkedCommand(launchctl, ["bootout", service])
    guard try command(launchctl, ["print", service]).status != 0 else {
      throw NSError(domain: "AgentLoop.LocalRuntime.Shutdown", code: 1, userInfo: [NSLocalizedDescriptionKey: "LaunchAgent remained loaded after bootout"])
    }
  }

  private static func checkedCommand(_ executable: URL, _ arguments: [String]) throws {
    let result = try command(executable, arguments)
    guard result.status == 0 else {
      throw NSError(domain: "AgentLoop.LocalRuntime.Startup", code: Int(result.status), userInfo: [NSLocalizedDescriptionKey: "\(executable.lastPathComponent) \(arguments.first ?? ""): \(result.error.trimmingCharacters(in: .whitespacesAndNewlines)) (exit \(result.status))"])
    }
  }

  private static func command(_ executable: URL, _ arguments: [String]) throws -> (status: Int32, error: String) {
    let process = Process()
    let errors = Pipe()
    process.executableURL = executable
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = errors
    try process.run()
    let data = errors.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
  }

  private struct Release: Decodable {
    let webOrigin: String
  }
}
