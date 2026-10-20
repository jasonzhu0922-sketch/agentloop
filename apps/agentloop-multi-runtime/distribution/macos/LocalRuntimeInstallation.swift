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
    plist["StandardOutPath"] = logs.appendingPathComponent("agent.out.log").path
    plist["StandardErrorPath"] = logs.appendingPathComponent("agent.err.log").path
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: target, options: .atomic)
    return target
  }

  private struct Release: Decodable {
    let webOrigin: String
  }
}
