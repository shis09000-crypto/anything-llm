import Foundation
import Observation

struct AgentEvent: Identifiable, Hashable {
    enum Kind: String {
        case approval
        case clarification
        case running
        case stopped
    }

    let id: String
    let title: String
    let detail: String
    var kind: Kind
}

enum AgentSessionPhase: String, Codable, Equatable, Sendable {
    case idle
    case connecting
    case open
    case reconnecting
    case waitingOnInput
    case stopping
    case finalized
    case closed
    case failed

    var isTerminal: Bool {
        self == .finalized || self == .closed || self == .failed
    }
}

struct AgentClarificationQuestion: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let question: String
    let options: [String]
    let optionDescriptions: [String]
    let allowOther: Bool

    init(
        id: String,
        question: String,
        options: [String] = [],
        optionDescriptions: [String] = [],
        allowOther: Bool = true
    ) {
        self.id = id
        self.question = question
        self.options = options
        self.optionDescriptions = optionDescriptions
        self.allowOther = allowOther
    }
}

struct AgentTimelineEvent: Codable, Equatable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case thought
        case toolCall
        case toolResult
        case approval
        case clarification
        case status
        case error
    }

    let id: String
    let sequence: Int
    let kind: Kind
    let title: String
    let detail: String
    let requestID: String?
    let questions: [AgentClarificationQuestion]
    let allowSkip: Bool?
    let timeoutMs: Int?
    let requestedAtMs: Double?

    init(
        id: String,
        sequence: Int,
        kind: Kind,
        title: String,
        detail: String,
        requestID: String?,
        questions: [AgentClarificationQuestion],
        allowSkip: Bool? = nil,
        timeoutMs: Int? = nil,
        requestedAtMs: Double? = nil
    ) {
        self.id = id
        self.sequence = sequence
        self.kind = kind
        self.title = title
        self.detail = detail
        self.requestID = requestID
        self.questions = questions
        self.allowSkip = allowSkip
        self.timeoutMs = timeoutMs
        self.requestedAtMs = requestedAtMs
    }
}

struct AgentSessionSnapshot: Codable, Equatable, Identifiable, Sendable {
    var id: String { invocationID }

    let invocationID: String
    let workspaceID: String
    let threadID: String
    var clientTurnID: String?
    var phase: AgentSessionPhase
    var lastEventSequence: Int
    var retryCount: Int
    var assistantText: String
    var finalChatID: Int?
    var finalPublicChatID: String?
    var events: [AgentTimelineEvent]
    var updatedAt: Date
}

@MainActor
@Observable
final class AgentSessionRenderStore {
    let invocationID: String
    let workspaceID: String
    let threadID: String
    private(set) var clientTurnID: String?
    private(set) var phase: AgentSessionPhase
    private(set) var lastEventSequence: Int
    private(set) var retryCount: Int
    private(set) var assistantText: String
    private(set) var hasAssistantContent: Bool
    private(set) var finalChatID: Int?
    private(set) var finalPublicChatID: String?
    private(set) var events: [AgentTimelineEvent]
    private(set) var updatedAt: Date

    init(session: AgentSessionSnapshot) {
        invocationID = session.invocationID
        workspaceID = session.workspaceID
        threadID = session.threadID
        clientTurnID = session.clientTurnID
        phase = session.phase
        lastEventSequence = session.lastEventSequence
        retryCount = session.retryCount
        assistantText = session.assistantText
        hasAssistantContent = !session.assistantText.isEmpty
        finalChatID = session.finalChatID
        finalPublicChatID = session.finalPublicChatID
        events = session.events
        updatedAt = session.updatedAt
    }

    func update(session: AgentSessionSnapshot) {
        if clientTurnID != session.clientTurnID {
            clientTurnID = session.clientTurnID
        }
        if phase != session.phase {
            phase = session.phase
        }
        if lastEventSequence != session.lastEventSequence {
            lastEventSequence = session.lastEventSequence
        }
        if retryCount != session.retryCount {
            retryCount = session.retryCount
        }
        if assistantText != session.assistantText {
            assistantText = session.assistantText
        }
        let nextHasAssistantContent = !session.assistantText.isEmpty
        if hasAssistantContent != nextHasAssistantContent {
            hasAssistantContent = nextHasAssistantContent
        }
        if finalChatID != session.finalChatID {
            finalChatID = session.finalChatID
        }
        if finalPublicChatID != session.finalPublicChatID {
            finalPublicChatID = session.finalPublicChatID
        }
        if events != session.events {
            events = session.events
        }
        if updatedAt != session.updatedAt {
            updatedAt = session.updatedAt
        }
    }

