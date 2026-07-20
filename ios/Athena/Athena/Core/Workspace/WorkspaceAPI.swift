import Foundation

private struct WorkspaceListResponse: Decodable {
    let workspaces: [WorkspaceDTO]
}

private struct WorkspaceThreadsResponse: Decodable {
    let threads: [WorkspaceThreadDTO]
}

private struct WorkspaceCreationRequest: Encodable {
    let name: String
    let sourceActionId: String
}

private struct ThreadCreationRequest: Encodable {
    let sourceActionId: String
}

private struct DefaultThreadsDTO: Decodable {
    let threads: [WorkspaceThreadDTO]?
}

private struct WorkspaceCreationResponse: Decodable {
    let workspace: WorkspaceDTO?
    let message: String?
    let defaultThreads: DefaultThreadsDTO?
}

private struct ThreadCreationResponse: Decodable {
    let thread: WorkspaceThreadDTO?
    let message: String?
}

private struct WorkspaceThreadUpdateResponse: Decodable {
    let thread: WorkspaceThreadDTO?
    let message: String?
}

private struct WorkspaceThreadModelUpdateRequest: Encodable {
    let chatModel: String
    let sourceActionId: String
}

private struct WorkspaceModelUpdateRequest: Encodable {
    let chatModel: String
    let sourceActionId: String
}

private struct WorkspaceRenameRequest: Encodable {
    let name: String
    let sourceActionId: String
}

private struct ThreadRenameRequest: Encodable {
    let title: String
    let sourceActionId: String
}

private struct MutationDeleteRequest: Encodable {
    let sourceActionId: String
}

private struct ChatForkRequest: Encodable {
    let chatId: Int?
    let publicChatId: String?
    let threadSlug: String?
    let sourceActionId: String
}

private struct ChatForkResponse: Decodable {
    let newThreadSlug: String
    let newThread: WorkspaceThreadDTO?
}

private struct WorkspaceUpdateResponse: Decodable {
    let workspace: WorkspaceDTO?
    let message: String?
    let replayed: Bool?
    let pending: Bool?
}

private struct MutationDeleteResponse: Decodable {
    let success: Bool?
    let accepted: Bool?
    let replayed: Bool?
    let pending: Bool?
    let error: String?
}

private struct ThreadBootstrapResponse: Decodable {
    let success: Bool
    let workspace: WorkspaceDTO
    let thread: WorkspaceThreadDTO
    let history: [ChatHistoryItemDTO]
    let page: ChatHistoryPageDTO?
    let historyFingerprint: String?
    let historyRevision: Int?
}

private struct WorkspaceBootstrapResponse: Decodable {
    let success: Bool
    let workspace: WorkspaceDTO
    let history: [ChatHistoryItemDTO]
    let page: ChatHistoryPageDTO?
}

private struct ThreadHistoryResponse: Decodable {
    let history: [ChatHistoryItemDTO]
    let page: ChatHistoryPageDTO?
    let historyFingerprint: String?
    let historyRevision: Int?
}

struct ThreadFingerprintRequest: Encodable, Equatable, Sendable {
    let workspaceSlug: String
    let threadSlug: String
    let fingerprint: String?
}

struct ThreadFingerprintResult: Decodable, Equatable, Sendable {
    let workspaceSlug: String
    let threadSlug: String
    let status: String
    let historyFingerprint: String?
    let historyRevision: Int?
    let latestChatId: Int?
    let latestChatAt: String?
}

private struct ThreadFingerprintManifestRequest: Encodable {
    let threads: [ThreadFingerprintRequest]
}

private struct ThreadFingerprintManifestResponse: Decodable {
    let success: Bool
    let checkedAt: String
    let threads: [ThreadFingerprintResult]
}

private struct ChatHistoryPageDTO: Decodable {
    let limit: Int?
    let olderBeforeChatID: Int?
    let newerAfterChatID: Int?
    let hasMore: Bool?
    let hasOlder: Bool?
    let hasNewer: Bool?

