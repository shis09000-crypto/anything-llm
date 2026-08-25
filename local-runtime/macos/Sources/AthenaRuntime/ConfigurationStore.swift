import Foundation

enum ConfigurationStore {
  static var url: URL {
    let base: URL
    if let override = ProcessInfo.processInfo.environment["ATHENA_LOCAL_RUNTIME_CONFIG_DIR"],
       !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      base = URL(fileURLWithPath: override, isDirectory: true)
    } else {
      base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("AthenaRuntime", isDirectory: true)
    }
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base.appendingPathComponent("runtime.json")
  }

  static func load() -> RuntimeConfiguration {
    if let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(RuntimeConfiguration.self, from: data) { return value }
    let endpoint = ProcessInfo.processInfo.environment["ATHENA_LOCAL_RUNTIME_URL"] ?? "wss://athenallm.online/api/local-runtime/device/connect"
    return RuntimeConfiguration(
      serverURL: URL(string: endpoint)!,
      pairingToken: ProcessInfo.processInfo.environment["ATHENA_LOCAL_RUNTIME_PAIRING_TOKEN"],
      deviceId: nil,
      serverSigningPublicKey: nil,
      allowedRoots: [],
      allowedApps: [],
      paused: false
    )
  }

  static func save(_ configuration: RuntimeConfiguration) {
    guard let data = try? JSONEncoder().encode(configuration) else { return }
    try? data.write(to: url, options: [.atomic, .completeFileProtection])
  }
}
