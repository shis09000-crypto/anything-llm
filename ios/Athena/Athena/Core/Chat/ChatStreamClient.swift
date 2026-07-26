import Foundation

struct ChatStreamRequest: Encodable, Sendable {
    let message: String
    let displayPrompt: String?
    let attachments: [String]
    let fileAccess: ChatStreamFileAccess
    let nodeContext: String?
    let clientTurnId: String
    let editContext: ChatStreamEditContext?
    let regenerateContext: ChatStreamRegenerateContext?

    init(
        message: String,
        clientTurnID: String,
        editContext: ChatStreamEditContext? = nil,
        regenerateContext: ChatStreamRegenerateContext? = nil
    ) {
        self.message = message
        self.displayPrompt = nil
        self.attachments = []
        self.fileAccess = ChatStreamFileAccess(mode: nil)
        self.nodeContext = nil
        self.clientTurnId = clientTurnID
        self.editContext = editContext
        self.regenerateContext = regenerateContext
    }
}

struct ChatStreamEditContext: Encodable, Equatable, Sendable {
    let startingChatId: Int
    let sourceActionId: String
}

struct ChatStreamRegenerateContext: Encodable, Equatable, Sendable {
    let targetChatId: Int
    let sourceActionId: String
}

struct ChatStreamFileAccess: Encodable, Sendable {
    let mode: String?
}

enum ChatStreamEvent: Equatable, Sendable {
    case checkpoint(revision: Int)
    case assistantText(id: String, text: String, replaces: Bool, closes: Bool)
    case finalized(chatID: Int?, publicChatID: String?, clientTurnID: String?)
    case agentInvocation(id: String, invocationID: String)
    case threadRename(title: String)
    case status(text: String)
    case editSessionReady(sourceActionID: String?, startingChatID: Int?)
    case editHistoryTruncated(sourceActionID: String?, startingChatID: Int?)
    case regenerateSessionReady(sourceActionID: String?, targetChatID: Int?)
    case regenerateTurnDeleted(sourceActionID: String?, targetChatID: Int?)
    case failure(message: String, errorCode: String?)
}

struct ChatStreamRunState: Decodable, Equatable, Sendable {
    let kind: String
    let clientTurnId: String
    let status: String
    let revision: Int
    let terminal: Bool
    let retryable: Bool
    let finalChatId: Int?
    let finalPublicChatId: String?
    let errorCode: String?
}

struct PersistedChatStreamDescriptor: Codable, Equatable, Sendable {
    let workspaceID: String
    let threadID: String
    let clientTurnID: String
    let sendsToWorkspace: Bool
    var lastRevision: Int
    var updatedAt: Date
}

struct PersistedChatStreamEnvelope: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let savedAt: Date
    let runs: [PersistedChatStreamDescriptor]

    init(
        schemaVersion: Int = Self.currentSchemaVersion,
        savedAt: Date = Date(),
        runs: [PersistedChatStreamDescriptor]
    ) {
        self.schemaVersion = schemaVersion
        self.savedAt = savedAt
        self.runs = runs
    }
}

struct ConversationStreamObservation: Encodable, Sendable {
    let event: String
    let platform = "ios_native"
    let visibility: String
    let outcome: String
    let durationMs: Int
    let clientTurnId: String
    let invocationId: String
    let runKind: String
    let transport: String
}

private struct ConversationStreamObservationResponse: Decodable, Sendable {
    let success: Bool
    let accepted: Int
}

private struct ChatStreamRunStateResponse: Decodable, Sendable {
    let success: Bool
    let run: ChatStreamRunState
}

private struct ChatStreamCancelResponse: Decodable, Sendable {
    let success: Bool
    let status: String
}

private struct ChatStreamCancelRequest: Encodable, Sendable {}

private struct ChatStreamServerError: LocalizedError {
    let message: String
    let code: String?

    var errorDescription: String? { message }
}