    var snapshot: AgentSessionSnapshot {
        AgentSessionSnapshot(
            invocationID: invocationID,
            workspaceID: workspaceID,
            threadID: threadID,
            clientTurnID: clientTurnID,
            phase: phase,
            lastEventSequence: lastEventSequence,
            retryCount: retryCount,
            assistantText: assistantText,
            finalChatID: finalChatID,
            finalPublicChatID: finalPublicChatID,
            events: events,
            updatedAt: updatedAt
        )
    }
}

struct PersistedAgentSessionDescriptor: Codable, Equatable, Sendable {
    let invocationID: String
    let workspaceID: String
    let threadID: String
    let clientTurnID: String?
    let lastEventSequence: Int
    let phase: AgentSessionPhase
    let updatedAt: Date
}

struct PersistedAgentSessionEnvelope: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let savedAt: Date
    let sessions: [PersistedAgentSessionDescriptor]

    init(
        schemaVersion: Int = Self.currentSchemaVersion,
        savedAt: Date = Date(),
        sessions: [PersistedAgentSessionDescriptor]
    ) {
        self.schemaVersion = schemaVersion
        self.savedAt = savedAt
        self.sessions = sessions
    }
}

struct AgentClarificationAnswer: Codable, Equatable, Sendable {
    let questionId: String
    let answer: String
}

@MainActor
@Observable
final class AgentControlKit {
    var events: [AgentEvent]
    var sessions: [AgentSessionSnapshot] = [] {
        didSet {
            synchronizeSessionRenderStores()
        }
    }
    @ObservationIgnored private var sessionRenderStoresByInvocationID: [
        String: AgentSessionRenderStore
    ] = [:]
    @ObservationIgnored private var latestSessionInvocationIDByThreadID: [
        String: String
    ] = [:]
    private(set) var sessionListRevision: UInt64 = 0
    var webSocketPathTemplate = "/api/agent-invocation/:uuid"
    var statePathTemplate = "/api/agent-invocation/:uuid/state"
    var lastError: String?

    var onSessionFinalized: ((AgentSessionSnapshot) -> Void)?
    var onSessionFailed: ((AgentSessionSnapshot, String) -> Void)?
    var onThreadRenamed: ((String, String, String) -> Void)?

    private let apiClient: APIClient?
    private let taskScheduler: TaskScheduler?
    private let requestSigningCenter: RequestSigningCenter?
    private let clientIdentityCenter: ClientIdentityCenter?
    private let localCache: LocalCache?
    private var ownerScope: String?
    private var connectionHandles: [String: ScheduledTaskHandle<Void>] = [:]
    private var sockets: [String: URLSessionWebSocketTask] = [:]
    private var applicationBackgrounded = false

    init(
        events: [AgentEvent] = PreviewData.agentEvents,
        apiClient: APIClient? = nil,
        taskScheduler: TaskScheduler? = nil,
        requestSigningCenter: RequestSigningCenter? = nil,
        clientIdentityCenter: ClientIdentityCenter? = nil,
        localCache: LocalCache? = nil
    ) {
        self.events = events
        self.apiClient = apiClient
        self.taskScheduler = taskScheduler
        self.requestSigningCenter = requestSigningCenter
        self.clientIdentityCenter = clientIdentityCenter
        self.localCache = localCache
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        webSocketPathTemplate = bootstrap?.endpoints.agentWebSocketPathTemplate ?? "/api/agent-invocation/:uuid"
        statePathTemplate = bootstrap?.endpoints.agentStatePathTemplate ?? "/api/agent-invocation/:uuid/state"
    }

    func markApproved(_ event: AgentEvent) {
        update(event, kind: .running)
    }

    func markStopped(_ event: AgentEvent) {
        update(event, kind: .stopped)
    }

    func session(for threadID: String) -> AgentSessionSnapshot? {
        sessions
            .filter { $0.threadID == threadID }
            .sorted { $0.updatedAt > $1.updatedAt }
            .first
    }

