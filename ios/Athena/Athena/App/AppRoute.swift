import Foundation

enum AppRoute: Hashable {
    case thread(workspaceID: String, threadID: String)
    case readerDocument(documentID: String)
    case agentSession(sessionID: String)
    case settings(section: SettingsSection)
}

enum SettingsSection: String, Hashable, Identifiable, CaseIterable {
    case transport
    case security
    case nativeReadiness

    var id: String { rawValue }

    var title: String {
        switch self {
        case .transport:
            "Transport"
        case .security:
            "Security"
        case .nativeReadiness:
            "Native Readiness"
        }
    }
}
