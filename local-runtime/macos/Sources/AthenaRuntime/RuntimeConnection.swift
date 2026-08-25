import CryptoKit
import Foundation
import ApplicationServices

final class RuntimeConnection: ObservableObject {
  @Published var status = "offline"
  @Published var currentJob: String?
  private var configuration: RuntimeConfiguration
  private let identity: DeviceIdentity
  private let codex = CodexAppServer()
  private lazy var executor = JobExecutor(codex: codex)
  private var socket: URLSessionWebSocketTask?
  private var heartbeat: Task<Void, Never>?
  var onConfigurationChanged: ((RuntimeConfiguration) -> Void)?

  init(configuration: RuntimeConfiguration) throws {
    self.configuration = configuration
    self.identity = try DeviceIdentity()
  }

  func connect() {
    guard socket == nil, !configuration.paused else { return }
    var request = URLRequest(url: configuration.serverURL)
    request.timeoutInterval = 30
    let socket = URLSession(configuration: .default).webSocketTask(with: request)
    self.socket = socket; status = "connecting"; socket.resume()
    Task { await authenticate(); await receiveLoop() }
  }

  func disconnect() {
    heartbeat?.cancel(); heartbeat = nil
    executor.cancelAll()
    socket?.cancel(with: .goingAway, reason: nil); socket = nil
    codex.stop(); status = "offline"; currentJob = nil
  }

  func setPaused(_ paused: Bool) {
    configuration.paused = paused; onConfigurationChanged?(configuration)
    if paused { disconnect(); status = "paused" } else { connect() }
  }

  var allowedRootCount: Int { configuration.allowedRoots.count }
  var allowedAppCount: Int { configuration.allowedApps.count }

  func allowFolders(_ urls: [URL]) {
    configuration.allowedRoots = Array(Set(
      configuration.allowedRoots + urls.map { $0.standardizedFileURL.resolvingSymlinksInPath().path }
    )).sorted()
    onConfigurationChanged?(configuration)
  }

  func allowApplications(_ urls: [URL]) {
    configuration.allowedApps = Array(Set(
      configuration.allowedApps + urls.map { $0.deletingPathExtension().lastPathComponent }
    )).sorted()
    onConfigurationChanged?(configuration)
  }

  private func authenticate() async {
    do {
      let connectionId = UUID().uuidString
      if let deviceId = configuration.deviceId {
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        let nonce = UUID().uuidString
        let canonical = "{\"connectionId\":\"\(connectionId)\",\"deviceId\":\"\(deviceId)\",\"nonce\":\"\(nonce)\",\"protocol\":\"\(localRuntimeProtocol)\",\"timestamp\":\(timestamp)}"
        let signature = try identity.sign(Data(canonical.utf8))
        try await send(RuntimeEnvelope(type: "hello", protocolVersion: localRuntimeProtocol, deviceId: deviceId, connectionId: connectionId, timestamp: timestamp, nonce: nonce, signature: signature))
      } else {
        guard let token = configuration.pairingToken else { throw RuntimeFailure("pairing_token_missing") }
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
        let nonce = UUID().uuidString
        let descriptor = DeviceDescriptor(
          name: Host.current().localizedName ?? "Mac",
          platform: "macos",
          version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "development",
          publicKeyPem: identity.publicKeyPEM,
          keyAlgorithm: "p256",
          capabilities: ["desktop": true, "file": true, "command": true, "codexAppServer": true],
          permissions: RuntimePermissions.snapshot()
        )
        let tokenHash = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        let publicKeyHash = SHA256.hash(data: Data(descriptor.publicKeyPem.utf8)).map { String(format: "%02x", $0) }.joined()
        let canonical = "{\"connectionId\":\"\(connectionId)\",\"nonce\":\"\(nonce)\",\"pairingTokenHash\":\"\(tokenHash)\",\"protocol\":\"\(localRuntimeProtocol)\",\"publicKeyHash\":\"\(publicKeyHash)\",\"timestamp\":\(timestamp)}"
        let signature = try identity.sign(Data(canonical.utf8))
        try await send(RuntimeEnvelope(type: "pair", protocolVersion: localRuntimeProtocol, connectionId: connectionId, timestamp: timestamp, nonce: nonce, signature: signature, pairingToken: token, device: descriptor))
      }
    } catch { status = "error"; disconnect() }
  }

  private func receiveLoop() async {
    while let socket {
      do {
        let message = try await socket.receive()
        let data: Data
        switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
        let envelope = try JSONDecoder().decode(RuntimeEnvelope.self, from: data)
        try await handle(envelope)
      } catch { disconnect(); break }
    }
  }

  private func handle(_ envelope: RuntimeEnvelope) async throws {
    switch envelope.type {
    case "paired", "ready":
      if let id = envelope.deviceId { configuration.deviceId = id; configuration.pairingToken = nil }
      if let key = envelope.serverSigningPublicKey { configuration.serverSigningPublicKey = key }
      onConfigurationChanged?(configuration); status = "online"
      try? codex.start(); startHeartbeat()
    case "job.start":
      Task { try? await execute(envelope) }
    case "job.cancel": if let id = envelope.jobId { executor.cancel(id) }
    case "error": status = envelope.reasonCode ?? "error"
    default: break
    }
  }

