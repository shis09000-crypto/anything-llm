import Foundation

final class CodexAppServer {
  private struct PendingRequest {
    let continuation: CheckedContinuation<[String: Any], Error>
  }

  private let stateLock = NSLock()
  private let writeLock = NSLock()
  private let readerQueue = DispatchQueue(label: "online.athena.runtime.codex-reader")
  private var process: Process?
  private var standardInput: FileHandle?
  private var standardOutput: FileHandle?
  private var pending: [Int: PendingRequest] = [:]
  private var nextRequestId = 1
  private var initialized = false
  private var initializationTask: Task<Void, Error>?

  func start() throws {
    stateLock.lock()
    if process?.isRunning == true {
      stateLock.unlock()
      return
    }
    stateLock.unlock()

    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let error = Pipe()
    if let bundledCodex = Bundle.main.url(forResource: "codex", withExtension: nil) {
      process.executableURL = bundledCodex
      process.arguments = ["app-server", "--listen", "stdio://"]
    } else {
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["codex", "app-server", "--listen", "stdio://"]
    }
    process.standardInput = input
    process.standardOutput = output
    process.standardError = error
    try process.run()

    stateLock.lock()
    self.process = process
    standardInput = input.fileHandleForWriting
    standardOutput = output.fileHandleForReading
    initialized = false
    initializationTask = nil
    stateLock.unlock()
    readerQueue.async { [weak self] in self?.readLoop() }
  }

  func stop() {
    stateLock.lock()
    let running = process
    process = nil
    standardInput = nil
    standardOutput = nil
    initialized = false
    initializationTask = nil
    let waiting = Array(pending.values)
    pending.removeAll()
    stateLock.unlock()
    running?.terminate()
    for request in waiting {
      request.continuation.resume(throwing: RuntimeFailure("codex_app_server_stopped"))
    }
  }

  func runCommand(
    command: String,
    cwd: URL,
    writableRoots: [URL],
    timeoutMs: Int,
    processId: String
  ) async throws -> [String: Any] {
    try start()
    try await ensureInitialized()
    return try await request(method: "command/exec", params: [
      "command": ["/bin/zsh", "-f", "-c", command],
      "cwd": cwd.path,
      "processId": processId,
      "timeoutMs": max(1_000, min(timeoutMs, 600_000)),
      "outputBytesCap": 1_048_576,
      "sandboxPolicy": [
        "type": "workspaceWrite",
        "writableRoots": writableRoots.map(\.path),
        "networkAccess": false,
        "excludeSlashTmp": true,
        "excludeTmpdirEnvVar": true,
      ],
      "env": [
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        "HOME": NSNull(),
        "CODEX_HOME": NSNull(),
      ],
    ])
  }

  func terminate(processId: String) async {
    try? await ensureInitialized()
    _ = try? await request(
      method: "command/exec/terminate",
      params: ["processId": processId]
    )
  }

  private func ensureInitialized() async throws {
    if stateLock.withLock({ initialized }) { return }
    let task: Task<Void, Error> = stateLock.withLock {
      if let existing = initializationTask { return existing }
      let created = Task { [weak self] in
        guard let self else { throw RuntimeFailure("codex_app_server_unavailable") }
        _ = try await self.request(method: "initialize", params: [
          "clientInfo": [
            "name": "athena-runtime-host",
            "title": "Athena Local Runtime",
            "version": "0.1.0",
          ],
          "capabilities": ["experimentalApi": true],
        ])
        try self.sendObject(["method": "initialized"])
        self.stateLock.withLock {
          self.initialized = true
          self.initializationTask = nil
        }
      }
      initializationTask = created
      return created
    }
    try await task.value
  }

  private func request(method: String, params: [String: Any]) async throws -> [String: Any] {
    let requestId: Int = stateLock.withLock {
      let value = nextRequestId
      nextRequestId += 1
      return value
    }
    return try await withCheckedThrowingContinuation { continuation in
      stateLock.lock()
      pending[requestId] = PendingRequest(continuation: continuation)
      stateLock.unlock()
      do {
        try sendObject(["id": requestId, "method": method, "params": params])
      } catch {
        stateLock.lock()
        let request = pending.removeValue(forKey: requestId)
        stateLock.unlock()
        request?.continuation.resume(throwing: error)
      }
    }
  }

  private func sendObject(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object)
    guard let line = (String(data: data, encoding: .utf8) ?? "").appending("\n").data(using: .utf8) else {
      throw RuntimeFailure("codex_app_server_encode_failed")
    }
    writeLock.lock()
    defer { writeLock.unlock() }
    stateLock.lock()
    let input = standardInput
    stateLock.unlock()
    guard let input else { throw RuntimeFailure("codex_app_server_unavailable") }
    try input.write(contentsOf: line)
  }

  private func readLoop() {
    var buffered = Data()
    while true {
      stateLock.lock()
      let output = standardOutput
      stateLock.unlock()
      guard let output else { return }
      let data = output.availableData
      if data.isEmpty {
        stop()
        return
      }
      buffered.append(data)
      while let newline = buffered.firstIndex(of: 0x0A) {
        let line = buffered.prefix(upTo: newline)
        buffered.removeSubrange(...newline)
        guard
          !line.isEmpty,
          let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let requestId = value["id"] as? Int
        else { continue }
        stateLock.lock()
        let request = pending.removeValue(forKey: requestId)
        stateLock.unlock()
        guard let request else { continue }
        if let error = value["error"] as? [String: Any] {
          request.continuation.resume(
            throwing: RuntimeFailure(String(describing: error["message"] ?? "codex_app_server_request_failed"))
          )
        } else {
          request.continuation.resume(returning: value["result"] as? [String: Any] ?? [:])
        }
      }
    }
  }
}

private extension NSLock {
  func withLock<T>(_ body: () -> T) -> T {
    lock()
    defer { unlock() }
    return body()
  }
}
