import Foundation

enum ThreadChatModel: String, Codable, CaseIterable, Equatable, Sendable {
    case flash = "deepseek-v4-flash"
    case pro = "deepseek-v4-pro"

    var displayName: String {
        switch self {
        case .flash:
            "快速"
        case .pro:
            "深度思考"
        }
    }

    static func resolved(
        threadModel: ThreadChatModel?,
        workspaceModel: ThreadChatModel?
    ) -> ThreadChatModel {
        threadModel ?? workspaceModel ?? .pro
    }
}

struct AthenaWorkspace: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let serverID: Int?
    let sourceActionID: String?
    var title: String
    var chatModel: ThreadChatModel?
    var threads: [AthenaThread]
    let createdAt: String?
    let lastUpdatedAt: String?

    init(
        id: String,
        serverID: Int? = nil,
        sourceActionID: String? = nil,
        title: String,
        chatModel: ThreadChatModel? = nil,
        threads: [AthenaThread] = [],
        createdAt: String? = nil,
        lastUpdatedAt: String? = nil
    ) {
        self.id = id
        self.serverID = serverID
        self.sourceActionID = sourceActionID
        self.title = title
        self.chatModel = chatModel
        self.threads = threads
        self.createdAt = createdAt
        self.lastUpdatedAt = lastUpdatedAt
    }
}

struct AthenaThread: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let serverID: Int?
    let sourceActionID: String?
    let workspaceID: String
    var title: String
    var chatModel: ThreadChatModel?
    let threadType: String?
    let createdAt: String?
    let lastUpdatedAt: String?
    var historyFingerprint: String?
    var historyRevision: Int
    var latestChatID: Int?
    var latestChatAt: String?
    var messages: [AthenaChatMessage]

    init(
        id: String,
        serverID: Int? = nil,
        sourceActionID: String? = nil,
        workspaceID: String,
        title: String,
        chatModel: ThreadChatModel? = nil,
        threadType: String? = nil,
        createdAt: String? = nil,
        lastUpdatedAt: String? = nil,
        historyFingerprint: String? = nil,
        historyRevision: Int = 0,
        latestChatID: Int? = nil,
        latestChatAt: String? = nil,
        messages: [AthenaChatMessage] = []
    ) {
        self.id = id
        self.serverID = serverID
        self.sourceActionID = sourceActionID
        self.workspaceID = workspaceID
        self.title = title
        self.chatModel = chatModel
        self.threadType = threadType
        self.createdAt = createdAt
        self.lastUpdatedAt = lastUpdatedAt
        self.historyFingerprint = historyFingerprint
        self.historyRevision = historyRevision
        self.latestChatID = latestChatID
        self.latestChatAt = latestChatAt
        self.messages = messages
    }

    var isOverview: Bool {
        threadType == "overview"
    }
}

struct AthenaChatMessage: Codable, Equatable, Identifiable, Sendable {
    enum Role: String, Codable, Sendable {
        case user
        case assistant
    }

    enum DeliveryState: String, Codable, Sendable {
        case pending
        case confirming
        case streaming
        case reconciling
        case confirmed
        case failed
        case stopped
    }

    let id: String
    let role: Role
    let text: String
    let chatID: Int?
    let publicChatID: String?
    let sentAt: Double?
    let hydrationStatus: String?
    let clientTurnID: String?
    var deliveryState: DeliveryState?

    var isConfirmed: Bool {
        deliveryState == nil || deliveryState == .confirmed
    }

    init(
        id: String,
        role: Role,
        text: String,
        chatID: Int? = nil,
        publicChatID: String? = nil,
        sentAt: Double? = nil,
        hydrationStatus: String? = nil,
        clientTurnID: String? = nil,
        deliveryState: DeliveryState? = .confirmed
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.chatID = chatID
        self.publicChatID = publicChatID
        self.sentAt = sentAt
        self.hydrationStatus = hydrationStatus
        self.clientTurnID = clientTurnID
        self.deliveryState = deliveryState
    }
}

