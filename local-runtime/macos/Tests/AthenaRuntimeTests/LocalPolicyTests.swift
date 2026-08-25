import XCTest
@testable import AthenaRuntime

final class LocalPolicyTests: XCTestCase {
  func testRejectsPathOutsideRoot() throws {
    let policy = LocalPolicy(allowedRoots: [URL(fileURLWithPath: "/tmp/athena")], allowedApps: [], stepUpApproved: false)
    XCTAssertThrowsError(try policy.scopedURL("/etc/passwd"))
  }

  func testAcceptsPathInsideRoot() throws {
    let policy = LocalPolicy(allowedRoots: [URL(fileURLWithPath: "/tmp/athena")], allowedApps: [], stepUpApproved: false)
    XCTAssertEqual(try policy.scopedURL("/tmp/athena/file.txt").path, "/tmp/athena/file.txt")
  }

  func testRejectsPermanentForbiddenCommand() throws {
    let policy = LocalPolicy(allowedRoots: [URL(fileURLWithPath: "/tmp")], allowedApps: [], stepUpApproved: false)
    XCTAssertThrowsError(try policy.authorize(tool: "local_command_run", args: ["cwd": .string("/tmp"), "command": .string("security dump-keychain")]))
  }
}