  private func execute(_ envelope: RuntimeEnvelope) async throws {
    guard let jobId = envelope.jobId, let tool = envelope.capability,
          let assertion = envelope.assertion, var args = envelope.args?.object else { throw RuntimeFailure("job_envelope_invalid") }
    let computedArgumentHash = SHA256.hash(data: try envelope.args!.canonicalData()).map { String(format: "%02x", $0) }.joined()
    guard computedArgumentHash == envelope.argumentHash else { throw RuntimeFailure("job_argument_hash_invalid") }
    try verify(assertion: assertion, jobId: jobId, tool: tool, argumentHash: envelope.argumentHash)
    let scope = assertion.payload.object ?? [:]
    if tool == "local_command_run",
       let deadline = scope["deadline"]?.string,
       let date = ISO8601DateFormatter().date(from: deadline) {
      let remaining = max(1_000, Int(date.timeIntervalSinceNow * 1_000))
      let requested = Int(args["timeoutMs"]?.number ?? 600_000)
      args["timeoutMs"] = .number(Double(min(requested, remaining)))
    }
    let assertedRoots = scope["allowedRoots"]?.arrayStrings ?? []
    let roots = assertedRoots.filter { asserted in
      let target = URL(fileURLWithPath: asserted).standardizedFileURL.resolvingSymlinksInPath().path
      return configuration.allowedRoots.contains { local in
        let base = URL(fileURLWithPath: local).standardizedFileURL.resolvingSymlinksInPath().path
        return target == base || target.hasPrefix(base + "/")
      }
    }
    let assertedApps = Set(scope["allowedApps"]?.arrayStrings ?? [])
    let apps = configuration.allowedApps.filter(assertedApps.contains)
    let policy = LocalPolicy(
      allowedRoots: roots.map { URL(fileURLWithPath: $0) },
      allowedApps: Set(apps),
      stepUpApproved: scope["stepUpApproved"]?.bool == true
    )
    currentJob = jobId
    do {
      let (result, frame) = try await executor.execute(jobId: jobId, tool: tool, args: args, policy: policy)
      let hash = SHA256.hash(data: try result.canonicalData()).map { String(format: "%02x", $0) }.joined()
      try await send(RuntimeEnvelope(type: "job.completed", protocolVersion: localRuntimeProtocol, jobId: jobId, result: result, resultHash: hash, frame: frame))
    } catch {
      try await send(RuntimeEnvelope(type: "job.failed", protocolVersion: localRuntimeProtocol, jobId: jobId, reasonCode: (error as? RuntimeFailure)?.code ?? "local_runtime_job_failed"))
    }
    currentJob = nil
  }

  private func verify(assertion: CapabilityAssertion, jobId: String, tool: String, argumentHash: String?) throws {
    guard assertion.algorithm == "Ed25519", let pem = configuration.serverSigningPublicKey else { throw RuntimeFailure("server_assertion_key_missing") }
    let payload = assertion.payload.object ?? [:]
    guard payload["jobId"]?.string == jobId, payload["tool"]?.string == tool,
          payload["argumentHash"]?.string == argumentHash else { throw RuntimeFailure("capability_assertion_binding_invalid") }
    guard payload["deviceId"]?.string == configuration.deviceId else { throw RuntimeFailure("capability_assertion_device_invalid") }
    if let deadline = payload["deadline"]?.string, let date = ISO8601DateFormatter().date(from: deadline), date <= Date() { throw RuntimeFailure("capability_assertion_expired") }
    let der = Data(base64Encoded: pem.components(separatedBy: "\n").filter { !$0.hasPrefix("---") }.joined()) ?? Data()
    guard der.count >= 32 else { throw RuntimeFailure("server_assertion_key_invalid") }
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: der.suffix(32))
    guard publicKey.isValidSignature(Data(base64URL: assertion.signature), for: try assertion.payload.canonicalData()) else { throw RuntimeFailure("capability_assertion_signature_invalid") }
  }

  private func startHeartbeat() {
    heartbeat?.cancel()
    heartbeat = Task {
      while !Task.isCancelled {
        try? await send(RuntimeEnvelope(
          type: "heartbeat",
          protocolVersion: localRuntimeProtocol,
          deviceId: configuration.deviceId,
          version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "development",
          paused: configuration.paused,
          capabilities: ["desktop": true, "file": true, "command": true, "codexAppServer": true],
          permissions: RuntimePermissions.snapshot()
        ))
        try? await Task.sleep(for: .seconds(15))
      }
    }
  }

  private func send(_ envelope: RuntimeEnvelope) async throws {
    let data = try JSONEncoder().encode(envelope)
    try await socket?.send(.data(data))
  }
}

extension JSONValue {
  var arrayStrings: [String]? { if case .array(let values) = self { return values.compactMap(\.string) }; return nil }
}

extension Data {
  init(base64URL: String) {
    var value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    value += String(repeating: "=", count: (4 - value.count % 4) % 4)
    self = Data(base64Encoded: value) ?? Data()
  }
}

enum RuntimePermissions {
  static func snapshot() -> [String: Bool] {
    ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "automation": true]
  }
}
