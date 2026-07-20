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

    private func consumeStream(
        path: String,
        request: ChatStreamRequest,
        onEvent: @escaping @MainActor (ChatStreamEvent) -> Void
    ) async throws {
        let (bytes, _) = try await apiClient.openJSONStream(path: path, body: request)

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