final class ChatStreamClient {
    private let apiClient: APIClient

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func recordObservation(_ observation: ConversationStreamObservation) async {
        _ = try? await apiClient.requestJSON(
            ConversationStreamObservationResponse.self,
            method: .post,
            path: "/api/operations/client-chat-observations",
            body: observation,
            authorization: .required
        )
    }

    func consumeThreadStream(
        workspaceID: String,
        threadID: String,
        request: ChatStreamRequest,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let path = "/api/workspace/\(workspaceID)/thread/\(threadID)/stream-chat"
        try await consumeStream(path: path, request: request, onEvent: onEvent)
    }

    func consumeWorkspaceStream(
        workspaceID: String,
        request: ChatStreamRequest,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let path = "/api/workspace/\(workspaceID)/stream-chat"
        try await consumeStream(path: path, request: request, onEvent: onEvent)
    }

    func resumeThreadStream(
        workspaceID: String,
        threadID: String,
        clientTurnID: String,
        afterRevision: Int,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let path = "/api/workspace/\(workspaceID)/thread/\(threadID)/chat-runs/\(clientTurnID)/stream"
        try await consumeResumeStream(
            path: path,
            afterRevision: afterRevision,
            onEvent: onEvent
        )
    }

    func resumeWorkspaceStream(
        workspaceID: String,
        clientTurnID: String,
        afterRevision: Int,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let path = "/api/workspace/\(workspaceID)/chat-runs/\(clientTurnID)/stream"
        try await consumeResumeStream(
            path: path,
            afterRevision: afterRevision,
            onEvent: onEvent
        )
    }

