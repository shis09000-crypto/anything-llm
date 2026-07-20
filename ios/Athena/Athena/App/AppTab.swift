import SwiftUI

enum AppTab: String, Identifiable, CaseIterable {
    case workspace
    case chat
    case reader
    case agent
    case settings

    var id: String { rawValue }

    @ViewBuilder
    func makeContentView() -> some View {
        switch self {
        case .workspace:
            WorkspaceView()
        case .chat:
            ChatView()
        case .reader:
            ReaderView()
        case .agent:
            AgentView()
        case .settings:
            SettingsView()
        }
    }

    @ViewBuilder
    var label: some View {
        switch self {
        case .workspace:
            Label("Workspace", systemImage: "rectangle.3.group")
        case .chat:
            Label("Chat", systemImage: "bubble.left.and.bubble.right")
        case .reader:
            Label("Reader", systemImage: "doc.text.magnifyingglass")
        case .agent:
            Label("Agent", systemImage: "sparkles")
        case .settings:
            Label("Settings", systemImage: "gearshape")
        }
    }

    var title: String {
        switch self {
        case .workspace:
            "Workspace"
        case .chat:
            "Chat"
        case .reader:
            "Reader"
        case .agent:
            "Agent"
        case .settings:
            "Settings"
        }
    }
}
