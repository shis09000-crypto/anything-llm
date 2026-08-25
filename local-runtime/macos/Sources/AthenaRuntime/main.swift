import AppKit
import Foundation
import ServiceManagement
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var item: NSStatusItem!
  private var connection: RuntimeConnection?
  private var statusObservation: NSKeyValueObservation?

  func applicationDidFinishLaunching(_ notification: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "Athena Runtime")
    do {
      let connection = try RuntimeConnection(configuration: ConfigurationStore.load())
      connection.onConfigurationChanged = ConfigurationStore.save
      self.connection = connection
      rebuildMenu()
      connection.connect()
      Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
        DispatchQueue.main.async { self?.rebuildMenu() }
      }
    } catch {
      item.button?.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Runtime error")
    }
  }

  private func rebuildMenu() {
    let menu = NSMenu()
    let status = connection?.status ?? "unavailable"
    let statusItem = NSMenuItem(title: "Athena Runtime · \(status)", action: nil, keyEquivalent: "")
    statusItem.isEnabled = false; menu.addItem(statusItem)
    if let job = connection?.currentJob {
      let jobItem = NSMenuItem(title: "Running · \(job.prefix(8))", action: nil, keyEquivalent: "")
      jobItem.isEnabled = false; menu.addItem(jobItem)
    }
    menu.addItem(.separator())
    let pause = NSMenuItem(title: status == "paused" ? "Resume" : "Pause", action: #selector(togglePause), keyEquivalent: "p")
    pause.target = self; menu.addItem(pause)
    let stop = NSMenuItem(title: "Emergency stop", action: #selector(emergencyStop), keyEquivalent: "s")
    stop.target = self; menu.addItem(stop)
    menu.addItem(.separator())
    let folders = NSMenuItem(title: "Allowed folders · \(connection?.allowedRootCount ?? 0)", action: #selector(chooseFolders), keyEquivalent: "")
    folders.target = self; menu.addItem(folders)
    let apps = NSMenuItem(title: "Allowed apps · \(connection?.allowedAppCount ?? 0)", action: #selector(chooseApplications), keyEquivalent: "")
    apps.target = self; menu.addItem(apps)
    let launchAtLogin = NSMenuItem(title: "Start at login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
    launchAtLogin.target = self
    launchAtLogin.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(launchAtLogin)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
    quit.target = self; menu.addItem(quit)
    item.menu = menu
  }

  @objc private func togglePause() { connection?.setPaused(connection?.status != "paused") }
  @objc private func emergencyStop() { connection?.setPaused(true) }
  @objc private func chooseFolders() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true; panel.canChooseFiles = false
    panel.allowsMultipleSelection = true; panel.canCreateDirectories = false
    if panel.runModal() == .OK { connection?.allowFolders(panel.urls) }
  }
  @objc private func chooseApplications() {
    let panel = NSOpenPanel()
    panel.directoryURL = URL(fileURLWithPath: "/Applications")
    panel.canChooseDirectories = false; panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [.application]
    if panel.runModal() == .OK { connection?.allowApplications(panel.urls) }
  }
  @objc private func toggleLaunchAtLogin() {
    do {
      if SMAppService.mainApp.status == .enabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
      }
    } catch {}
    rebuildMenu()
  }
  @objc private func quit() { connection?.disconnect(); NSApplication.shared.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
