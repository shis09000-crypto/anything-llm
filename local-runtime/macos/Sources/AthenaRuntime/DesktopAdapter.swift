import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

final class DesktopAdapter {
  private let activity = UserActivityMonitor.shared

  func capture() async throws -> ScreenshotFrame {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw RuntimeFailure("display_unavailable") }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = SCStreamConfiguration()
    config.width = display.width
    config.height = display.height
    config.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else { throw RuntimeFailure("screenshot_encoding_failed") }
    return ScreenshotFrame(mimeType: "image/jpeg", data: jpeg.base64EncodedString(), capturedAt: ISO8601DateFormatter().string(from: Date()))
  }

  func act(_ args: [String: JSONValue]) throws -> [String: JSONValue] {
    if activity.physicalInputWasRecent() { throw RuntimeFailure("user_input_active") }
    let action = args["action"]?.string ?? ""
    let x = args["x"]?.number ?? 0
    let y = args["y"]?.number ?? 0
    switch action {
    case "click", "double_click":
      let point = CGPoint(x: x, y: y)
      let count = action == "double_click" ? 2 : 1
      for index in 1...count {
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(index)); down?.markAsAthenaInjected().post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.markAsAthenaInjected().post(tap: .cghidEventTap)
      }
    case "move": CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.markAsAthenaInjected().post(tap: .cghidEventTap)
    case "scroll": CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(args["deltaY"]?.number ?? 0), wheel2: Int32(args["deltaX"]?.number ?? 0), wheel3: 0)?.markAsAthenaInjected().post(tap: .cghidEventTap)
    case "type":
      let text = args["text"]?.string ?? ""
      let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
      event?.keyboardSetUnicodeString(stringLength: text.utf16.count, unicodeString: Array(text.utf16)); event?.markAsAthenaInjected().post(tap: .cghidEventTap)
    case "key":
      let keys: [String: CGKeyCode] = ["return": 36, "tab": 48, "space": 49, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126]
      guard let code = keys[(args["key"]?.string ?? "").lowercased()] else { throw RuntimeFailure("key_not_allowed") }
      CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.markAsAthenaInjected().post(tap: .cghidEventTap)
      CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.markAsAthenaInjected().post(tap: .cghidEventTap)
    case "open_app":
      guard let app = args["app"]?.string else { throw RuntimeFailure("app_missing") }
      guard NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/\(app).app")) else {
        throw RuntimeFailure("app_open_failed")
      }
    default: throw RuntimeFailure("desktop_action_denied")
    }
    return ["status": .string("completed"), "action": .string(action)]
  }
}
