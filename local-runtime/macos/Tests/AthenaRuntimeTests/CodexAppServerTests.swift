import Foundation
import XCTest
@testable import AthenaRuntime

final class CodexAppServerTests: XCTestCase {
  func testRunsCommandThroughWorkspaceWriteSandbox() async throws {
    guard commandExists("codex") else {
      throw XCTSkip("Codex CLI is not installed in this test environment")
    }
    let fileManager = FileManager.default
    let base = fileManager.temporaryDirectory
      .appendingPathComponent("athena-runtime-test-\(UUID().uuidString)")
    let allowed = base.appendingPathComponent("allowed")
    let denied = base.appendingPathComponent("denied")
    try fileManager.createDirectory(at: allowed, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: denied, withIntermediateDirectories: true)
    defer { try? fileManager.removeItem(at: base) }

    let server = CodexAppServer()
    defer { server.stop() }
    let allowedFile = allowed.appendingPathComponent("inside.txt")
    let allowedResult = try await server.runCommand(
      command: "printf allowed > \(shellQuote(allowedFile.path))",
      cwd: allowed,
      writableRoots: [allowed],
      timeoutMs: 10_000,
      processId: UUID().uuidString
    )
    XCTAssertEqual(allowedResult["exitCode"] as? Int, 0)
    XCTAssertEqual(try String(contentsOf: allowedFile), "allowed")

    let deniedFile = denied.appendingPathComponent("outside.txt")
    let deniedResult = try await server.runCommand(
      command: "printf denied > \(shellQuote(deniedFile.path))",
      cwd: allowed,
      writableRoots: [allowed],
      timeoutMs: 10_000,
      processId: UUID().uuidString
    )
    XCTAssertNotEqual(deniedResult["exitCode"] as? Int, 0)
    XCTAssertFalse(fileManager.fileExists(atPath: deniedFile.path))
  }

  private func commandExists(_ command: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["which", command]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try? process.run()
    process.waitUntilExit()
    return process.terminationStatus == 0
  }

  private func shellQuote(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
  }
}
