import CryptoKit
import Foundation

final class JobExecutor {
  private let desktop = DesktopAdapter()
  private let codex: CodexAppServer
  private let taskLock = NSLock()
  private var tasks: [String: Task<(JSONValue, ScreenshotFrame?), Error>] = [:]

  init(codex: CodexAppServer) {
    self.codex = codex
  }

  func execute(jobId: String, tool: String, args: [String: JSONValue], policy: LocalPolicy) async throws -> (JSONValue, ScreenshotFrame?) {
    try policy.authorize(tool: tool, args: args)
    if tool != "local_desktop_observe", let cached = JobCompletionStore.result(for: jobId) {
      return (cached, nil)
    }
    let task = Task<(JSONValue, ScreenshotFrame?), Error> {
      switch tool {
      case "local_device_status": return (.object(["status": .string("online")]), nil)
      case "local_desktop_observe": return (.object(["status": .string("captured")]), try await desktop.capture())
      case "local_desktop_act": return (.object(try desktop.act(args)), nil)
      case "local_file_read":
        let url = try policy.scopedURL(args["path"]?.string ?? "")
        let limit = min(Int(args["maxBytes"]?.number ?? 1_048_576), 1_048_576)
        let data = Data(try Data(contentsOf: url, options: [.mappedIfSafe]).prefix(limit))
        guard let text = String(data: data, encoding: .utf8) else { throw RuntimeFailure("file_not_utf8") }
        return (.object(["content": .string(text), "bytes": .number(Double(data.count))]), nil)
      case "local_file_write":
        let url = try policy.scopedURL(args["path"]?.string ?? "")
        if args["createOnly"]?.bool == true && FileManager.default.fileExists(atPath: url.path) { throw RuntimeFailure("file_already_exists") }
        let data = Data((args["content"]?.string ?? "").utf8)
        try data.write(to: url, options: [.atomic])
        return (.object(["status": .string("written"), "bytes": .number(Double(data.count))]), nil)
      case "local_command_run":
        return (try await runCommand(jobId: jobId, args: args, policy: policy), nil)
      default: throw RuntimeFailure("local_runtime_tool_unknown")
      }
    }
    taskLock.withTaskLock { tasks[jobId] = task }
    defer { _ = taskLock.withTaskLock { tasks.removeValue(forKey: jobId) } }
    let value = try await task.value
    if value.1 == nil { JobCompletionStore.save(jobId: jobId, result: value.0) }
    return value
  }

  func cancel(_ jobId: String) {
    taskLock.withTaskLock { tasks[jobId] }?.cancel()
    Task { await codex.terminate(processId: jobId) }
  }

  func cancelAll() {
    let jobIds = taskLock.withTaskLock { Array(tasks.keys) }
    for jobId in jobIds { cancel(jobId) }
  }

  private func runCommand(jobId: String, args: [String: JSONValue], policy: LocalPolicy) async throws -> JSONValue {
    let cwd = try policy.scopedURL(args["cwd"]?.string ?? "")
    let result = try await codex.runCommand(
      command: args["command"]?.string ?? "",
      cwd: cwd,
      writableRoots: policy.allowedRoots,
      timeoutMs: Int(args["timeoutMs"]?.number ?? 600_000),
      processId: jobId
    )
    return .object([
      "exitCode": .number(Double(result["exitCode"] as? Int ?? -1)),
      "stdout": .string(result["stdout"] as? String ?? ""),
      "stderr": .string(result["stderr"] as? String ?? ""),
      "sandbox": .string("codex-workspace-write"),
      "networkAccess": .bool(false)
    ])
  }
}

private extension NSLock {
  func withTaskLock<T>(_ body: () -> T) -> T {
    lock()
    defer { unlock() }
    return body()
  }
}
