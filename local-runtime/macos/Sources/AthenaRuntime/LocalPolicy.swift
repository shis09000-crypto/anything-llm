import AppKit
import Carbon.HIToolbox
import Foundation

struct LocalPolicy {
  let allowedRoots: [URL]
  let allowedApps: Set<String>
  let stepUpApproved: Bool

  private static let forbidden = [
    "password", "passkey", "otp", "keychain", "security dump-keychain",
    "payment", "checkout", "crypto transfer", "csrutil", "spctl --master-disable",
    "camera", "microphone", "sudo"
  ]

  func authorize(tool: String, args: [String: JSONValue]) throws {
    let searchable = String(data: try JSONEncoder().encode(args), encoding: .utf8)?.lowercased() ?? ""
    if Self.forbidden.contains(where: searchable.contains) { throw RuntimeFailure("local_runtime_permanently_forbidden") }
    let requiresStepUp = searchable.contains("installer") || searchable.contains("softwareupdate") ||
      searchable.contains("launchctl bootstrap") || searchable.contains("system settings") ||
      searchable.contains("system preferences") || searchable.contains("--upload-file")
    if requiresStepUp && !stepUpApproved { throw RuntimeFailure("local_runtime_step_up_required") }
    if tool.hasPrefix("local_desktop") {
      guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
            session["CGSSessionScreenIsLocked"] as? Bool != true else {
        throw RuntimeFailure("desktop_session_locked")
      }
      if IsSecureEventInputEnabled() { throw RuntimeFailure("secure_input_active") }
    }
    if let path = args["path"]?.string ?? args["cwd"]?.string { _ = try scopedURL(path) }
    if tool == "local_desktop_act", args["action"]?.string == "open_app",
       let app = args["app"]?.string {
      guard allowedApps.contains(app) else {
        throw RuntimeFailure("local_runtime_app_outside_lease")
      }
    }
  }

  func scopedURL(_ path: String) throws -> URL {
    let target = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
    guard allowedRoots.contains(where: { root in
      let base = root.standardizedFileURL.resolvingSymlinksInPath().path
      return target.path == base || target.path.hasPrefix(base + "/")
    }) else { throw RuntimeFailure("local_runtime_path_outside_lease") }
    return target
  }
}
