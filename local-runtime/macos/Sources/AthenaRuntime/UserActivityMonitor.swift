import CoreGraphics
import Foundation

final class UserActivityMonitor {
  static let shared = UserActivityMonitor()
  static let injectedEventTag: Int64 = 0x415448454e41

  private let lock = NSLock()
  private var lastPhysicalInput = Date.distantPast
  private var eventTap: CFMachPort?
  private var runLoopSource: CFRunLoopSource?

  private init() {
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue) |
      CGEventMask(1 << CGEventType.leftMouseDown.rawValue) |
      CGEventMask(1 << CGEventType.rightMouseDown.rawValue) |
      CGEventMask(1 << CGEventType.mouseMoved.rawValue) |
      CGEventMask(1 << CGEventType.scrollWheel.rawValue)
    let callback: CGEventTapCallBack = { _, type, event, userInfo in
      guard let userInfo else { return Unmanaged.passUnretained(event) }
      let monitor = Unmanaged<UserActivityMonitor>.fromOpaque(userInfo).takeUnretainedValue()
      if type != .tapDisabledByTimeout &&
         event.getIntegerValueField(.eventSourceUserData) != UserActivityMonitor.injectedEventTag {
        monitor.recordPhysicalInput()
      }
      return Unmanaged.passUnretained(event)
    }
    let userInfo = Unmanaged.passUnretained(self).toOpaque()
    eventTap = CGEvent.tapCreate(
      tap: .cghidEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: callback,
      userInfo: userInfo
    )
    if let eventTap {
      runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
      if let runLoopSource { CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes) }
      CGEvent.tapEnable(tap: eventTap, enable: true)
    }
  }

  func physicalInputWasRecent(within seconds: TimeInterval = 2) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return Date().timeIntervalSince(lastPhysicalInput) < seconds
  }

  private func recordPhysicalInput() {
    lock.lock(); lastPhysicalInput = Date(); lock.unlock()
  }
}

extension CGEvent {
  func markAsAthenaInjected() -> CGEvent {
    setIntegerValueField(.eventSourceUserData, value: UserActivityMonitor.injectedEventTag)
    return self
  }
}