    enum CodingKeys: String, CodingKey {
        case limit
        case olderBeforeChatID = "olderBeforeChatId"
        case nextBeforeChatID = "nextBeforeChatId"
        case newerAfterChatID = "newerAfterChatId"
        case nextAfterChatID = "nextAfterChatId"
        case hasMore
        case hasOlder
        case hasNewer
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        limit = try container.decodeIfPresent(Int.self, forKey: .limit)
        olderBeforeChatID = try container.decodeIfPresent(Int.self, forKey: .olderBeforeChatID)
            ?? container.decodeIfPresent(Int.self, forKey: .nextBeforeChatID)
        newerAfterChatID = try container.decodeIfPresent(Int.self, forKey: .newerAfterChatID)
            ?? container.decodeIfPresent(Int.self, forKey: .nextAfterChatID)
        hasMore = try container.decodeIfPresent(Bool.self, forKey: .hasMore)
        hasOlder = try container.decodeIfPresent(Bool.self, forKey: .hasOlder)
        hasNewer = try container.decodeIfPresent(Bool.self, forKey: .hasNewer)
    }

    func domain() -> AthenaHistoryPage {
        AthenaHistoryPage(
            limit: limit ?? 20,
            olderBeforeChatID: olderBeforeChatID,
            newerAfterChatID: newerAfterChatID,
            hasOlder: hasOlder ?? hasMore ?? false,
            hasNewer: hasNewer ?? false
        )
    }
}

private struct WorkspaceDTO: Decodable {
    let id: Int
    let sourceActionId: String?
    let name: String
    let slug: String
    let chatModel: String?
    let createdAt: String?
    let lastUpdatedAt: String?

    func domain(threads: [AthenaThread] = []) -> AthenaWorkspace {
        AthenaWorkspace(
            id: slug,
            serverID: id,
            sourceActionID: sourceActionId,
            title: name,
            chatModel: chatModel.flatMap(ThreadChatModel.init(rawValue:)),
            threads: threads,
            createdAt: createdAt,
            lastUpdatedAt: lastUpdatedAt
        )
    }
}

private struct WorkspaceThreadDTO: Decodable {
    let id: Int
    let sourceActionId: String?
    let name: String
    let title: String?
    let slug: String
    let chatModel: String?
    let threadType: String?
    let createdAt: String?
    let lastUpdatedAt: String?
    let historyFingerprint: String?
    let historyRevision: Int?
    let lastChatId: Int?
    let lastChatAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case sourceActionId
        case name
        case title
        case slug
        case chatModel
        case threadType = "thread_type"
        case createdAt
        case lastUpdatedAt
        case historyFingerprint
        case historyRevision
        case lastChatId
        case lastChatAt
    }

    func domain(workspaceID: String, messages: [AthenaChatMessage] = []) -> AthenaThread {
        AthenaThread(
            id: slug,
            serverID: id,
            sourceActionID: sourceActionId,
            workspaceID: workspaceID,
            title: title?.isEmpty == false ? title! : name,
            chatModel: chatModel.flatMap(ThreadChatModel.init(rawValue:)),
            threadType: threadType,
            createdAt: createdAt,
            lastUpdatedAt: lastUpdatedAt,
            historyFingerprint: historyFingerprint,
            historyRevision: historyRevision ?? 0,
            latestChatID: lastChatId,
            latestChatAt: lastChatAt,
            messages: messages
        )
    }
}

private struct ChatHistoryItemDTO: Decodable {
    let role: String
    let content: String
    let chatID: Int?
    let publicChatID: String?
    let sentAt: Double?
    let hydrationStatus: String?
    let clientTurnID: String?

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case chatID = "chatId"
        case publicChatID = "publicChatId"
        case sentAt
        case hydrationStatus
        case clientTurnID = "clientTurnId"
    }

    func domain(threadID: String, index: Int) -> AthenaChatMessage? {
        guard let role = AthenaChatMessage.Role(rawValue: role) else {
            return nil
        }
        let serverIdentity = chatID.map(String.init) ?? publicChatID
        let messageID = serverIdentity.map { "\(threadID):\($0):\(role.rawValue)" }
            ?? "\(threadID):fallback:\(index):\(role.rawValue)"
        return AthenaChatMessage(
            id: messageID,
            role: role,
            text: content,
            chatID: chatID,
            publicChatID: publicChatID,
            sentAt: sentAt,
            hydrationStatus: hydrationStatus,
            clientTurnID: clientTurnID,
            deliveryState: .confirmed
        )
    }
}