    func threadRunState(
        workspaceID: String,
        threadID: String,
        clientTurnID: String
    ) async throws -> ChatStreamRunState {
        try await runState(
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)/chat-runs/\(clientTurnID)/state"
        )
    }

    func workspaceRunState(
        workspaceID: String,
        clientTurnID: String
    ) async throws -> ChatStreamRunState {
        try await runState(
            path: "/api/workspace/\(workspaceID)/chat-runs/\(clientTurnID)/state"
        )
    }

    func cancelThreadRun(
        workspaceID: String,
        threadID: String,
        clientTurnID: String
    ) async throws {
        try await cancelRun(
            path: "/api/workspace/\(workspaceID)/thread/\(threadID)/chat-runs/\(clientTurnID)/cancel"
        )
    }

    func cancelWorkspaceRun(
        workspaceID: String,
        clientTurnID: String
    ) async throws {
        try await cancelRun(
            path: "/api/workspace/\(workspaceID)/chat-runs/\(clientTurnID)/cancel"
        )
    }

    private func consumeStream(
        path: String,
        request: ChatStreamRequest,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let (bytes, _) = try await apiClient.openJSONStream(path: path, body: request)
        try await consume(bytes: bytes, onEvent: onEvent)
    }

    private func consumeResumeStream(
        path: String,
        afterRevision: Int,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let (bytes, _) = try await apiClient.openEventStream(
            path: path,
            queryItems: [
                URLQueryItem(
                    name: "afterRevision",
                    value: String(max(0, afterRevision))
                ),
            ]
        )
        try await consume(bytes: bytes, onEvent: onEvent)
    }

    private func consume(
        bytes: URLSession.AsyncBytes,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        for try await line in bytes.lines {
            try Task.checkCancellation()
            let normalizedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard normalizedLine.hasPrefix("data:") else {
                continue
            }
            var eventLines = [
                String(normalizedLine.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            ]
            try await emit(dataLines: &eventLines, onEvent: onEvent)
        }
    }

    private func runState(path: String) async throws -> ChatStreamRunState {
        let response = try await apiClient.getJSON(
            ChatStreamRunStateResponse.self,
            path: path,
            authorization: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else {
            throw APIClientError.invalidResponse
        }
        return response.run
    }

    private func cancelRun(path: String) async throws {
        let response = try await apiClient.requestJSON(
            ChatStreamCancelResponse.self,
            method: .post,
            path: path,
            body: ChatStreamCancelRequest(),
            authorization: .required,
            signing: .required
        )
        guard response.success, response.status == "cancelling" else {
            throw APIClientError.invalidResponse
        }
    }

    private func emit(
        dataLines: inout [String],
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        guard !dataLines.isEmpty else {
            return
        }
        defer { dataLines.removeAll(keepingCapacity: true) }
        let payloadText = dataLines.joined(separator: "\n")
        guard let data = payloadText.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let message = "无法解析服务器流式响应。"
            await onEvent(.failure(message: message, errorCode: "invalid_sse_payload"))
            throw ChatStreamServerError(message: message, code: "invalid_sse_payload")
        }

        let id = string(payload["id"]) ?? string(payload["uuid"]) ?? UUID().uuidString.lowercased()
        let type = string(payload["type"]) ?? ""
        if let revision = integer(payload["runRevision"]), revision > 0 {
            await onEvent(.checkpoint(revision: revision))
        }
        switch type {
        case "textResponse", "textResponseChunk", "fullTextResponse":
            await onEvent(
                .assistantText(
                    id: id,
                    text: string(payload["textResponse"]) ?? string(payload["content"]) ?? "",
                    replaces: type != "textResponseChunk",
                    closes: bool(payload["close"])
                )
            )
        case "finalizeResponseStream":
            await onEvent(
                .finalized(
                    chatID: integer(payload["chatId"]),
                    publicChatID: string(payload["publicChatId"]),
                    clientTurnID: string(payload["clientTurnId"])
                )
            )
        case "agentInitWebsocketConnection":
            guard let invocationID = string(payload["websocketUUID"]), !invocationID.isEmpty else {
                let message = "Agent 会话缺少 invocation ID。"
                await onEvent(.failure(message: message, errorCode: "agent_invocation_missing"))
                throw ChatStreamServerError(message: message, code: "agent_invocation_missing")
            }
            await onEvent(.agentInvocation(id: id, invocationID: invocationID))
        case "editSessionReady":
            await onEvent(
                .editSessionReady(
                    sourceActionID: string(payload["sourceActionId"]),
                    startingChatID: integer(payload["startingChatId"])
                )
            )
        case "editHistoryTruncated":
            await onEvent(
                .editHistoryTruncated(
                    sourceActionID: string(payload["sourceActionId"]),
                    startingChatID: integer(payload["startingChatId"])
                )
            )
        case "regenerateSessionReady":
            await onEvent(
                .regenerateSessionReady(
                    sourceActionID: string(payload["sourceActionId"]),
                    targetChatID: integer(payload["targetChatId"])
                )
            )
        case "regenerateTurnDeleted":
            await onEvent(
                .regenerateTurnDeleted(
                    sourceActionID: string(payload["sourceActionId"]),
                    targetChatID: integer(payload["targetChatId"])
                )
            )
        case "statusResponse":
            if let text = string(payload["textResponse"]), !text.isEmpty {
                await onEvent(.status(text: text))
            }
        case "abort":
            let message = string(payload["error"]) ?? "服务器终止了本次回复。"
            let errorCode = string(payload["errorCode"])
            await onEvent(.failure(message: message, errorCode: errorCode))
            throw ChatStreamServerError(message: message, code: errorCode)
        default:
            if string(payload["action"]) == "rename_thread",
               let thread = payload["thread"] as? [String: Any],
               let title = string(thread["title"]) ?? string(thread["name"])
            {
                await onEvent(.threadRename(title: title))
            }
        }
    }

    private func string(_ value: Any?) -> String? {
        switch value {
        case let value as String:
            value
        case let value as NSNumber:
            value.stringValue
        default:
            nil
        }
    }

    private func bool(_ value: Any?) -> Bool {
        switch value {
        case let value as Bool:
            value
        case let value as NSNumber:
            value.boolValue
        default:
            false
        }
    }

    private func integer(_ value: Any?) -> Int? {
        switch value {
        case let value as Int:
            value
        case let value as NSNumber:
            value.intValue
        case let value as String:
            Int(value)
        default:
            nil
        }
    }
}
