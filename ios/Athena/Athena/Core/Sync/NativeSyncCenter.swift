import CryptoKit
import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class NativeSyncCenter {
    enum Status: Equatable {
        case stopped
        case reconciling
        case ready
        case background
        case failed(String)
    }

    var status: Status = .stopped
    private(set) var threadStates: [String: NativeThreadSyncState] = [:]
    var syncV2Diagnostics: NativeSyncV2Diagnostics { syncV2.diagnostics() }
    var replayPath = "/api/sync/events/replay"
    var fingerprintPath = "/api/sync/thread-fingerprints"
    var pushTokenPath = "/api/native-app/push-token"

    private let apiClient: APIClient
    private let workspaceAPI: WorkspaceAPI
    private let workspaceCenter: WorkspaceCenter
    private let accountProfileCenter: AccountProfileCenter
    private let accountSettingsCenter: AccountSettingsCenter
    private let optimisticActionCenter: NativeOptimisticActionCenter
    private let realtimeClient: RealtimeBroadcastClient
    private let taskScheduler: TaskScheduler
    private let secureStore: SecureValueStore
    private let clientIdentityCenter: ClientIdentityCenter
    private let syncV2: NativeSyncV2Coordinator
    private var ownerScope: String?
    private var cursor: String?
    private var deviceToken: String?
    private var fingerprintTask: Task<Void, Never>?
    private var fingerprintRerunNeeded = false
    private var backgrounded = false
    private var nativePushEnabled = false
    private var syncV2Enabled = false
    private var onSecurityIncident: ((APISecurityIncident) async -> Void)?

    init(
        apiClient: APIClient,
        workspaceAPI: WorkspaceAPI,
        workspaceCenter: WorkspaceCenter,
        accountProfileCenter: AccountProfileCenter,
        accountSettingsCenter: AccountSettingsCenter,
        optimisticActionCenter: NativeOptimisticActionCenter,
        realtimeClient: RealtimeBroadcastClient,
        taskScheduler: TaskScheduler,
        secureStore: SecureValueStore,
        clientIdentityCenter: ClientIdentityCenter,
        serverStateCache: ServerStateCache
    ) {
        self.apiClient = apiClient
        self.workspaceAPI = workspaceAPI
        self.workspaceCenter = workspaceCenter
        self.accountProfileCenter = accountProfileCenter
        self.accountSettingsCenter = accountSettingsCenter
        self.optimisticActionCenter = optimisticActionCenter
        self.realtimeClient = realtimeClient
        self.taskScheduler = taskScheduler
        self.secureStore = secureStore
        self.clientIdentityCenter = clientIdentityCenter
        self.syncV2 = NativeSyncV2Coordinator(
            apiClient: apiClient,
            serverStateCache: serverStateCache,
            secureStore: secureStore,
            clientIdentityCenter: clientIdentityCenter
        )
        self.syncV2.setNodeHandler { [weak self] node in
            try await self?.applySyncV2Node(node)
        }
        workspaceCenter.submitSyncV2Mutation = { [weak self] nodeKey, mutationId, changedPaths, payload in
            guard let self, self.syncV2Enabled else { return false }
            return try await self.syncV2.submitMutation(
                nodeKey: nodeKey,
                mutationId: mutationId,
                changedPaths: changedPaths,
                payload: payload
            )
        }
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        replayPath = bootstrap?.endpoints.syncReplayPath ?? "/api/sync/events/replay"
        fingerprintPath = bootstrap?.endpoints.threadFingerprintsPath ?? "/api/sync/thread-fingerprints"
        pushTokenPath = bootstrap?.endpoints.nativePushTokenPath ?? "/api/native-app/push-token"
        nativePushEnabled = bootstrap?.features.nativePush == true
        syncV2Enabled = bootstrap?.features.syncV2 == true
    }

    func setSecurityIncidentHandler(
        _ handler: @escaping (APISecurityIncident) async -> Void
    ) {
        onSecurityIncident = handler
    }

    @discardableResult
    func start(ownerScope: String) async -> Bool {
        self.ownerScope = ownerScope
        cursor = loadCursor(ownerScope: ownerScope)
        status = .reconciling
        do {
            let syncV2Ready = syncV2Enabled
                ? await syncV2.start(ownerScope: ownerScope)
                : false
            try await replayAndReconcile(syncV2Ready: syncV2Ready)
            if !syncV2Ready {
                await workspaceCenter.refreshDrawerPinsFromSync()
            } else {
                syncV2.recordSuppressedLegacyDomainRead()
            }
            status = .ready
            startRealtime()
            requestFingerprintCheck()
            if nativePushEnabled {
                UIApplication.shared.registerForRemoteNotifications()
                if let deviceToken { try? await registerPushToken(deviceToken) }
            }
            return syncV2Ready
        } catch {
            status = .failed(error.localizedDescription)
            startRealtime()
            return false
        }
    }

    func setApplicationBackgrounded(_ backgrounded: Bool) async {
        self.backgrounded = backgrounded
        syncV2.setBackgrounded(backgrounded)
        if backgrounded {
            realtimeClient.stop()
            status = .background
            return
        }
        guard ownerScope != nil else { return }
        status = .reconciling
        do {
            let syncV2Ready = syncV2Enabled
                ? await syncV2.start(ownerScope: ownerScope ?? "unknown")
                : false
            try await replayAndReconcile(syncV2Ready: syncV2Ready)
            if !syncV2Ready {
                await workspaceCenter.refreshDrawerPinsFromSync()
            } else {
                syncV2.recordSuppressedLegacyDomainRead()
            }
            status = .ready
            requestFingerprintCheck()
        } catch {
            status = .failed(error.localizedDescription)
        }
        startRealtime()
    }

    func stop(clearCursor: Bool) {
        realtimeClient.stop()
        fingerprintTask?.cancel()
        fingerprintTask = nil
        fingerprintRerunNeeded = false
        if clearCursor, let ownerScope {
            try? secureStore.removeData(forKey: cursorKey(ownerScope: ownerScope))
        }
        ownerScope = nil
        syncV2.stop(clear: clearCursor)
        cursor = nil
        threadStates = [:]
        status = .stopped
    }

    func receiveDeviceToken(_ data: Data) async {
        guard nativePushEnabled else { return }
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        guard ownerScope != nil else { return }
        try? await registerPushToken(token)
    }

    func handleBackgroundPush() async -> Bool {
        guard ownerScope != nil else { return false }
        do {
            var syncV2Ready = false
            if syncV2Enabled, let ownerScope {
                syncV2Ready = await syncV2.start(ownerScope: ownerScope)
            }
            try await replayAndReconcile(syncV2Ready: syncV2Ready)
            try await compareFingerprints()
            return true
        } catch {
            return false
        }
    }

    func unregisterPushToken() async {
        guard nativePushEnabled, ownerScope != nil else { return }
        _ = try? await apiClient.requestJSON(
            NativeSyncSuccessResponse.self,
            method: .delete,
            path: pushTokenPath,
            authorization: .required,
            signing: .required
        )
    }

    func updateSelection(workspaceID: String?, threadID: String?) async {
        await realtimeClient.updateSubscription(
            workspaceID: workspaceID,
            threadID: threadID
        )
        guard ownerScope != nil, threadID != nil else { return }
        requestFingerprintCheck()
    }

    private func startRealtime() {
        guard !backgrounded, ownerScope != nil else { return }
        realtimeClient.start(
            lastEventID: cursor,
            workspaceID: workspaceCenter.currentWorkspaceID,
            threadID: workspaceCenter.currentThreadID
        ) { [weak self] event in
            try await self?.apply(event)
        }
    }

    private func replayAndReconcile(syncV2Ready: Bool = false) async throws {
        var replay = try await fetchReplay(after: cursor)
        if replay.requiresFullSync {
            let checkpoint = replay.checkpointEventId
            if syncV2Ready {
                syncV2.recordSuppressedLegacyDomainRead()
            } else {
                try await workspaceCenter.reconcileUnifiedSync()
                await accountProfileCenter.refreshForFullReconciliation()
                await accountSettingsCenter.refreshMemoryFromUnifiedSync()
            }
            if let checkpoint { try persistCursor(checkpoint) }
            replay = try await fetchReplay(after: checkpoint)
        }
        while true {
            for event in replay.events {
                try await apply(event)
            }
            if let next = replay.nextEventId { try persistCursor(next) }
            guard replay.hasMore else { break }
            replay = try await fetchReplay(after: replay.nextEventId)
        }
    }

    private func fetchReplay(after eventID: String?) async throws -> NativeSyncReplayResponse {
        try await taskScheduler.run(
            AthenaTaskDescriptor(
                label: "sync:event-replay",
                kind: "sync",
                priority: .p0,
                intentRank: 0,
                executionClass: .synchronization,
                policy: .foreground,
                scope: AthenaTaskScope(
                    owner: ownerScope,
                    route: "sync",
                    surface: "event-replay",
                    transport: "http"
                ),
                dedupeKey: "sync:replay:\(ownerScope ?? "unknown")",
                isProtected: true,
                isAbortable: false
            )
        ) { [apiClient, replayPath] context in
            try context.checkCancellation()
            return try await apiClient.getJSON(
                NativeSyncReplayResponse.self,
                path: replayPath,
                queryItems: [
                    eventID.map { URLQueryItem(name: "afterEventId", value: $0) },
                    URLQueryItem(name: "limit", value: "100"),
                ].compactMap { $0 },
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
        }
    }

    private func apply(_ event: NativeSyncEvent) async throws {
        var appliedSyncNodeKey: String?
        if syncV2Enabled, let syncEvent = event.payload?.syncV2 {
            if try await syncV2.apply(syncEvent) {
                appliedSyncNodeKey = syncEvent.nodeKey
            }
        }
        let actionID = event.origin?.actionId
        let localActionIsActive = optimisticActionCenter.isActive(actionID)
        switch event.dottedType {
        case "client.revoked":
            await onSecurityIncident?(.clientRevoked)
        case "signingSecret.rotated":
            await onSecurityIncident?(.signingSecretRotated)
        case "thread.updated":
            if let workspaceID = event.workspaceID,
               let threadID = event.threadID {
                await workspaceCenter.applySyncedThreadMetadata(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    title: event.payload?.title ?? event.payload?.threadName,
                    chatModel: event.payload?.chatModel.flatMap(ThreadChatModel.init(rawValue:)),
                    actionID: actionID
                )
            }
        case "workspace.updated":
            if let workspaceID = event.workspaceID {
                await workspaceCenter.applySyncedWorkspaceMetadata(
                    workspaceID: workspaceID,
                    title: event.payload?.workspaceName,
                    chatModel: event.payload?.chatModel.flatMap(ThreadChatModel.init(rawValue:)),
                    actionID: actionID
                )
            }
        case "user.profile.updated", "profile.updated":
            if appliedSyncNodeKey?.hasSuffix("/profile") == true {
                syncV2.recordSuppressedLegacyDomainRead()
            } else {
                await accountProfileCenter.refreshFromUnifiedSync(
                    changedFields: event.payload?.changedFields
                )
            }
        case "user.memory.created", "user.memory.updated",
             "user.memory.archived", "user.memory.rebuilt":
            if appliedSyncNodeKey?.contains("/memory/") == true {
                syncV2.recordSuppressedLegacyDomainRead()
            } else {
                await accountSettingsCenter.refreshMemoryFromUnifiedSync()
            }
        case "system.provider.updated":
            await accountSettingsCenter.refreshProviderFromUnifiedSync(
                actionID: actionID
            )
        case "thread.created":
            if localActionIsActive,
               let workspaceID = event.workspaceID,
               let threadID = event.threadID {
                _ = await workspaceCenter.confirmCreatedThreadFromSync(
                    workspaceID: workspaceID,
                    serverID: event.resource?.id,
                    threadID: threadID,
                    title: event.payload?.title ?? event.payload?.threadName,
                    threadType: event.payload?.threadType,
                    chatModel: event.payload?.chatModel.flatMap(ThreadChatModel.init(rawValue:)),
                    actionID: actionID
                )
            } else {
                if appliedSyncNodeKey?.contains("/threads/index") == true {
                    syncV2.recordSuppressedLegacyDomainRead()
                } else {
                    await workspaceCenter.refreshThreadNavigationFromUnifiedSync(
                        workspaceID: event.workspaceID ?? ""
                    )
                }
            }
        case "userState.updated":
            if event.payload?.namespaces?.contains(IOSDrawerPinsState.namespace) == true {
                if appliedSyncNodeKey?.contains(IOSDrawerPinsState.namespace) == true {
                    syncV2.recordSuppressedLegacyDomainRead()
                } else {
                    await workspaceCenter.refreshDrawerPinsFromSync()
                }
            }
        case "userState.deleted":
            if event.payload?.namespace == IOSDrawerPinsState.namespace {
                if appliedSyncNodeKey?.contains(IOSDrawerPinsState.namespace) == true {
                    syncV2.recordSuppressedLegacyDomainRead()
                } else {
                    await workspaceCenter.refreshDrawerPinsFromSync()
                }
            }
        case "workspace.delete.requested":
            workspaceCenter.applyWorkspaceDeleteRequested(actionID: event.origin?.actionId)
        case "workspace.delete.failed":
            workspaceCenter.applyWorkspaceDeleteFailed(actionID: event.origin?.actionId)
        case "workspace.deleted":
            await workspaceCenter.applyWorkspaceDeleted(
                workspaceID: event.workspaceID,
                actionID: event.origin?.actionId
            )
            if appliedSyncNodeKey?.hasSuffix("/workspaces/index") == true {
                syncV2.recordSuppressedLegacyDomainRead()
            } else {
                await workspaceCenter.refreshWorkspaceNavigationFromUnifiedSync()
            }
        case let type where type.hasPrefix("chat."):
            markThreadDirty(event)
            requestFingerprintCheck()
        case "thread.deleted":
            if localActionIsActive {
                if optimisticActionCenter.requiresReconciliation(actionID), let actionID {
                    await workspaceCenter.reconcileOptimisticAction(actionID)
                }
            } else if let workspaceID = event.workspaceID {
                if appliedSyncNodeKey?.contains("/threads/index") == true {
                    syncV2.recordSuppressedLegacyDomainRead()
                } else {
                    await workspaceCenter.refreshThreadNavigationFromUnifiedSync(
                        workspaceID: workspaceID
                    )
                }
            }
        case "workspace.created":
            if localActionIsActive {
                if optimisticActionCenter.requiresReconciliation(actionID), let actionID {
                    await workspaceCenter.reconcileOptimisticAction(actionID)
                }
            } else {
                if appliedSyncNodeKey?.hasSuffix("/workspaces/index") == true {
                    syncV2.recordSuppressedLegacyDomainRead()
                } else {
                    await workspaceCenter.refreshWorkspaceNavigationFromUnifiedSync()
                }
            }
        case "sync.required":
            try await workspaceCenter.reconcileUnifiedSync()
            await accountProfileCenter.refreshForFullReconciliation()
            await accountSettingsCenter.refreshProviderFromUnifiedSync()
            requestFingerprintCheck()
        default:
            break
        }
        if let actionID,
           localActionIsActive,
           ["thread.updated", "system.provider.updated"].contains(event.dottedType) {
            optimisticActionCenter.confirm(actionID)
        }
        try persistCursor(event.eventId)
    }

    private func applySyncV2Node(_ node: NativeSyncV2NodeResult) async throws {
        let key = node.descriptor.nodeKey
        if key.hasSuffix("/profile") {
            if let projection = NativeSyncV2ProjectionDecoder.profile(node.payload) {
                await accountProfileCenter.applySyncV2Profile(projection)
                syncV2.recordDirectPayloadApplication()
            } else {
                await accountProfileCenter.refreshFromUnifiedSync(changedFields: nil)
            }
            return
        }
        if key.contains("/preferences/") {
            if key.contains(IOSDrawerPinsState.namespace),
               let pins = NativeSyncV2ProjectionDecoder.drawerPins(node.payload) {
                await workspaceCenter.applySyncV2DrawerPins(pins)
                syncV2.recordDirectPayloadApplication()
            } else if key.contains(IOSDrawerPinsState.namespace) {
                await workspaceCenter.refreshDrawerPinsFromSync()
            }
            return
        }
        if key.range(of: #"^users/\d+/security/passkeys$"#, options: .regularExpression) != nil {
            await accountSettingsCenter.loadPasskeys()
            return
        }
        if key.range(of: #"^users/\d+/security/clients$"#, options: .regularExpression) != nil {
            await accountSettingsCenter.loadClientDevices()
            return
        }
        if key.range(of: #"^users/\d+/security/sessions$"#, options: .regularExpression) != nil {
            await accountSettingsCenter.loadAuthSessions()
            return
        }
        if key.range(of: #"^users/\d+/security/policies$"#, options: .regularExpression) != nil {
            await accountProfileCenter.refreshForFullReconciliation()
            return
        }
        if key.range(of: #"^users/\d+/(notifications|entitlements|integrations)$"#, options: .regularExpression) != nil {
            await accountProfileCenter.refreshForFullReconciliation()
            return
        }
        if key.range(of: #"^users/\d+/memory/(candidates|structured|persona)$"#, options: .regularExpression) != nil {
            await accountSettingsCenter.refreshMemoryFromUnifiedSync()
            return
        }
        if key.range(of: #"^users/\d+/workspaces/index$"#, options: .regularExpression) != nil {
            if let workspaces = NativeSyncV2ProjectionDecoder.workspaces(node.payload) {
                await workspaceCenter.applySyncV2WorkspaceIndex(workspaces)
                syncV2.recordDirectPayloadApplication()
            } else {
                await workspaceCenter.refreshWorkspaceNavigationFromUnifiedSync()
            }
            return
        }
        if key.range(of: #"^workspaces/\d+/metadata$"#, options: .regularExpression) != nil,
           let payload = node.payload?.objectValue,
           let slug = payload["slug"]?.stringValue {
            await workspaceCenter.applySyncedWorkspaceMetadata(
                workspaceID: slug,
                title: payload["name"]?.stringValue,
                chatModel: payload["chatModel"]?.stringValue.flatMap(ThreadChatModel.init(rawValue:)),
                actionID: nil
            )
            syncV2.recordDirectPayloadApplication()
            return
        }
        if key.range(of: #"^workspaces/\d+/threads/index$"#, options: .regularExpression) != nil,
           let serverID = node.descriptor.ownerId,
           let workspace = workspaceCenter.workspaces.first(where: { $0.serverID == serverID }) {
            if let threads = NativeSyncV2ProjectionDecoder.threads(
                node.payload,
                workspaceID: workspace.id
            ) {
                await workspaceCenter.applySyncV2ThreadIndex(
                    threads,
                    workspaceID: workspace.id
                )
                syncV2.recordDirectPayloadApplication()
            } else {
                await workspaceCenter.refreshThreadNavigationFromUnifiedSync(
                    workspaceID: workspace.id
                )
            }
            return
        }
        if key.range(
            of: #"^workspaces/\d+/(documents|document-status)$"#,
            options: .regularExpression
        ) != nil {
            if let serverID = node.descriptor.ownerId,
               let workspace = workspaceCenter.workspaces.first(where: { $0.serverID == serverID }) {
                await workspaceCenter.applyUnifiedSyncInvalidation(
                    workspaceID: workspace.id,
                    threadID: nil
                )
            }
            return
        }
        if key.range(of: #"^threads/\d+/metadata$"#, options: .regularExpression) != nil,
           let payload = node.payload?.objectValue,
           let workspaceServerID = payload["workspace_id"]?.intValue,
           let workspace = workspaceCenter.workspaces.first(where: { $0.serverID == workspaceServerID }),
           let threadSlug = payload["slug"]?.stringValue {
            await workspaceCenter.applySyncedThreadMetadata(
                workspaceID: workspace.id,
                threadID: threadSlug,
                title: payload["title"]?.stringValue ?? payload["name"]?.stringValue,
                chatModel: payload["chatModel"]?.stringValue.flatMap(ThreadChatModel.init(rawValue:)),
                actionID: nil
            )
            syncV2.recordDirectPayloadApplication()
            return
        }
        if key.range(of: #"^threads/\d+/messages$"#, options: .regularExpression) != nil {
            requestFingerprintCheck()
        }
    }

    private func requestFingerprintCheck() {
        if fingerprintTask != nil {
            fingerprintRerunNeeded = true
            return
        }
        fingerprintTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                self.fingerprintRerunNeeded = false
                try? await self.compareFingerprints()
            } while self.fingerprintRerunNeeded && !Task.isCancelled
            self.fingerprintTask = nil
        }
    }

    private func compareFingerprints() async throws {
        let requests = workspaceCenter.fingerprintRequests(limit: 30)
        guard !requests.isEmpty else { return }
        for request in requests {
            var state = threadStates[request.threadSlug] ?? NativeThreadSyncState()
            state.phase = .checking
            threadStates[request.threadSlug] = state
        }
        let results = try await taskScheduler.run(
            AthenaTaskDescriptor(
                label: "sync:thread-fingerprints",
                kind: "sync",
                priority: .p0,
                intentRank: 0,
                executionClass: .synchronization,
                policy: .foreground,
                scope: AthenaTaskScope(
                    owner: ownerScope,
                    route: "sync",
                    surface: "thread-fingerprints",
                    transport: "http"
                ),
                dedupeKey: "sync:fingerprints:\(ownerScope ?? "unknown")"
            )
        ) { [workspaceAPI] context in
            try context.checkCancellation()
            return try await workspaceAPI.compareThreadFingerprints(requests)
        }
        for result in results {
            await handleFingerprintResult(result)
        }
    }

    private func handleFingerprintResult(_ result: ThreadFingerprintResult) async {
        guard result.status != "unavailable" else {
            await workspaceCenter.applyUnifiedSyncInvalidation(
                workspaceID: result.workspaceSlug,
                threadID: nil
            )
            threadStates[result.threadSlug] = NativeThreadSyncState(phase: .dirty)
            return
        }
        let revision = result.historyRevision ?? 0
        guard result.status == "changed" else {
            await workspaceCenter.applySyncedThreadMetadata(
                workspaceID: result.workspaceSlug,
                threadID: result.threadSlug,
                historyFingerprint: result.historyFingerprint,
                historyRevision: revision,
                latestChatID: result.latestChatId,
                latestChatAt: result.latestChatAt
            )
            threadStates[result.threadSlug] = NativeThreadSyncState(
                phase: .clean,
                remoteRevision: revision,
                remoteFingerprint: result.historyFingerprint
            )
            return
        }
        var state = threadStates[result.threadSlug] ?? NativeThreadSyncState()
        state.phase = .dirty
        state.remoteRevision = max(state.remoteRevision, revision)
        state.remoteFingerprint = result.historyFingerprint
        threadStates[result.threadSlug] = state
        let priority: AthenaTaskPriority = workspaceCenter.currentThreadID == result.threadSlug
            ? .p0
            : .p3
        Task { [weak self] in
            await self?.refreshChangedThread(
                workspaceID: result.workspaceSlug,
                threadID: result.threadSlug,
                priority: priority
            )
        }
    }

    private func refreshChangedThread(
        workspaceID: String,
        threadID: String,
        priority: AthenaTaskPriority
    ) async {
        var state = threadStates[threadID] ?? NativeThreadSyncState()
        guard state.phase != .refreshing else {
            state.rerunNeeded = true
            threadStates[threadID] = state
            return
        }
        repeat {
            state = threadStates[threadID] ?? state
            state.phase = .refreshing
            state.rerunNeeded = false
            threadStates[threadID] = state
            do {
                let committedRevision = try await workspaceCenter.refreshHistoryFromUnifiedSync(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    expectedRevision: state.remoteRevision,
                    priority: priority
                )
                state = threadStates[threadID] ?? state
                state.phase = committedRevision >= state.remoteRevision ? .clean : .dirty
            } catch {
                state = threadStates[threadID] ?? state
                state.phase = .dirty
            }
            threadStates[threadID] = state
        } while state.rerunNeeded
    }

    private func markThreadDirty(_ event: NativeSyncEvent) {
        guard let threadID = event.threadID else { return }
        var state = threadStates[threadID] ?? NativeThreadSyncState()
        let wasRefreshing = state.phase == .refreshing
        state.phase = .dirty
        state.remoteRevision = max(
            state.remoteRevision,
            event.payload?.historyRevision ?? event.revision ?? 0
        )
        state.remoteFingerprint = event.payload?.historyFingerprint ?? state.remoteFingerprint
        if wasRefreshing { state.rerunNeeded = true }
        threadStates[threadID] = state
    }

    private func registerPushToken(_ token: String) async throws {
        let response = try await apiClient.requestJSON(
            NativeSyncSuccessResponse.self,
            method: .post,
            path: pushTokenPath,
            body: NativePushTokenRequest(deviceToken: token),
            authorization: .required,
            signing: .required,
            retryOnConnectionLoss: true
        )
        guard response.success else { throw APIClientError.invalidResponse }
    }

    private func persistCursor(_ eventID: String) throws {
        guard let ownerScope else { return }
        cursor = eventID
        try secureStore.setData(
            Data(eventID.utf8),
            forKey: cursorKey(ownerScope: ownerScope)
        )
    }

    private func loadCursor(ownerScope: String) -> String? {
        guard let data = try? secureStore.data(forKey: cursorKey(ownerScope: ownerScope)) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func cursorKey(ownerScope: String) -> String {
        let identity = [
            apiClient.configuration.normalizedBaseURL.absoluteString,
            ownerScope,
            clientIdentityCenter.clientID ?? "unknown",
        ].joined(separator: "|")
        let digest = SHA256.hash(data: Data(identity.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return "native-sync.cursor.v1.\(digest)"
    }
}