@MainActor
final class WorkspaceAPI {
    static let historyPageLimit = 20

    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func fetchWorkspaces() async throws -> [AthenaWorkspace] {
        let response = try await apiClient.getJSON(
            WorkspaceListResponse.self,
            path: "/api/workspaces",
            authorization: .required
        )
        return response.workspaces.map { $0.domain() }
    }

    func createWorkspace(name: String, sourceActionID: String) async throws -> AthenaWorkspace {
        let response = try await apiClient.requestJSON(
            WorkspaceCreationResponse.self,
            method: .post,
            path: "/api/workspace/new",
            body: WorkspaceCreationRequest(name: name, sourceActionId: sourceActionID),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        if let message = response.message, !message.isEmpty {
            throw APIClientError.httpStatus(status: 400, code: nil, message: message)
        }
        guard let workspace = response.workspace else {
            throw APIClientError.invalidResponse
        }
        let threads = (response.defaultThreads?.threads ?? []).map {
            $0.domain(workspaceID: workspace.slug)
        }
        return workspace.domain(threads: threads)
    }

    func createThread(workspaceID: String, sourceActionID: String) async throws -> AthenaThread {
        let response = try await apiClient.requestJSON(
            ThreadCreationResponse.self,
            method: .post,
            path: "/api/workspace/\(workspaceID)/thread/new",
            body: ThreadCreationRequest(sourceActionId: sourceActionID),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        if let message = response.message, !message.isEmpty {
            throw APIClientError.httpStatus(status: 400, code: nil, message: message)
        }
        guard let thread = response.thread else {
            throw APIClientError.invalidResponse
        }
        return thread.domain(workspaceID: workspaceID)
    }

    func fetchThreads(workspaceID: String) async throws -> [AthenaThread] {
        let response = try await apiClient.getJSON(
            WorkspaceThreadsResponse.self,
            path: "/api/workspace/\(workspaceID)/threads",
            authorization: .required
        )
        return response.threads.map { $0.domain(workspaceID: workspaceID) }
    }

    func updateThreadModel(
        workspaceID: String,
        threadID: String,
        model: ThreadChatModel,
        sourceActionID: String
    ) async throws -> AthenaThread {
        let response = try await apiClient.requestJSON(
            WorkspaceThreadUpdateResponse.self,
            method: .post,
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)/update",
            body: WorkspaceThreadModelUpdateRequest(
                chatModel: model.rawValue,
                sourceActionId: sourceActionID
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        if let message = response.message, !message.isEmpty {
            throw APIClientError.httpStatus(status: 400, code: nil, message: message)
        }
        guard let thread = response.thread else {
            throw APIClientError.invalidResponse
        }
        return thread.domain(workspaceID: workspaceID)
    }

    func updateWorkspaceModel(
        workspaceID: String,
        model: ThreadChatModel,
        sourceActionID: String
    ) async throws -> AthenaWorkspace {
        let response = try await apiClient.requestJSON(
            WorkspaceUpdateResponse.self,
            method: .post,
            path: "/api/workspace/\(workspaceID)/update",
            body: WorkspaceModelUpdateRequest(
                chatModel: model.rawValue,
                sourceActionId: sourceActionID
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        if let message = response.message, !message.isEmpty {
            throw APIClientError.httpStatus(status: 400, code: nil, message: message)
        }
        guard let workspace = response.workspace else {
            throw APIClientError.invalidResponse
        }
        return workspace.domain()
    }

    func renameWorkspace(
        workspaceID: String,
        title: String,
        sourceActionID: String
    ) async throws -> AthenaWorkspace {
        let response = try await apiClient.requestJSON(
            WorkspaceUpdateResponse.self,
            method: .post,
            path: "/api/workspace/\(workspaceID)/update",
            body: WorkspaceRenameRequest(name: title, sourceActionId: sourceActionID),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        if let message = response.message, !message.isEmpty {
            throw APIClientError.httpStatus(status: 400, code: nil, message: message)
        }
        guard let workspace = response.workspace else {
            throw APIClientError.invalidResponse
        }
        return workspace.domain()
    }

    func renameThread(
        workspaceID: String,
        threadID: String,
        title: String,
        sourceActionID: String
    ) async throws -> AthenaThread {
        let response = try await apiClient.requestJSON(
            WorkspaceThreadUpdateResponse.self,
            method: .post,
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)/update",
            body: ThreadRenameRequest(title: title, sourceActionId: sourceActionID),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        if let message = response.message, !message.isEmpty {
            throw APIClientError.httpStatus(status: 400, code: nil, message: message)
        }
        guard let thread = response.thread else {
            throw APIClientError.invalidResponse
        }
        return thread.domain(workspaceID: workspaceID)
    }

    func deleteWorkspace(workspaceID: String, sourceActionID: String) async throws -> Bool {
        let response = try await apiClient.requestJSON(
            MutationDeleteResponse.self,
            method: .delete,
            path: "/api/workspace/\(workspaceID)",
            body: MutationDeleteRequest(sourceActionId: sourceActionID),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success != false else {
            throw APIClientError.httpStatus(status: 409, code: response.error, message: response.error)
        }
        return response.accepted != true && response.pending != true
    }

    func deleteThread(
        workspaceID: String,
        threadID: String,
        sourceActionID: String
    ) async throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try await apiClient.requestData(
            method: .delete,
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)",
            headers: ["Content-Type": "application/json"],
            body: try encoder.encode(MutationDeleteRequest(sourceActionId: sourceActionID)),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard !data.isEmpty else { return }
        if let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           text.caseInsensitiveCompare("OK") == .orderedSame {
            return
        }
        let response: MutationDeleteResponse
        do {
            response = try JSONDecoder().decode(MutationDeleteResponse.self, from: data)
        } catch {
            throw APIClientError.invalidResponse
        }
        guard response.success != false else {
            throw APIClientError.httpStatus(status: 409, code: response.error, message: response.error)
        }
    }

    func fetchThreadBootstrap(
        workspaceID: String,
        threadID: String
    ) async throws -> AthenaThreadHistoryPage {
        let response = try await apiClient.getJSON(
            ThreadBootstrapResponse.self,
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)/bootstrap",
            queryItems: [
                URLQueryItem(name: "limit", value: String(Self.historyPageLimit)),
                URLQueryItem(name: "detail", value: "full"),
                URLQueryItem(name: "priorityWindow", value: String(Self.historyPageLimit)),
            ],
            authorization: .required
        )
        guard response.success else {
            throw APIClientError.invalidResponse
        }
        let messages = response.history.enumerated().compactMap { index, item in
            item.domain(threadID: threadID, index: index)
        }
        return AthenaThreadHistoryPage(
            thread: response.thread.domain(workspaceID: response.workspace.slug, messages: messages),
            messages: messages,
            page: response.page?.domain() ?? .complete,
            historyFingerprint: response.historyFingerprint,
            historyRevision: response.historyRevision ?? 0
        )
    }

    func fetchOverviewBootstrap(
        workspaceID: String,
        overviewThread: AthenaThread
    ) async throws -> AthenaThreadHistoryPage {
        let response = try await apiClient.getJSON(
            WorkspaceBootstrapResponse.self,
            path: "/api/workspace/\(workspaceID)/bootstrap",
            queryItems: [
                URLQueryItem(name: "limit", value: String(Self.historyPageLimit)),
                URLQueryItem(name: "detail", value: "full"),
                URLQueryItem(name: "priorityWindow", value: String(Self.historyPageLimit)),
            ],
            authorization: .required
        )
        guard response.success else {
            throw APIClientError.invalidResponse
        }
        let messages = response.history.enumerated().compactMap { index, item in
            item.domain(threadID: overviewThread.id, index: index)
        }
        var thread = overviewThread
        thread.chatModel = response.workspace.chatModel.flatMap(ThreadChatModel.init(rawValue:))
        thread.messages = messages
        return AthenaThreadHistoryPage(
            thread: thread,
            messages: messages,
            page: response.page?.domain() ?? .complete
        )
    }

    func fetchOlderThreadHistory(
        workspaceID: String,
        threadID: String,
        beforeChatID: Int
    ) async throws -> AthenaThreadHistoryPage {
        let response = try await apiClient.getJSON(
            ThreadHistoryResponse.self,
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)/chats",
            queryItems: [
                URLQueryItem(name: "limit", value: String(Self.historyPageLimit)),
                URLQueryItem(name: "detail", value: "full"),
                URLQueryItem(name: "priorityWindow", value: String(Self.historyPageLimit)),
                URLQueryItem(name: "beforeChatId", value: String(beforeChatID)),
            ],
            authorization: .required
        )
        let messages = response.history.enumerated().compactMap { index, item in
            item.domain(threadID: threadID, index: index)
        }
        return AthenaThreadHistoryPage(
            thread: nil,
            messages: messages,
            page: response.page?.domain() ?? .complete,
            historyFingerprint: response.historyFingerprint,
            historyRevision: response.historyRevision ?? 0
        )
    }

    func fetchOlderOverviewHistory(
        workspaceID: String,
        overviewThreadID: String,
        beforeChatID: Int
    ) async throws -> AthenaThreadHistoryPage {
        let response = try await apiClient.getJSON(
            ThreadHistoryResponse.self,
            path: "/api/workspace/\(workspaceID)/chats",
            queryItems: [
                URLQueryItem(name: "limit", value: String(Self.historyPageLimit)),
                URLQueryItem(name: "detail", value: "full"),
                URLQueryItem(name: "priorityWindow", value: String(Self.historyPageLimit)),
                URLQueryItem(name: "beforeChatId", value: String(beforeChatID)),
            ],
            authorization: .required
        )
        let messages = response.history.enumerated().compactMap { index, item in
            item.domain(threadID: overviewThreadID, index: index)
        }
        return AthenaThreadHistoryPage(
            thread: nil,
            messages: messages,
            page: response.page?.domain() ?? .complete
        )
    }

    func compareThreadFingerprints(
        _ requests: [ThreadFingerprintRequest]
    ) async throws -> [ThreadFingerprintResult] {
        let response = try await apiClient.requestJSON(
            ThreadFingerprintManifestResponse.self,
            method: .post,
            path: "/api/sync/thread-fingerprints",
            body: ThreadFingerprintManifestRequest(threads: Array(requests.prefix(30))),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else {
            throw APIClientError.invalidResponse
        }
        return response.threads
    }

    func deleteChat(
        workspaceID: String,
        threadID: String?,
        chatID: Int?,
        publicChatID: String?,
        sourceActionID: String
    ) async throws {
        let identity = publicChatID ?? chatID.map(String.init)
        guard let identity, !identity.isEmpty else {
            throw APIClientError.invalidResponse
        }
        let path = threadID.map {
            "/api/workspace/\(workspaceID)/thread/\($0)/chat/\(identity)"
        } ?? "/api/workspace/\(workspaceID)/chat/\(identity)"
        _ = try await apiClient.requestData(
            method: .delete,
            path: path,
            headers: ["Content-Type": "application/json"],
            body: try JSONEncoder().encode(
                MutationDeleteRequest(sourceActionId: sourceActionID)
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
    }

    func forkChat(
        workspaceID: String,
        threadID: String?,
        chatID: Int?,
        publicChatID: String?,
        sourceActionID: String
    ) async throws -> AthenaThread {
        let response = try await apiClient.requestJSON(
            ChatForkResponse.self,
            method: .post,
            path: "/api/workspace/\(workspaceID)/thread/fork",
            body: ChatForkRequest(
                chatId: chatID,
                publicChatId: publicChatID,
                threadSlug: threadID,
                sourceActionId: sourceActionID
            ),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard let thread = response.newThread else {
            let threads = try await fetchThreads(workspaceID: workspaceID)
            guard let fetched = threads.first(where: { $0.id == response.newThreadSlug }) else {
                throw APIClientError.invalidResponse
            }
            return fetched
        }
        return thread.domain(workspaceID: workspaceID)
    }
}
