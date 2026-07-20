import Foundation

struct NativeSyncScope: Codable, Equatable, Sendable {
    let userId: Int?
    let workspaceId: Int?
    let threadId: Int?
    let workspaceSlug: String?
    let threadSlug: String?
    let clientId: String?
}

struct NativeSyncResource: Codable, Equatable, Sendable {
    let kind: String?
    let id: Int?
    let publicId: String?
}

struct NativeSyncOrigin: Codable, Equatable, Sendable {
    let clientId: String?
    let requestId: String?
    let actionId: String?
}

struct NativeSyncPayload: Codable, Equatable, Sendable {
    let syncV2: NativeSyncV2Event?
    let workspaceSlug: String?
    let workspaceName: String?
    let namespaces: [String]?
    let namespace: String?
    let scope: String?
    let threadSlug: String?
    let threadName: String?
    let title: String?
    let threadType: String?
    let chatModel: String?
    let historyFingerprint: String?
    let historyRevision: Int?
    let latestChatId: Int?
    let latestChatAt: String?
    let deleteIntentId: String?
    let error: String?
    let errorCode: String?
    let checkpointEventId: String?
    let reason: String?
    let clientTurnId: String?
    let startingChatId: Int?
    let targetChatId: Int?
    let mutationKind: String?
    let invocationId: String?
    let changedFields: [String]?
    let category: String?
    var provider: String? = nil
    var version: String? = nil
}

struct NativeSyncEvent: Codable, Equatable, Sendable {
    let eventId: String
    let type: String
    let broadcastType: String?
    let namespace: String?
    let eventType: String?
    let shortType: String?
    let scope: NativeSyncScope?
    let resource: NativeSyncResource?
    let origin: NativeSyncOrigin?
    let payload: NativeSyncPayload?
    let revision: Int?
    let version: Int?
    let createdAt: String?
    let sourceClientId: String?

    var dottedType: String {
        if let broadcastType, broadcastType.contains(".") { return broadcastType }
        if type.contains(".") { return type }
        if let namespace { return "\(namespace).\(eventType ?? shortType ?? type)" }
        return type
    }

    var workspaceID: String? {
        payload?.workspaceSlug ?? scope?.workspaceSlug
    }

    var threadID: String? {
        payload?.threadSlug ?? scope?.threadSlug
    }

    var senderClientID: String? {
        sourceClientId ?? origin?.clientId
    }
}

struct NativeSyncReplayResponse: Decodable, Sendable {
    let success: Bool
    let events: [NativeSyncEvent]
    let nextEventId: String?
    let checkpointEventId: String?
    let hasMore: Bool
    let requiresFullSync: Bool
}

struct NativePushTokenRequest: Encodable, Sendable {
    let deviceToken: String
}

struct NativeSyncSuccessResponse: Decodable, Sendable {
    let success: Bool
}

enum NativeThreadSyncPhase: String, Codable, Sendable {
    case clean
    case dirty
    case checking
    case refreshing
}

struct NativeThreadSyncState: Equatable, Sendable {
    var phase: NativeThreadSyncPhase = .clean
    var remoteRevision: Int = 0
    var remoteFingerprint: String?
    var rerunNeeded = false
}
