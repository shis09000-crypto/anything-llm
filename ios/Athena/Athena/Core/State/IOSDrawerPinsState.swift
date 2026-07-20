import Foundation

struct IOSDrawerPin: Codable, Equatable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case workspace
        case thread
    }

    let kind: Kind
    let workspaceID: String
    let threadID: String?
    let pinnedAt: String

    var id: String {
        switch kind {
        case .workspace:
            "workspace:\(workspaceID)"
        case .thread:
            "thread:\(workspaceID):\(threadID ?? "")"
        }
    }
}

struct IOSDrawerPinsState: Codable, Equatable, Sendable {
    static let namespace = "ios.drawer.pins"
    static let empty = IOSDrawerPinsState(pins: [])

    var pins: [IOSDrawerPin]
}