struct MessageTimelineState: Equatable {
    let id: String
    let role: AthenaChatMessage.Role
    let chatID: Int?
    let publicChatID: String?
    let deliveryState: AthenaChatMessage.DeliveryState?

    init(message: AthenaChatMessage) {
        id = message.id
        role = message.role
        chatID = message.chatID
        publicChatID = message.publicChatID
        deliveryState = message.deliveryState
    }
}

struct AthenaChatEditSession: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case editing
        case submitting
        case streamReady
        case historyTruncated
    }

    let threadID: String
    let messageID: String
    let startingChatID: Int
    let publicChatID: String?
    let originalText: String
    var submittedText: String?
    var sourceActionID: String?
    var clientTurnID: String?
    var phase: Phase
}

struct AthenaHistoryPage: Codable, Equatable, Sendable {
    let limit: Int
    let olderBeforeChatID: Int?
    let newerAfterChatID: Int?
    let hasOlder: Bool
    let hasNewer: Bool

    static let complete = AthenaHistoryPage(
        limit: 20,
        olderBeforeChatID: nil,
        newerAfterChatID: nil,
        hasOlder: false,
        hasNewer: false
    )
}

struct AthenaThreadHistoryPage: Codable, Equatable, Sendable {
    let thread: AthenaThread?
    let messages: [AthenaChatMessage]
    let page: AthenaHistoryPage
    let historyFingerprint: String?
    let historyRevision: Int

    init(
        thread: AthenaThread?,
        messages: [AthenaChatMessage],
        page: AthenaHistoryPage,
        historyFingerprint: String? = nil,
        historyRevision: Int = 0
    ) {
        self.thread = thread
        self.messages = messages
        self.page = page
        self.historyFingerprint = historyFingerprint
        self.historyRevision = historyRevision
    }
}

struct AthenaThreadHistoryState: Equatable, Sendable {
    var page: AthenaHistoryPage?
    var isLoadingInitial = false
    var isLoadingOlder = false
    var olderPageError: String?

    var hasOlder: Bool {
        page?.hasOlder == true
    }
}

struct WorkspaceMetadataSnapshot: Codable, Equatable, Sendable {
    let workspaces: [AthenaWorkspace]
    let selectedWorkspaceID: String?
    let selectedThreadID: String?
    let savedAt: Date
}

struct LocalConversationViewportSnapshot: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let workspaceID: String
    let threadID: String
    let messageID: String?
    let chatID: Int?
    let contentOffsetY: CGFloat
    let viewportWidth: CGFloat
    let historyRevision: Int
    let isAtBottom: Bool
    let updatedAt: Date

    init(
        workspaceID: String,
        threadID: String,
        messageID: String?,
        chatID: Int?,
        contentOffsetY: CGFloat,
        viewportWidth: CGFloat,
        historyRevision: Int,
        isAtBottom: Bool,
        updatedAt: Date = Date()
    ) {
        schemaVersion = Self.currentSchemaVersion
        self.workspaceID = workspaceID
        self.threadID = threadID
        self.messageID = messageID
        self.chatID = chatID
        self.contentOffsetY = contentOffsetY
        self.viewportWidth = viewportWidth
        self.historyRevision = historyRevision
        self.isAtBottom = isAtBottom
        self.updatedAt = updatedAt
    }
}

struct RecentWorkspaceReference: Codable, Equatable, Sendable {
    let slug: String
    let name: String?
}

struct RecentNavigationState: Codable, Equatable, Sendable {
    let workspace: RecentWorkspaceReference?
    let threadsByWorkspace: [String: String?]

    static let empty = RecentNavigationState(workspace: nil, threadsByWorkspace: [:])

    init(workspace: RecentWorkspaceReference?, threadsByWorkspace: [String: String?]) {
        self.workspace = workspace
        self.threadsByWorkspace = threadsByWorkspace
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        workspace = try container.decodeIfPresent(RecentWorkspaceReference.self, forKey: .workspace)
        threadsByWorkspace = try container.decodeIfPresent(
            [String: String?].self,
            forKey: .threadsByWorkspace
        ) ?? [:]
    }
}