    func sessionRenderStore(for threadID: String) -> AgentSessionRenderStore? {
        guard let invocationID = latestSessionInvocationIDByThreadID[threadID] else {
            return nil
        }
        return sessionRenderStoresByInvocationID[invocationID]
    }

    func restorePersistedSessions(ownerScope: String) async {
        guard let apiClient, let localCache else {
            return
        }
        self.ownerScope = ownerScope
        let descriptors = localCache.loadAgentSessionDescriptors(
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        sessions = descriptors.map {
            AgentSessionSnapshot(
                invocationID: $0.invocationID,
                workspaceID: $0.workspaceID,
                threadID: $0.threadID,
                clientTurnID: $0.clientTurnID,
                phase: $0.phase.isTerminal ? .closed : .reconnecting,
                lastEventSequence: $0.lastEventSequence,
                retryCount: 0,
                assistantText: "",
                finalChatID: nil,
                finalPublicChatID: nil,
                events: [],
                updatedAt: $0.updatedAt
            )
        }
        for descriptor in descriptors where !descriptor.phase.isTerminal {
            await hydrateAndResume(invocationID: descriptor.invocationID)
        }
    }

    func startSession(
        invocationID: String,
        workspaceID: String,
        threadID: String,
        clientTurnID: String? = nil
    ) async {
        guard !invocationID.isEmpty else {
            return
        }
        if let index = sessionIndex(invocationID) {
            sessions[index].phase = .connecting
            sessions[index].clientTurnID = clientTurnID ?? sessions[index].clientTurnID
            sessions[index].updatedAt = Date()
        } else {
            sessions.append(
                AgentSessionSnapshot(
                    invocationID: invocationID,
                    workspaceID: workspaceID,
                    threadID: threadID,
                    clientTurnID: clientTurnID,
                    phase: .connecting,
                    lastEventSequence: 0,
                    retryCount: 0,
                    assistantText: "",
                    finalChatID: nil,
                    finalPublicChatID: nil,
                    events: [],
                    updatedAt: Date()
                )
            )
        }
        persistSessions()
        await connect(invocationID: invocationID)
    }

    func respondToApproval(
        invocationID: String,
        requestID: String,
        approved: Bool
    ) async throws {
        let payload = AgentApprovalPayload(
            type: "toolApprovalResponse",
            requestId: requestID,
            approved: approved
        )
        do {
            try await sendSigned(payload, invocationID: invocationID)
        } catch {
            guard let apiClient else { throw error }
            let response = try await apiClient.requestJSON(
                AgentActionResponse.self,
                method: .post,
                path: path(from: webSocketPathTemplate, invocationID: invocationID) + "/tool-approval-response",
                body: payload,
                authorization: .required,
                signing: .required
            )
            guard response.success else { throw APIClientError.invalidResponse }
            markRequestHandled(invocationID: invocationID, requestID: requestID)
        }
    }

    func respondToClarification(
        invocationID: String,
        requestID: String,
        answers: [AgentClarificationAnswer],
        skipped: Bool = false
    ) async throws {
        let payload = AgentClarificationPayload(
            type: "clarificationResponse",
            requestId: requestID,
            skipped: skipped,
            answers: answers
        )
        do {
            try await sendSigned(payload, invocationID: invocationID)
        } catch {
            guard let apiClient else {
                throw error
            }
            let response = try await apiClient.requestJSON(
                AgentActionResponse.self,
                method: .post,
                path: path(from: webSocketPathTemplate, invocationID: invocationID) + "/clarification-response",
                body: payload,
                authorization: .required,
                signing: .required
            )
            guard response.success else {
                throw APIClientError.invalidResponse
            }
            markRequestHandled(invocationID: invocationID, requestID: requestID)
        }
    }

    @discardableResult
    func stop(invocationID: String) async -> Bool {
        setPhase(.stopping, invocationID: invocationID)
        guard let apiClient else {
            setFailure("无法确认停止 Agent。", invocationID: invocationID)
            return false
        }
        do {
            let response = try await apiClient.requestJSON(
                AgentActionResponse.self,
                method: .post,
                path: path(from: webSocketPathTemplate, invocationID: invocationID) + "/stop",
                body: AgentStopPayload(),
                authorization: .required,
                signing: .required
            )
            guard response.success, response.closed != false else {
                throw APIClientError.invalidResponse
            }
            sockets[invocationID]?.cancel(with: .normalClosure, reason: nil)
            sockets[invocationID] = nil
            connectionHandles[invocationID]?.cancel()
            connectionHandles[invocationID] = nil
            setPhase(.closed, invocationID: invocationID)
            persistSessions()
            return true
        } catch {
            setFailure(error.localizedDescription, invocationID: invocationID)
            return false
        }
    }

    func completeReconciliation(invocationID: String) {
        guard let index = sessionIndex(invocationID), sessions[index].phase == .finalized else {
            return
        }
        sessions.remove(at: index)
        persistSessions()
    }

    func resume(invocationID: String) async {
        guard let index = sessionIndex(invocationID) else {
            return
        }
        sessions[index].phase = .reconnecting
        sessions[index].retryCount = 0
        sessions[index].updatedAt = Date()
        persistSessions()
        await hydrateAndResume(invocationID: invocationID)
    }

    func setApplicationBackgrounded(_ backgrounded: Bool) async {
        applicationBackgrounded = backgrounded
        if backgrounded {
            for (invocationID, socket) in sockets {
                socket.cancel(with: .goingAway, reason: nil)
                if let index = sessionIndex(invocationID), !sessions[index].phase.isTerminal {
                    sessions[index].phase = .reconnecting
                }
            }
            for handle in connectionHandles.values {
                handle.cancel()
            }
            sockets.removeAll()
            connectionHandles.removeAll()
            persistSessions()
            return
        }

        for session in sessions where !session.phase.isTerminal {
            await connect(invocationID: session.invocationID)
        }
    }

    func signOut(clearPersistedState: Bool = true) {
        for socket in sockets.values {
            socket.cancel(with: .normalClosure, reason: nil)
        }
        for handle in connectionHandles.values {
            handle.cancel()
        }
        sockets.removeAll()
        connectionHandles.removeAll()
        if clearPersistedState,
           let ownerScope,
           let apiClient,
           let localCache
        {
            localCache.clearAgentSessionDescriptors(
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL
            )
        }
        ownerScope = nil
        sessions = []
    }

    private func update(_ event: AgentEvent, kind: AgentEvent.Kind) {
        guard let index = events.firstIndex(where: { $0.id == event.id }) else {
            return
        }
        events[index].kind = kind
    }

    private func hydrateAndResume(invocationID: String) async {
        guard let apiClient, let taskScheduler else {
            return
        }
        let stateTemplate = statePathTemplate
        do {
            let response = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: "agent:state",
                    kind: "agent-state",
                    priority: .p0,
                    intentRank: 20,
                    policy: .foreground,
                    resource: .network,
                    scope: agentScope(invocationID: invocationID, transport: "http"),
                    dedupeKey: "agent:state:\(invocationID)"
                )
            ) { [apiClient, stateTemplate] context in
                try context.checkCancellation()
                return try await apiClient.getJSON(
                    AgentStateResponse.self,
                    path: Self.path(from: stateTemplate, invocationID: invocationID),
                    authorization: .required
                )
            }
            if let sequence = response.state.latestSeq {
                updateSequence(sequence, invocationID: invocationID)
            }
            guard response.success, response.state.retryable != false, response.state.closed != true else {
                setPhase(.closed, invocationID: invocationID)
                persistSessions()
                return
            }
            await connect(invocationID: invocationID)
        } catch {
            setFailure(error.localizedDescription, invocationID: invocationID)
        }
    }

    private func connect(invocationID: String) async {
        guard !applicationBackgrounded,
              connectionHandles[invocationID] == nil,
              let taskScheduler else {
            return
        }
        do {
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    label: "agent:websocket",
                    kind: "agent-websocket",
                    priority: .p0,
                    intentRank: 0,
                    policy: .realtime,
                    resource: .realtime,
                    scope: agentScope(invocationID: invocationID, transport: "websocket"),
                    dedupeKey: "agent:websocket:\(invocationID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { [weak self] context in
                try context.checkCancellation()
                guard let self else {
                    throw CancellationError()
                }
                try await self.runConnection(invocationID: invocationID)
            }
            connectionHandles[invocationID] = handle
            Task { @MainActor [weak self] in
                _ = try? await handle.value
                guard self?.connectionHandles[invocationID]?.id == handle.id else {
                    return
                }
                self?.connectionHandles[invocationID] = nil
            }
        } catch {
            setFailure(error.localizedDescription, invocationID: invocationID)
        }
    }

    private func runConnection(invocationID: String) async throws {
        guard let apiClient else {
            throw APIClientError.invalidResponse
        }
        let reconnectDelays: [UInt64] = [1, 2, 4, 8, 12]
        var attempt = 0

        while !Task.isCancelled {
            if applicationBackgrounded {
                return
            }
            guard let index = sessionIndex(invocationID), !sessions[index].phase.isTerminal else {
                return
            }
            let lastSequence = sessions[index].lastEventSequence
            setPhase(attempt == 0 ? .connecting : .reconnecting, invocationID: invocationID)
            sessions[index].retryCount = attempt
            let socket = try apiClient.makeAuthenticatedWebSocketTask(
                path: path(from: webSocketPathTemplate, invocationID: invocationID),
                queryItems: lastSequence > 0 || attempt > 0
                    ? [
                        URLQueryItem(name: "resume", value: "1"),
                        URLQueryItem(name: "lastEventSeq", value: String(lastSequence)),
                    ]
                    : []
            )
            sockets[invocationID] = socket
            socket.resume()
            setPhase(.open, invocationID: invocationID)

            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    try Task.checkCancellation()
                    let data: Data
                    switch message {
                    case .data(let value):
                        data = value
                    case .string(let value):
                        data = Data(value.utf8)
                    @unknown default:
                        continue
                    }
                    applySocketEventData(data, invocationID: invocationID)
                    if sessionIndex(invocationID).map({ sessions[$0].phase.isTerminal }) == true {
                        socket.cancel(with: .normalClosure, reason: nil)
                        sockets[invocationID] = nil
                        return
                    }
                }
            } catch {
                sockets[invocationID] = nil
                if Task.isCancelled || applicationBackgrounded {
                    return
                }
                attempt += 1
                guard attempt <= reconnectDelays.count else {
                    setFailure(error.localizedDescription, invocationID: invocationID)
                    throw error
                }
                setPhase(.reconnecting, invocationID: invocationID)
                try await Task.sleep(for: .seconds(Double(reconnectDelays[attempt - 1])))
            }
        }
    }

    func applySocketEventData(_ data: Data, invocationID: String) {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        let sequence = int(raw["seq"])
        if sequence > 0 {
            guard let index = sessionIndex(invocationID), sequence > sessions[index].lastEventSequence else {
                return
            }
            updateSequence(sequence, invocationID: invocationID)
        }
        let type = string(raw["type"])
        if type == nil {
            appendAssistant(string(raw["content"]) ?? "", invocationID: invocationID)
            finalize(invocationID: invocationID)
            return
        }

        switch type {
        case "agentReplayStart", "agentReplayEnd":
            if let latest = raw["latestSeq"] {
                updateSequence(int(latest), invocationID: invocationID)
            }
        case "WAITING_ON_INPUT":
            setPhase(.waitingOnInput, invocationID: invocationID)
        case "toolApprovalRequest":
            let requestID = string(raw["requestId"])
            appendTimeline(
                kind: .approval,
                sequence: sequence,
                title: "需要工具授权",
                detail: string(raw["description"]) ?? string(raw["skillName"]) ?? "Agent 请求使用工具。",
                requestID: requestID,
                questions: [],
                invocationID: invocationID
            )
            setPhase(.waitingOnInput, invocationID: invocationID)
        case "clarificationRequest":
            let questions = (raw["questions"] as? [[String: Any]] ?? []).prefix(3).enumerated().map { offset, item in
                AgentClarificationQuestion(
                    id: string(item["id"]) ?? "question-\(offset)",
                    question: String((string(item["question"]) ?? "").prefix(150)),
                    options: (item["options"] as? [Any] ?? []).prefix(3).compactMap(string),
                    optionDescriptions: (item["optionDescriptions"] as? [Any] ?? []).prefix(3).compactMap(string),
                    allowOther: bool(item["allowOther"]) || item["allowOther"] == nil
                )
            }
            appendTimeline(
                kind: .clarification,
                sequence: sequence,
                title: "需要补充信息",
                detail: questions.map(\.question).joined(separator: "\n"),
                requestID: string(raw["requestId"]),
                questions: questions,
                allowSkip: bool(raw["allowSkip"]),
                timeoutMs: int(raw["timeoutMs"]),
                requestedAtMs: double(raw["requestedAt"]),
                invocationID: invocationID
            )
            setPhase(.waitingOnInput, invocationID: invocationID)
        case "toolApprovalResolved", "clarificationResolved":
            if let requestID = string(raw["requestId"]) {
                markRequestHandled(invocationID: invocationID, requestID: requestID)
            }
        case "statusResponse":
            appendTimeline(
                kind: .thought,
                sequence: sequence,
                title: "思考过程",
                detail: string(raw["content"]) ?? "",
                requestID: nil,
                questions: [],
                invocationID: invocationID
            )
        case "reportStreamEvent":
            handleReportEvent(raw["content"] as? [String: Any] ?? [:], invocationID: invocationID)
        case "chatId":
            let content = raw["content"] as? [String: Any] ?? raw
            updateFinalIdentifiers(content, invocationID: invocationID)
            finalize(invocationID: invocationID)
        case "rename_thread", "thread_rename":
            let content = (raw["content"] as? [String: Any])
                ?? (raw["thread"] as? [String: Any])
                ?? raw
            applyThreadRename(content, invocationID: invocationID)
        case "fileDownloadCard", "rechartVisualize":
            appendTimeline(
                kind: .toolResult,
                sequence: sequence,
                title: type == "fileDownloadCard" ? "文件已生成" : "图表已生成",
                detail: "Agent 已完成工具输出。",
                requestID: nil,
                questions: [],
                invocationID: invocationID
            )
        case "wssFailure":
            setFailure(string(raw["content"]) ?? "Agent 连接失败。", invocationID: invocationID)
        default:
            if let content = string(raw["content"]), !content.isEmpty {
                appendTimeline(
                    kind: .thought,
                    sequence: sequence,
                    title: "Agent 状态",
                    detail: content,
                    requestID: nil,
                    questions: [],
                    invocationID: invocationID
                )
            }
        }
        persistSessions()
    }

    private func applyThreadRename(_ payload: [String: Any], invocationID: String) {
        guard let index = sessionIndex(invocationID),
              let title = string(payload["title"]) ?? string(payload["name"])
        else {
            return
        }
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty else {
            return
        }
        onThreadRenamed?(
            sessions[index].workspaceID,
            sessions[index].threadID,
            normalizedTitle
        )
    }

    private func handleReportEvent(_ content: [String: Any], invocationID: String) {
        let sequence = int(content["seq"])
        switch string(content["type"]) {
        case "textResponseChunk":
            appendAssistant(string(content["content"]) ?? "", invocationID: invocationID)
            if bool(content["close"]) {
                updateFinalIdentifiers(content, invocationID: invocationID)
            }
        case "fullTextResponse":
            replaceAssistant(string(content["content"]) ?? "", invocationID: invocationID)
            updateFinalIdentifiers(content, invocationID: invocationID)
        case "toolCallInvocation":
            guard let toolName = resolvedToolName(from: content) else {
                return
            }
            appendTimeline(
                kind: .toolCall,
                sequence: sequence,
                title: "使用工具 · \(toolName)",
                detail: String((string(content["content"]) ?? "").prefix(500)),
                requestID: nil,
                questions: [],
                invocationID: invocationID
            )
        case "toolCallResult":
            appendTimeline(
                kind: .toolResult,
                sequence: sequence,
                title: "工具执行完成",
                detail: String((string(content["summary"]) ?? string(content["content"]) ?? "").prefix(500)),
                requestID: nil,
                questions: [],
                invocationID: invocationID
            )
        case "statusResponse":
            appendTimeline(
                kind: .thought,
                sequence: sequence,
                title: "思考过程",
                detail: String((string(content["content"]) ?? "").prefix(500)),
                requestID: nil,
                questions: [],
                invocationID: invocationID
            )
        case "chatId":
            updateFinalIdentifiers(content, invocationID: invocationID)
            finalize(invocationID: invocationID)
        default:
            break
        }
    }

    private func resolvedToolName(from content: [String: Any]) -> String? {
        if let explicit = string(content["toolName"])?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !explicit.isEmpty {
            return explicit
        }

        let detail = (string(content["content"]) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !detail.hasPrefix("Assembling Tool Call:") else {
            return nil
        }
        for prefix in ["Parsed Tool Call:", "Tool Call:", "Calling "] {
            guard detail.hasPrefix(prefix) else { continue }
            let remainder = detail.dropFirst(prefix.count)
            let name = remainder.prefix { character in
                character != "(" && character != "." && !character.isWhitespace
            }
            let normalized = String(name)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? nil : normalized
        }
        return nil
    }

    private func sendSigned<Payload: Encodable>(
        _ payload: Payload,
        invocationID: String
    ) async throws {
        guard let socket = sockets[invocationID],
              let url = socket.originalRequest?.url,
              let requestSigningCenter,
              let clientIdentityCenter else {
            throw APIClientError.invalidResponse
        }
        let data = try requestSigningCenter.signedWebSocketMessage(
            payload: payload,
            url: url,
            clientID: clientIdentityCenter.clientID
        )
        try await socket.send(.data(data))
        setPhase(.open, invocationID: invocationID)
    }

    private func appendAssistant(_ text: String, invocationID: String) {
        guard !text.isEmpty, let index = sessionIndex(invocationID) else {
            return
        }
        sessions[index].assistantText += text
        sessions[index].updatedAt = Date()
    }

    private func replaceAssistant(_ text: String, invocationID: String) {
        guard !text.isEmpty, let index = sessionIndex(invocationID) else {
            return
        }
        sessions[index].assistantText = text
        sessions[index].updatedAt = Date()
    }

    private func appendTimeline(
        kind: AgentTimelineEvent.Kind,
        sequence: Int,
        title: String,
        detail: String,
        requestID: String?,
        questions: [AgentClarificationQuestion],
        allowSkip: Bool? = nil,
        timeoutMs: Int? = nil,
        requestedAtMs: Double? = nil,
        invocationID: String
    ) {
        guard let index = sessionIndex(invocationID) else {
            return
        }
        let id = sequence > 0 ? "\(invocationID):\(sequence):\(kind.rawValue)" : UUID().uuidString.lowercased()
        guard !sessions[index].events.contains(where: { $0.id == id }) else {
            return
        }
        sessions[index].events.append(
            AgentTimelineEvent(
                id: id,
                sequence: sequence,
                kind: kind,
                title: title,
                detail: detail,
                requestID: requestID,
                questions: questions,
                allowSkip: allowSkip,
                timeoutMs: timeoutMs,
                requestedAtMs: requestedAtMs
            )
        )
        if sessions[index].events.count > 100 {
            sessions[index].events.removeFirst(sessions[index].events.count - 100)
        }
        sessions[index].updatedAt = Date()
    }

    private func markRequestHandled(invocationID: String, requestID: String) {
        guard let index = sessionIndex(invocationID) else {
            return
        }
        sessions[index].events.removeAll { $0.requestID == requestID }
        sessions[index].phase = .open
        sessions[index].updatedAt = Date()
        persistSessions()
    }

    private func updateFinalIdentifiers(_ payload: [String: Any], invocationID: String) {
        guard let index = sessionIndex(invocationID) else {
            return
        }
        if let chatID = payload["chatId"] {
            sessions[index].finalChatID = int(chatID)
        }
        sessions[index].finalPublicChatID = string(payload["publicChatId"]) ?? sessions[index].finalPublicChatID
        sessions[index].clientTurnID = string(payload["clientTurnId"]) ?? sessions[index].clientTurnID
    }

    private func finalize(invocationID: String) {
        guard let index = sessionIndex(invocationID), sessions[index].phase != .finalized else {
            return
        }
        setPhase(.finalized, invocationID: invocationID)
        persistSessions()
        onSessionFinalized?(sessions[index])
    }

    private func setFailure(_ message: String, invocationID: String) {
        lastError = message
        setPhase(.failed, invocationID: invocationID)
        appendTimeline(
            kind: .error,
            sequence: 0,
            title: "Agent 连接错误",
            detail: message,
            requestID: nil,
            questions: [],
            invocationID: invocationID
        )
        persistSessions()
        if let index = sessionIndex(invocationID) {
            onSessionFailed?(sessions[index], message)
        }
    }

    private func setPhase(_ phase: AgentSessionPhase, invocationID: String) {
        guard let index = sessionIndex(invocationID) else {
            return
        }
        sessions[index].phase = phase
        sessions[index].updatedAt = Date()
    }

    private func updateSequence(_ sequence: Int, invocationID: String) {
        guard sequence > 0, let index = sessionIndex(invocationID) else {
            return
        }
        sessions[index].lastEventSequence = max(sessions[index].lastEventSequence, sequence)
        sessions[index].updatedAt = Date()
    }

    private func persistSessions() {
        guard let ownerScope, let apiClient, let localCache else {
            return
        }
        let descriptors = sessions
            .filter { !$0.phase.isTerminal }
            .map {
                PersistedAgentSessionDescriptor(
                    invocationID: $0.invocationID,
                    workspaceID: $0.workspaceID,
                    threadID: $0.threadID,
                    clientTurnID: $0.clientTurnID,
                    lastEventSequence: $0.lastEventSequence,
                    phase: $0.phase,
                    updatedAt: $0.updatedAt
                )
            }
        do {
            try localCache.saveAgentSessionDescriptors(
                descriptors,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL
            )
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func sessionIndex(_ invocationID: String) -> Int? {
        sessions.firstIndex { $0.invocationID == invocationID }
    }

    private func synchronizeSessionRenderStores() {
        let previousIDs = Set(sessionRenderStoresByInvocationID.keys)
        let previousLatestSessions = latestSessionInvocationIDByThreadID
        let nextIDs = Set(sessions.map(\.invocationID))

        for session in sessions {
            if let store = sessionRenderStoresByInvocationID[session.invocationID] {
                store.update(session: session)
            } else {
                sessionRenderStoresByInvocationID[session.invocationID] =
                    AgentSessionRenderStore(session: session)
            }
        }
        sessionRenderStoresByInvocationID = sessionRenderStoresByInvocationID.filter {
            nextIDs.contains($0.key)
        }
        latestSessionInvocationIDByThreadID = Dictionary(
            sessions
                .sorted { $0.updatedAt > $1.updatedAt }
                .map { ($0.threadID, $0.invocationID) },
            uniquingKeysWith: { first, _ in first }
        )
        if previousIDs != nextIDs ||
            previousLatestSessions != latestSessionInvocationIDByThreadID {
            sessionListRevision &+= 1
        }
    }

    private func agentScope(invocationID: String, transport: String) -> AthenaTaskScope {
        let session = sessionIndex(invocationID).map { sessions[$0] }
        return AthenaTaskScope(
            owner: ownerScope,
            route: "workspace-chat",
            surface: "agent",
            workspaceID: session?.workspaceID,
            threadID: session?.threadID,
            transport: transport
        )
    }

    private func path(from template: String, invocationID: String) -> String {
        Self.path(from: template, invocationID: invocationID)
    }

    private static func path(from template: String, invocationID: String) -> String {
        template.replacingOccurrences(of: ":uuid", with: invocationID)
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

    private func int(_ value: Any?) -> Int {
        switch value {
        case let value as Int:
            value
        case let value as NSNumber:
            value.intValue
        case let value as String:
            Int(value) ?? 0
        default:
            0
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

    private func double(_ value: Any?) -> Double? {
        switch value {
        case let value as Double:
            value
        case let value as NSNumber:
            value.doubleValue
        case let value as String:
            Double(value)
        default:
            nil
        }
    }
}

private struct AgentStateResponse: Decodable, Sendable {
    struct State: Decodable, Sendable {
        let closed: Bool?
        let retryable: Bool?
        let latestSeq: Int?
    }

    let success: Bool
    let state: State
}

private struct AgentActionResponse: Decodable, Sendable {
    let success: Bool
    let closed: Bool?
}

private struct AgentApprovalPayload: Encodable, Sendable {
    let type: String
    let requestId: String
    let approved: Bool
}

private struct AgentClarificationPayload: Encodable, Sendable {
    let type: String
    let requestId: String
    let skipped: Bool
    let answers: [AgentClarificationAnswer]
}

private struct AgentStopPayload: Encodable, Sendable {}
