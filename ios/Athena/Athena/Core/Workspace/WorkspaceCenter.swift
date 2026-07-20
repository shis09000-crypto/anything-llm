import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class WorkspaceCenter {
    enum BootstrapRefreshMode: Equatable {
        case cacheFirst
        case authoritative

        var forceRefresh: Bool { self == .authoritative }
    }

    enum Source: Equatable {
        case live
        case preview
    }

    enum LoadState: Equatable {
        case idle
        case loading
        case ready
        case stale(String)
        case failed(String)
    }

    private enum OptimisticMutationSnapshot {
        case workspaceTitle(workspaceID: String, previousTitle: String)
        case threadTitle(workspaceID: String, threadID: String, previousTitle: String)
        case deletedWorkspace(
            workspace: AthenaWorkspace,
            index: Int,
            selection: (String?, String)
        )
        case deletedThread(
            workspaceID: String,
            thread: AthenaThread,
            index: Int,
            selection: (String?, String)
        )
        case chatMessages(
            workspaceID: String,
            threadID: String,
            messages: [AthenaChatMessage]
        )

        var workspaceID: String {
            switch self {
            case .workspaceTitle(let workspaceID, _),
                    .threadTitle(let workspaceID, _, _),
                    .deletedThread(let workspaceID, _, _, _),
                    .chatMessages(let workspaceID, _, _):
                workspaceID
            case .deletedWorkspace(let workspace, _, _):
                workspace.id
            }
        }
    }

    private enum MessagePublishMode {
        case automatic
        case contentOnly(messageID: String)

        var isAutomatic: Bool {
            if case .automatic = self { return true }
            return false
        }
    }

    private let api: WorkspaceAPI?
    private let apiClient: APIClient?
    private let chatStreamClient: ChatStreamClient?
    private let agentControlKit: AgentControlKit?
    private let taskScheduler: TaskScheduler
    private let optimisticActionCenter: NativeOptimisticActionCenter
    private let recoveryCenter: NativeRecoveryCenter
    private let serverStateCache: ServerStateCache
    private let localCache: LocalCache
    private let userStateSyncClient: UserStateSyncClient
    private let source: Source

    private var ownerScope: String?
    private var selectedWorkspaceID: String?
    private var navigationGeneration: UInt64 = 0
    private var chatStreamHandles: [String: ScheduledTaskHandle<Void>] = [:]
    @ObservationIgnored private var chatStreamDisplayBuffers: [String: ChatStreamDisplayBuffer] = [:]
    @ObservationIgnored private var conversationInteractionActive = false
    private var activeClientTurnIDByThreadID: [String: String] = [:]
    private var abortedStreamClientTurnIDs: Set<String> = []
    private var agentHandoffClientTurnIDs: Set<String> = []
    private var regenerateCommittedClientTurnIDs: Set<String> = []
    private var threadModelUpdateHandles: [String: ScheduledTaskHandle<ThreadChatModel>] = [:]
    private var confirmedModelByThreadID: [String: ThreadChatModel] = [:]
    private var modelActionIDByThreadID: [String: String] = [:]
    private var modelActionsConfirmedBySync: Set<String> = []
    private var optimisticResourceActionIDs: [String: String] = [:]
    private var optimisticMutationSnapshots: [String: OptimisticMutationSnapshot] = [:]
    private var cachedFallbackSnapshot: WorkspaceMetadataSnapshot?
    private(set) var localConversationViewport: LocalConversationViewportSnapshot?
    private var loadedThreadWorkspaceIDs: Set<String> = []
    @ObservationIgnored private var snapshotPersistenceTask: Task<Void, Never>?
    @ObservationIgnored var onSelectionChanged: ((String?, String?) -> Void)?
    @ObservationIgnored var restoreMutationSecurity: (() async -> Bool)?
    @ObservationIgnored var submitSyncV2Mutation: ((
        String,
        String,
        [String],
        SyncJSONValue
    ) async throws -> Bool)?

    var workspaces: [AthenaWorkspace]
    var selectedThreadID: String
    @ObservationIgnored var messagesByThreadID: [String: [AthenaChatMessage]]
    @ObservationIgnored private var messageIndexByThreadID: [String: [String: Int]]
    @ObservationIgnored private var messageRenderStoresByThreadID: [
        String: [String: ConversationMessageRenderStore]
    ] = [:]
    @ObservationIgnored private var orderedMessageRenderStoresByThreadID: [
        String: [ConversationMessageRenderStore]
    ] = [:]
    private var timelineRevisionByThreadID: [String: UInt64] = [:]
    var historyStateByThreadID: [String: AthenaThreadHistoryState]
    var loadState: LoadState
    var historyLoadingThreadID: String?
    var lastError: String?
    var hasCachedFallback = false
    var sendingThreadIDs: Set<String> = []
    var sendErrorByThreadID: [String: String] = [:]
    var modelUpdatingThreadIDs: Set<String> = []
    var modelUpdateErrorByThreadID: [String: String] = [:]
    var drawerPins = IOSDrawerPinsState.empty
    var chatEditSession: AthenaChatEditSession?

    var drawerPinnedThreadIDs: Set<String> {
        Set(drawerPins.pins.compactMap { $0.kind == .thread ? $0.threadID : nil })
    }

    var drawerPinnedWorkspaceIDs: Set<String> {
        Set(drawerPins.pins.compactMap { $0.kind == .workspace ? $0.workspaceID : nil })
    }

    var isPreview: Bool { source == .preview }
    var allowsLocalMutations: Bool { isPreview || ownerScope != nil }
    var allowsCreation: Bool { isPreview || ownerScope != nil }
    var currentWorkspaceID: String? { selectedWorkspaceID }
    var currentThreadID: String? { selectedThreadID.isEmpty ? nil : selectedThreadID }

    func messagesForDisplay(in threadID: String) -> [AthenaChatMessage] {
        let messages = messages(for: threadID)
        guard let session = chatEditSession,
              session.threadID == threadID,
              session.phase == .editing else {
            return messages
        }
        if let index = messages.firstIndex(where: { message in
            message.id == session.messageID ||
                (message.role == .user && message.chatID == session.startingChatID)
        }) {
            return Array(messages[..<index])
        }
        return messages.filter { message in
            guard let chatID = message.chatID else { return false }
            return chatID < session.startingChatID
        }
    }

    func messageRenderStoresForDisplay(
        in threadID: String
    ) -> [ConversationMessageRenderStore] {
        let stores = orderedMessageRenderStoresByThreadID[threadID] ?? []
        guard let session = chatEditSession,
              session.threadID == threadID,
              session.phase == .editing else {
            return stores
        }
        if let index = stores.firstIndex(where: { store in
            store.id == session.messageID ||
                (store.role == .user &&
                    store.chatID == session.startingChatID)
        }) {
            return Array(stores[..<index])
        }
        return stores.filter { store in
            guard let chatID = store.chatID else { return false }
            return chatID < session.startingChatID
        }
    }

    func timelineRevision(for threadID: String) -> UInt64 {
        timelineRevisionByThreadID[threadID, default: 0]
    }

    func setConversationInteractionActive(_ active: Bool) {
        guard conversationInteractionActive != active else { return }
        conversationInteractionActive = active
        for buffer in chatStreamDisplayBuffers.values {
            buffer.setInteractionActive(active)
        }
    }

    func workspaceID(for threadID: String) -> String? {
        workspaceID(containing: threadID)
    }

    init(
        api: WorkspaceAPI?,
        apiClient: APIClient?,
        chatStreamClient: ChatStreamClient? = nil,
        agentControlKit: AgentControlKit? = nil,
        taskScheduler: TaskScheduler,
        optimisticActionCenter: NativeOptimisticActionCenter,
        recoveryCenter: NativeRecoveryCenter,
        serverStateCache: ServerStateCache,
        localCache: LocalCache,
        userStateSyncClient: UserStateSyncClient,
        source: Source,
        workspaces: [AthenaWorkspace] = [],
        selectedThreadID: String = ""
    ) {
        self.api = api
        self.apiClient = apiClient
        self.chatStreamClient = chatStreamClient
        self.agentControlKit = agentControlKit
        self.taskScheduler = taskScheduler
        self.optimisticActionCenter = optimisticActionCenter
        self.recoveryCenter = recoveryCenter
        self.serverStateCache = serverStateCache
        self.localCache = localCache
        self.userStateSyncClient = userStateSyncClient
        self.source = source
        self.workspaces = workspaces.map { workspace in
            var metadata = workspace
            metadata.threads = workspace.threads.map { thread in
                var metadata = thread
                metadata.messages = []
                return metadata
            }
            return metadata
        }
        self.selectedThreadID = selectedThreadID
        let initialMessages = Dictionary(
            uniqueKeysWithValues: workspaces.flatMap { workspace in
                workspace.threads.map { ($0.id, $0.messages) }
            }
        )
        self.messagesByThreadID = initialMessages
        self.messageIndexByThreadID = initialMessages.mapValues { messages in
            Dictionary(
                uniqueKeysWithValues: messages.enumerated().map {
                    ($0.element.id, $0.offset)
                }
            )
        }
        self.historyStateByThreadID = [:]
        self.loadState = source == .preview ? .ready : .idle
        self.selectedWorkspaceID = workspaces.first(where: {
            $0.threads.contains(where: { $0.id == selectedThreadID })
        })?.id
        for (threadID, messages) in initialMessages {
            updateMessageRenderStores(messages, for: threadID)
        }
    }

    func bootstrap(
        ownerScope: String,
        refreshMode: BootstrapRefreshMode = .cacheFirst,
        onPriorityContentReady: (@MainActor () -> Void)? = nil
    ) async throws {
        guard source == .live, let api, let apiClient else {
            return
        }

        self.ownerScope = ownerScope
        navigationGeneration &+= 1
        let generation = navigationGeneration
        loadState = .loading
        lastError = nil

        let apiBase = apiClient.configuration.normalizedBaseURL
        AppPerformanceSignposts.event("ConversationCacheRestoreStarted")
        async let localViewportRequest = localCache.loadConversationViewportAsync(
            ownerScope: ownerScope,
            apiBase: apiBase
        )
        async let diskSnapshotRequest = localCache.loadWorkspaceSnapshotAsync(
            ownerScope: ownerScope,
            apiBase: apiBase
        )
        let (localViewport, retainedDiskSnapshot) = await (
            localViewportRequest,
            diskSnapshotRequest
        )
        AppPerformanceSignposts.event("ConversationCacheRestoreFinished")
        localConversationViewport = localViewport
        let diskSnapshot = retainedDiskSnapshot.flatMap { snapshot in
            snapshot.savedAt >= Date().addingTimeInterval(-ServerStateCachePolicy.workspaceList.retainFor)
                ? snapshot
                : nil
        }
        cachedFallbackSnapshot = diskSnapshot
        if let diskSnapshot {
            apply(snapshot: diskSnapshot)
        }
        hasCachedFallback = false

        do {
            var publishedPriorityContent = false
            let initialWorkspaceID = localViewport?.workspaceID ?? diskSnapshot?.selectedWorkspaceID
            let initialThreadID = localViewport?.threadID ?? diskSnapshot?.selectedThreadID
            if let snapshotWorkspaceID = initialWorkspaceID,
               let snapshotThreadID = initialThreadID {
                selectedWorkspaceID = snapshotWorkspaceID
                selectedThreadID = snapshotThreadID
                do {
                    try await loadInitialHistory(
                        workspaceID: snapshotWorkspaceID,
                        threadID: snapshotThreadID,
                        generation: generation
                    )
                    try ensureCurrent(
                        generation: generation,
                        owner: ownerScope,
                        threadID: snapshotThreadID
                    )
                    loadState = .ready
                    onPriorityContentReady?()
                    publishedPriorityContent = true
                } catch is CancellationError {
                    throw CancellationError()
                } catch AthenaTaskSchedulerError.cancelled {
                    throw CancellationError()
                } catch AthenaTaskSchedulerError.stale {
                    throw CancellationError()
                } catch {
                    lastError = error.localizedDescription
                }
            }

            async let recentNavigationRequest = serverStateCache.load(
                RecentNavigationState.self,
                key: "user-state:recent.navigation",
                ownerScope: ownerScope,
                apiBase: apiBase,
                policy: .recentNavigation,
                task: AthenaTaskDescriptor(
                    label: "workspace:recent-navigation",
                    kind: "user-state",
                    priority: .p0,
                    intentRank: 10,
                    executionClass: .navigation,
                    policy: .foreground,
                    scope: workspaceScope(owner: ownerScope, surface: "recent-navigation"),
                    dedupeKey: "recent-navigation:\(ownerScope)"
                )
            ) { [self] in
                try await self.userStateSyncClient.fetchRecentNavigation(using: apiClient)
            }
            async let drawerPinsRequest = serverStateCache.load(
                IOSDrawerPinsState.self,
                key: "user-state:\(IOSDrawerPinsState.namespace)",
                ownerScope: ownerScope,
                apiBase: apiBase,
                policy: .recentNavigation,
                task: AthenaTaskDescriptor(
                    label: "workspace:drawer-pins",
                    kind: "user-state",
                    priority: .p1,
                    intentRank: 12,
                    policy: .visible,
                    scope: workspaceScope(owner: ownerScope, surface: "drawer-pins"),
                    dedupeKey: "drawer-pins:\(ownerScope)"
                )
            ) { [self] in
                try await self.userStateSyncClient.fetchDrawerPins(using: apiClient)
            }
            async let workspacesRequest = serverStateCache.load(
                [AthenaWorkspace].self,
                key: "workspace.list",
                ownerScope: ownerScope,
                apiBase: apiBase,
                policy: .workspaceList,
                forceRefresh: refreshMode.forceRefresh,
                task: AthenaTaskDescriptor(
                    label: "workspace:list",
                    kind: "workspace-read",
                    priority: .p0,
                    intentRank: 11,
                    executionClass: .navigation,
                    policy: .foreground,
                    scope: workspaceScope(owner: ownerScope, surface: "workspace-list"),
                    dedupeKey: "workspace:list:\(ownerScope)"
                )
            ) {
                try await api.fetchWorkspaces()
            }

            let recentNavigation = (try? await recentNavigationRequest) ?? .empty
            drawerPins = (try? await drawerPinsRequest) ?? .empty
            let serverWorkspaces = try await workspacesRequest
            try ensureCurrent(generation: generation, owner: ownerScope)
            mergeServerWorkspaces(serverWorkspaces)

            let preferredWorkspaceID = localViewport?.workspaceID
                ?? recentNavigation.workspace?.slug
                ?? diskSnapshot?.selectedWorkspaceID
                ?? workspaces.first?.id
            selectedWorkspaceID = workspaces.contains(where: { $0.id == preferredWorkspaceID })
                ? preferredWorkspaceID
                : workspaces.first?.id

            if let selectedWorkspaceID {
                try await loadThreads(
                    for: selectedWorkspaceID,
                    forceRefresh: refreshMode.forceRefresh
                )
                let localThreadID = localViewport.flatMap { viewport in
                    viewport.workspaceID == selectedWorkspaceID ? viewport.threadID : nil
                }
                let preferredThreadID = recentNavigation.threadsByWorkspace[selectedWorkspaceID] ?? nil
                let snapshotThreadID = diskSnapshot?.selectedThreadID
                let availableThreads = workspace(withID: selectedWorkspaceID)?.threads ?? []
                selectedThreadID = [localThreadID, preferredThreadID, snapshotThreadID]
                    .compactMap { $0 }
                    .first(where: { candidate in
                        availableThreads.contains(where: { $0.id == candidate })
                    }) ?? availableThreads.first?.id ?? ""

                if !selectedThreadID.isEmpty {
                    try await loadInitialHistory(
                        workspaceID: selectedWorkspaceID,
                        threadID: selectedThreadID,
                        generation: generation
                    )
                    if !publishedPriorityContent {
                        loadState = .ready
                        onPriorityContentReady?()
                        publishedPriorityContent = true
                    }
                }
            } else {
                selectedThreadID = ""
            }

            loadState = .ready
            hasCachedFallback = false
            saveSnapshot()
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            let message = error.localizedDescription
            lastError = message
            hasCachedFallback = await cachedFallbackIsAvailable(
                ownerScope: ownerScope,
                apiBase: apiBase
            )
            loadState = .failed(message)
            throw error
        }
    }

    /// Restores only device-local, account-partitioned projections. It never
    /// invokes a domain API, so Sync V2 can reconcile before legacy hydration.
    /// Authority-sensitive state is intentionally not restored here.
    func restoreCachedStartup(
        ownerScope: String,
        onPriorityContentReady: (@MainActor () -> Void)? = nil
    ) async {
        guard source == .live, let apiClient else { return }
        self.ownerScope = ownerScope
        navigationGeneration &+= 1
        loadState = .loading
        lastError = nil

        let apiBase = apiClient.configuration.normalizedBaseURL
        AppPerformanceSignposts.event("ConversationCacheRestoreStarted")
        async let localViewportRequest = localCache.loadConversationViewportAsync(
            ownerScope: ownerScope,
            apiBase: apiBase
        )
        async let diskSnapshotRequest = localCache.loadWorkspaceSnapshotAsync(
            ownerScope: ownerScope,
            apiBase: apiBase
        )
        let (viewport, retainedSnapshot) = await (
            localViewportRequest,
            diskSnapshotRequest
        )
        AppPerformanceSignposts.event("ConversationCacheRestoreFinished")
        localConversationViewport = viewport
        let snapshot = retainedSnapshot.flatMap { candidate in
            candidate.savedAt >= Date().addingTimeInterval(
                -ServerStateCachePolicy.workspaceList.retainFor
            ) ? candidate : nil
        }
        cachedFallbackSnapshot = snapshot
        if let snapshot { apply(snapshot: snapshot) }

        let workspaceID = viewport?.workspaceID ?? snapshot?.selectedWorkspaceID
        let threadID = viewport?.threadID ?? snapshot?.selectedThreadID
        if let workspaceID, let threadID,
           let cached: ThreadHistoryCacheValue = await serverStateCache.cachedValue(
               ThreadHistoryCacheValue.self,
               key: latestHistoryCacheKey(workspaceID: workspaceID, threadID: threadID),
               ownerScope: ownerScope,
               apiBase: apiBase,
               allowExpired: true
           ) {
            selectedWorkspaceID = workspaceID
            selectedThreadID = threadID
            publishMessages(cached.messages, for: threadID)
            var state = historyState(for: threadID)
            state.page = cached.page
            state.isLoadingInitial = false
            historyStateByThreadID[threadID] = state
            updateThread(threadID) { thread in
                var refreshed = cached.thread
                refreshed.messages = []
                thread = refreshed
            }
        }

        if snapshot != nil || !workspaces.isEmpty || !selectedThreadID.isEmpty {
            loadState = .ready
            hasCachedFallback = true
            onPriorityContentReady?()
        }
    }

    func useCachedFallback() async -> Bool {
        guard source == .live,
              let ownerScope,
              let apiClient else {
            return false
        }
        let apiBase = apiClient.configuration.normalizedBaseURL
        let cachedWorkspaces: [AthenaWorkspace]? = await serverStateCache.cachedValue(
            [AthenaWorkspace].self,
            key: "workspace.list",
            ownerScope: ownerScope,
            apiBase: apiBase,
            allowExpired: true
        )
        let retainedLegacySnapshot = cachedFallbackSnapshot.flatMap { snapshot in
            snapshot.savedAt >= Date().addingTimeInterval(-ServerStateCachePolicy.workspaceList.retainFor)
                ? snapshot
                : nil
        }
        guard var fallbackWorkspaces = cachedWorkspaces ?? retainedLegacySnapshot?.workspaces,
              !fallbackWorkspaces.isEmpty else {
            hasCachedFallback = false
            return false
        }
        fallbackWorkspaces = fallbackWorkspaces.map { workspace in
            var next = workspace
            next.threads = []
            return next
        }
        workspaces = fallbackWorkspaces

        let navigation: RecentNavigationState? = await serverStateCache.cachedValue(
            RecentNavigationState.self,
            key: "user-state:recent.navigation",
            ownerScope: ownerScope,
            apiBase: apiBase,
            allowExpired: true
        )
        let preferredWorkspaceID = navigation?.workspace?.slug
            ?? retainedLegacySnapshot?.selectedWorkspaceID
            ?? workspaces.first?.id
        selectedWorkspaceID = workspaces.contains(where: { $0.id == preferredWorkspaceID })
            ? preferredWorkspaceID
            : workspaces.first?.id

        if let selectedWorkspaceID {
            let cachedThreads: [AthenaThread]? = await serverStateCache.cachedValue(
                [AthenaThread].self,
                key: "workspace:\(selectedWorkspaceID):threads",
                ownerScope: ownerScope,
                apiBase: apiBase,
                allowExpired: true
            )
            let legacyThreads = retainedLegacySnapshot?.workspaces
                .first(where: { $0.id == selectedWorkspaceID })?.threads
            replaceThreads(cachedThreads ?? legacyThreads ?? [], in: selectedWorkspaceID)

            let preferredThreadID = navigation?.threadsByWorkspace[selectedWorkspaceID] ?? nil
                ?? retainedLegacySnapshot?.selectedThreadID
            let availableThreads = workspace(withID: selectedWorkspaceID)?.threads ?? []
            selectedThreadID = [preferredThreadID, availableThreads.first?.id]
                .compactMap { $0 }
                .first(where: { candidate in
                    availableThreads.contains(where: { $0.id == candidate })
                }) ?? ""

            if !selectedThreadID.isEmpty {
                let cachedHistory: ThreadHistoryCacheValue? = await serverStateCache.cachedValue(
                    ThreadHistoryCacheValue.self,
                    key: latestHistoryCacheKey(
                        workspaceID: selectedWorkspaceID,
                        threadID: selectedThreadID
                    ),
                    ownerScope: ownerScope,
                    apiBase: apiBase,
                    allowExpired: true
                )
                if let cachedHistory {
                    publishMessages(cachedHistory.messages, for: selectedThreadID)
                    historyStateByThreadID[selectedThreadID] = AthenaThreadHistoryState(
                        page: cachedHistory.page
                    )
                    updateThread(selectedThreadID) { thread in
                        var metadata = cachedHistory.thread
                        metadata.messages = []
                        thread = metadata
                    }
                }
            }
        }
        loadState = .stale("正在查看本机缓存，内容可能不是最新状态。")
        hasCachedFallback = false
        return true
    }

    func loadThreads(for workspaceID: String, forceRefresh: Bool = false) async throws {
        guard source == .live,
              let api,
              let ownerScope,
              workspace(withID: workspaceID) != nil else {
            return
        }

        do {
            let threads = try await serverStateCache.load(
                [AthenaThread].self,
                key: "workspace:\(workspaceID):threads",
                ownerScope: ownerScope,
                apiBase: apiClient?.configuration.normalizedBaseURL,
                policy: .threadList,
                forceRefresh: forceRefresh,
                task: AthenaTaskDescriptor(
                    label: "workspace:threads",
                    kind: "workspace-thread",
                    priority: .p0,
                    intentRank: 12,
                    executionClass: .navigation,
                    policy: .foreground,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "thread-list",
                        workspaceID: workspaceID
                    ),
                    dedupeKey: "workspace:threads:\(ownerScope):\(workspaceID)"
                )
            ) {
                try await api.fetchThreads(workspaceID: workspaceID)
            }
            replaceThreads(threads, in: workspaceID)
            loadedThreadWorkspaceIDs.insert(workspaceID)
            saveSnapshot()
        } catch {
            if workspace(withID: workspaceID)?.threads.isEmpty == false {
                loadState = .stale(error.localizedDescription)
                return
            }
            throw error
        }
    }

    func selectThread(_ threadID: String) async {
        guard let workspaceID = workspaceID(containing: threadID) else {
            return
        }
        let previousThreadID = selectedThreadID
        navigationGeneration &+= 1
        let generation = navigationGeneration
        selectedWorkspaceID = workspaceID
        selectedThreadID = threadID
        saveSnapshot()
        onSelectionChanged?(workspaceID, threadID)

        if !previousThreadID.isEmpty, previousThreadID != threadID, let ownerScope {
            await taskScheduler.cancelScope(
                workspaceScope(
                    owner: ownerScope,
                    surface: nil,
                    workspaceID: self.workspaceID(containing: previousThreadID),
                    threadID: previousThreadID
                ),
                reason: "thread-switch"
            )
        }

        if source == .live {
            do {
                try await loadInitialHistory(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    generation: generation
                )
                try ensureCurrent(generation: generation, owner: ownerScope)
                try await persistRecentNavigation(generation: generation)
            } catch {
                lastError = error.localizedDescription
                if messagesByThreadID[threadID] == nil {
                    loadState = .stale(error.localizedDescription)
                }
            }
        }
    }

    func messages(for threadID: String) -> [AthenaChatMessage] {
        messagesByThreadID[threadID]
            ?? thread(withID: threadID)?.messages
            ?? []
    }

    func containsMessage(_ messageID: String, in threadID: String) -> Bool {
        messageIndexByThreadID[threadID]?[messageID] != nil
    }

    func message(withID messageID: String, in threadID: String) -> AthenaChatMessage? {
        guard let index = messageIndexByThreadID[threadID]?[messageID],
              let messages = messagesByThreadID[threadID],
              messages.indices.contains(index) else {
            return nil
        }
        return messages[index]
    }

    func threadModel(for threadID: String) -> ThreadChatModel {
        guard let workspaceID = workspaceID(containing: threadID),
              let workspace = workspace(withID: workspaceID) else {
            return .pro
        }
        return ThreadChatModel.resolved(
            threadModel: thread(withID: threadID)?.chatModel,
            workspaceModel: workspace.chatModel
        )
    }

    func setThreadModel(_ model: ThreadChatModel, for threadID: String) async throws {
        guard source == .live,
              let api,
              let ownerScope,
              let workspaceID = workspaceID(containing: threadID),
              let previousThread = thread(withID: threadID) else {
            throw APIClientError.authenticationRequired
        }
        guard threadModelUpdateHandles[threadID] == nil else {
            throw APIClientError.superseded
        }
        let previousModel = previousThread.chatModel
        let previousWorkspaceModel = workspace(withID: workspaceID)?.chatModel
        let confirmedModel = confirmedModelByThreadID[threadID] ?? threadModel(for: threadID)
        let actionID = UUID().uuidString.lowercased()
        guard threadModel(for: threadID) != model else {
            return
        }

        let scope = workspaceScope(
            owner: ownerScope,
            surface: "model-selector",
            workspaceID: workspaceID,
            threadID: threadID
        )
        optimisticActionCenter.begin(id: actionID, type: .updateThreadModel, scope: scope)
        modelActionIDByThreadID[threadID] = actionID
        withAnimation(.smooth) {
            updateThread(threadID) { thread in
                thread.chatModel = model
            }
            if previousThread.isOverview,
               let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) {
                workspaces[workspaceIndex].chatModel = model
            }
        }
        modelUpdatingThreadIDs.insert(threadID)
        modelUpdateErrorByThreadID[threadID] = nil
        saveSnapshot()
        try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)

        func submitModelUpdate() async throws -> ThreadChatModel {
            let isOverview = previousThread.isOverview
            let syncSubmit = submitSyncV2Mutation
            let syncNodeKey = isOverview
                ? workspace(withID: workspaceID)?.serverID.map { "workspaces/\($0)/metadata" }
                : previousThread.serverID.map { "threads/\($0)/metadata" }
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    id: actionID,
                    label: isOverview ? "workspace:model:update" : "thread:model:update",
                    kind: isOverview ? "workspace-model-write" : "thread-model-write",
                    priority: .p0,
                    intentRank: 1,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "model:update:\(ownerScope):\(workspaceID):\(threadID):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { context in
                try context.checkCancellation()
                if isOverview {
                    if let syncNodeKey {
                        let submitted = try await syncSubmit?(
                            syncNodeKey,
                            actionID,
                            ["chatModel"],
                            .object(["chatModel": .string(model.rawValue)])
                        ) ?? false
                        if submitted { return model }
                    }
                    let workspace = try await api.updateWorkspaceModel(
                        workspaceID: workspaceID,
                        model: model,
                        sourceActionID: actionID
                    )
                    return workspace.chatModel ?? model
                }
                if let syncNodeKey {
                    let submitted = try await syncSubmit?(
                        syncNodeKey,
                        actionID,
                        ["chatModel"],
                        .object(["chatModel": .string(model.rawValue)])
                    ) ?? false
                    if submitted { return model }
                }
                let thread = try await api.updateThreadModel(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    model: model,
                    sourceActionID: actionID
                )
                return thread.chatModel ?? model
            }
            threadModelUpdateHandles[threadID] = handle
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            return try await handle.value
        }

        do {
            let confirmedModel: ThreadChatModel
            do {
                confirmedModel = try await submitModelUpdate()
            } catch {
                let directive = recoveryCenter.classify(error)
                guard directive.disposition == .securityRecovery,
                      await restoreMutationSecurity?() == true else {
                    throw error
                }
                confirmedModel = try await submitModelUpdate()
            }
            guard modelActionIDByThreadID[threadID] == actionID else {
                throw APIClientError.superseded
            }
            updateThread(threadID) { thread in
                thread.chatModel = confirmedModel
            }
            if previousThread.isOverview,
               let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) {
                workspaces[workspaceIndex].chatModel = confirmedModel
            }
            confirmedModelByThreadID[threadID] = confirmedModel
            threadModelUpdateHandles[threadID] = nil
            modelActionIDByThreadID[threadID] = nil
            modelActionsConfirmedBySync.remove(actionID)
            modelUpdatingThreadIDs.remove(threadID)
            optimisticActionCenter.confirm(actionID)
            saveSnapshot()
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
        } catch {
            if modelActionsConfirmedBySync.contains(actionID) {
                confirmedModelByThreadID[threadID] = threadModel(for: threadID)
                threadModelUpdateHandles[threadID] = nil
                modelActionIDByThreadID[threadID] = nil
                modelActionsConfirmedBySync.remove(actionID)
                modelUpdatingThreadIDs.remove(threadID)
                optimisticActionCenter.confirm(actionID)
                saveSnapshot()
                try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
                return
            }
            updateThread(threadID) { thread in
                thread.chatModel = previousModel ?? confirmedModel
            }
            if previousThread.isOverview,
               let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) {
                workspaces[workspaceIndex].chatModel = previousWorkspaceModel
            }
            threadModelUpdateHandles[threadID] = nil
            modelActionIDByThreadID[threadID] = nil
            modelActionsConfirmedBySync.remove(actionID)
            modelUpdatingThreadIDs.remove(threadID)
            modelUpdateErrorByThreadID[threadID] = error.localizedDescription
            lastError = error.localizedDescription
            optimisticActionCenter.rollBack(actionID)
            recoveryCenter.present(recoveryCenter.classify(error), title: "无法切换模型")
            saveSnapshot()
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
            throw error
        }
    }

    func historyState(for threadID: String) -> AthenaThreadHistoryState {
        historyStateByThreadID[threadID] ?? AthenaThreadHistoryState()
    }

    func historyRevision(for threadID: String) -> Int {
        thread(withID: threadID)?.historyRevision ?? 0
    }

    func saveLocalConversationViewport(_ snapshot: LocalConversationViewportSnapshot) {
        guard source == .live,
              let ownerScope,
              let apiClient,
              workspaceID(containing: snapshot.threadID) == snapshot.workspaceID else {
            return
        }
        do {
            try localCache.saveConversationViewport(
                snapshot,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL
            )
            localConversationViewport = snapshot
        } catch {
            lastError = error.localizedDescription
        }
    }

    func resolveLocalViewportMessage(
        for threadID: String,
        snapshot: LocalConversationViewportSnapshot
    ) async -> String? {
        guard selectedThreadID == threadID else { return nil }

        while selectedThreadID == threadID {
            let currentMessages = messages(for: threadID)
            if let messageID = snapshot.messageID,
               currentMessages.contains(where: { $0.id == messageID }) {
                return messageID
            }
            guard historyState(for: threadID).hasOlder else {
                return nearestMessageID(to: snapshot.chatID, in: currentMessages)
            }
            let loaded = await loadOlderHistoryPage(
                for: threadID,
                priority: .p1,
                policy: .visible,
                intentRank: 4
            )
            guard loaded else {
                return nearestMessageID(to: snapshot.chatID, in: messages(for: threadID))
            }
        }
        return nil
    }

    func loadOlderHistory(for threadID: String) async {
        _ = await loadOlderHistoryPage(
            for: threadID,
            priority: .p3,
            policy: .prefetch,
            intentRank: 0
        )
    }

    private func loadOlderHistoryPage(
        for threadID: String,
        priority: AthenaTaskPriority,
        policy: AthenaTaskPolicy,
        intentRank: Int
    ) async -> Bool {
        guard source == .live,
              let api,
              let ownerScope,
              selectedThreadID == threadID,
              let workspaceID = workspaceID(containing: threadID) else {
            return false
        }
        var state = historyState(for: threadID)
        guard !state.isLoadingInitial,
              !state.isLoadingOlder,
              state.page?.hasOlder == true,
              let beforeChatID = state.page?.olderBeforeChatID else {
            return false
        }

        let generation = navigationGeneration
        state.isLoadingOlder = true
        state.olderPageError = nil
        historyStateByThreadID[threadID] = state

        do {
            let result = try await serverStateCache.load(
                AthenaThreadHistoryPage.self,
                key: olderHistoryCacheKey(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    beforeChatID: beforeChatID
                ),
                ownerScope: ownerScope,
                apiBase: apiClient?.configuration.normalizedBaseURL,
                policy: .olderHistoryPage(threadID: threadID),
                task: AthenaTaskDescriptor(
                    label: "workspace:history-older",
                    kind: "prefetch",
                    priority: priority,
                    intentRank: intentRank,
                    policy: policy,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "history-older",
                        workspaceID: workspaceID,
                        threadID: threadID
                    ),
                    dedupeKey: "history:older:\(ownerScope):\(workspaceID):\(threadID):\(beforeChatID)"
                )
            ) {
                if self.thread(withID: threadID)?.isOverview == true {
                    return try await api.fetchOlderOverviewHistory(
                        workspaceID: workspaceID,
                        overviewThreadID: threadID,
                        beforeChatID: beforeChatID
                    )
                }
                return try await api.fetchOlderThreadHistory(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    beforeChatID: beforeChatID
                )
            }
            try ensureCurrent(generation: generation, owner: ownerScope, threadID: threadID)
            await MarkdownRenderCache.shared.prewarm(result.messages)
            publishMessages(mergeHistory(
                older: result.messages,
                current: messages(for: threadID)
            ), for: threadID)
            state = historyState(for: threadID)
            state.page = result.page
            state.isLoadingOlder = false
            state.olderPageError = nil
            historyStateByThreadID[threadID] = state
            return true
        } catch is CancellationError {
            state = historyState(for: threadID)
            state.isLoadingOlder = false
            historyStateByThreadID[threadID] = state
            return false
        } catch AthenaTaskSchedulerError.cancelled {
            state = historyState(for: threadID)
            state.isLoadingOlder = false
            historyStateByThreadID[threadID] = state
            return false
        } catch AthenaTaskSchedulerError.stale {
            state = historyState(for: threadID)
            state.isLoadingOlder = false
            historyStateByThreadID[threadID] = state
            return false
        } catch {
            guard selectedThreadID == threadID else {
                return false
            }
            state = historyState(for: threadID)
            state.isLoadingOlder = false
            state.olderPageError = error.localizedDescription
            historyStateByThreadID[threadID] = state
            return false
        }
    }

    private func nearestMessageID(
        to chatID: Int?,
        in messages: [AthenaChatMessage]
    ) -> String? {
        guard let chatID else { return messages.first?.id }
        return messages
            .compactMap { message in
                message.chatID.map { (message.id, abs($0 - chatID)) }
            }
            .min { lhs, rhs in lhs.1 < rhs.1 }?
            .0 ?? messages.first?.id
    }

    private func priorityMarkdownMessages(
        in messages: [AthenaChatMessage],
        threadID: String
    ) -> [AthenaChatMessage] {
        guard !messages.isEmpty else { return [] }
        guard let snapshot = localConversationViewport,
              snapshot.threadID == threadID,
              !snapshot.isAtBottom else {
            return Array(messages.suffix(8))
        }

        let targetIndex: Int?
        if let messageID = snapshot.messageID {
            targetIndex = messages.firstIndex { $0.id == messageID }
        } else if let nearestID = nearestMessageID(
            to: snapshot.chatID,
            in: messages
        ) {
            targetIndex = messages.firstIndex { $0.id == nearestID }
        } else {
            targetIndex = nil
        }

        guard let targetIndex else {
            return Array(messages.suffix(8))
        }
        let lowerBound = max(targetIndex - 3, messages.startIndex)
        let upperBound = min(targetIndex + 5, messages.endIndex)
        return Array(messages[lowerBound..<upperBound])
    }

    func appendPreviewMessage(_ message: AthenaChatMessage, to threadID: String) {
        guard isPreview else {
            return
        }
        var messages = messages(for: threadID)
        messages.append(message)
        publishMessages(messages, for: threadID)
    }

    func isOptimisticResource(_ id: String) -> Bool {
        id.hasPrefix("optimistic:")
    }

    func isThreadAwaitingCreation(_ threadID: String) -> Bool {
        optimisticResourceActionIDs[threadID] != nil
    }

    func isCreatingThread(in workspaceID: String) -> Bool {
        workspace(withID: workspaceID)?.threads.contains(where: { isThreadAwaitingCreation($0.id) }) == true
    }

    @discardableResult
    func createWorkspace(named rawName: String) async -> String? {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        if isPreview {
            let workspaceID = "preview-workspace-\(UUID().uuidString.lowercased())"
            let threadID = "\(workspaceID)-new-thread"
            workspaces.insert(
                AthenaWorkspace(
                    id: workspaceID,
                    title: name,
                    threads: [AthenaThread(id: threadID, workspaceID: workspaceID, title: "新线程")]
                ),
                at: 0
            )
            selectedWorkspaceID = workspaceID
            selectedThreadID = threadID
            return threadID
        }
        guard let api, let ownerScope else { return nil }

        let actionID = UUID().uuidString.lowercased()
        let temporaryWorkspaceID = "optimistic:workspace:\(actionID)"
        let temporaryThreadID = "optimistic:thread:\(actionID)"
        let previousSelection = (selectedWorkspaceID, selectedThreadID)
        let scope = workspaceScope(owner: ownerScope, surface: "create-workspace")
        optimisticActionCenter.begin(id: actionID, type: .createWorkspace, scope: scope)
        optimisticResourceActionIDs[temporaryWorkspaceID] = actionID
        optimisticResourceActionIDs[temporaryThreadID] = actionID
        withAnimation(.smooth) {
            workspaces.insert(
                AthenaWorkspace(
                    id: temporaryWorkspaceID,
                    sourceActionID: actionID,
                    title: name,
                    threads: [
                        AthenaThread(
                            id: temporaryThreadID,
                            sourceActionID: actionID,
                            workspaceID: temporaryWorkspaceID,
                            title: "新线程"
                        ),
                    ]
                ),
                at: 0
            )
            selectedWorkspaceID = temporaryWorkspaceID
            selectedThreadID = temporaryThreadID
        }

        do {
            let descriptor = AthenaTaskDescriptor(
                id: actionID,
                label: "workspace:create",
                kind: "workspace-write",
                priority: .p0,
                intentRank: 1,
                executionClass: .interactiveMutation,
                policy: .foreground,
                scope: scope,
                dedupeKey: "workspace:create:\(ownerScope):\(actionID)",
                isProtected: true,
                isAbortable: false
            )
            let handle = try await taskScheduler.schedule(descriptor) { context in
                try context.checkCancellation()
                return try await api.createWorkspace(name: name, sourceActionID: actionID)
            }
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            let confirmed = try await handle.value
            await confirmCreatedWorkspace(
                confirmed,
                temporaryWorkspaceID: temporaryWorkspaceID,
                temporaryThreadID: temporaryThreadID,
                actionID: actionID
            )
            return selectedThreadID
        } catch {
            let directive = recoveryCenter.classify(error)
            if directive.disposition == .reconcile {
                optimisticActionCenter.update(actionID, status: .reconciling)
                await reconcileOptimisticAction(actionID)
                if !workspaces.contains(where: { $0.id == temporaryWorkspaceID }) {
                    return selectedThreadID
                }
                recoveryCenter.present(directive)
                return temporaryThreadID
            }
            rollBackCreatedWorkspace(
                temporaryWorkspaceID: temporaryWorkspaceID,
                actionID: actionID,
                previousSelection: previousSelection
            )
            recoveryCenter.present(directive)
            return nil
        }
    }

    @discardableResult
    func createThread(in workspaceID: String) -> String? {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            return nil
        }
        if isPreview {
            let threadID = "preview-thread-\(UUID().uuidString.lowercased())"
            workspaces[workspaceIndex].threads.insert(
                AthenaThread(id: threadID, workspaceID: workspaceID, title: "新线程"),
                at: 0
            )
            selectedWorkspaceID = workspaceID
            selectedThreadID = threadID
            return threadID
        }
        guard let api, let ownerScope, !isOptimisticResource(workspaceID) else { return nil }

        let actionID = UUID().uuidString.lowercased()
        let temporaryThreadID = "optimistic:thread:\(actionID)"
        let previousThreadID = selectedThreadID
        let scope = workspaceScope(
            owner: ownerScope,
            surface: "create-thread",
            workspaceID: workspaceID
        )
        optimisticActionCenter.begin(id: actionID, type: .createThread, scope: scope)
        optimisticResourceActionIDs[temporaryThreadID] = actionID
        withAnimation(.smooth) {
            workspaces[workspaceIndex].threads.insert(
                AthenaThread(
                    id: temporaryThreadID,
                    sourceActionID: actionID,
                    workspaceID: workspaceID,
                    title: "新线程"
                ),
                at: 0
            )
            selectedWorkspaceID = workspaceID
            selectedThreadID = temporaryThreadID
        }

        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.finishCreatingThread(
                api: api,
                ownerScope: ownerScope,
                workspaceID: workspaceID,
                temporaryThreadID: temporaryThreadID,
                previousThreadID: previousThreadID,
                actionID: actionID,
                scope: scope
            )
        }
        return temporaryThreadID
    }

    private func finishCreatingThread(
        api: WorkspaceAPI,
        ownerScope: String,
        workspaceID: String,
        temporaryThreadID: String,
        previousThreadID: String,
        actionID: String,
        scope: AthenaTaskScope
    ) async {
        do {
            let descriptor = AthenaTaskDescriptor(
                id: actionID,
                label: "thread:create",
                kind: "thread-write",
                priority: .p0,
                intentRank: 0,
                executionClass: .interactiveMutation,
                policy: .foreground,
                scope: scope,
                dedupeKey: "thread:create:\(ownerScope):\(workspaceID):\(actionID)",
                isProtected: true,
                isAbortable: false
            )
            let handle = try await taskScheduler.schedule(descriptor) { context in
                try context.checkCancellation()
                return try await api.createThread(
                    workspaceID: workspaceID,
                    sourceActionID: actionID
                )
            }
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            let confirmed = try await handle.value
            await confirmCreatedThread(
                confirmed,
                workspaceID: workspaceID,
                temporaryThreadID: temporaryThreadID,
                actionID: actionID
            )
        } catch {
            let directive = recoveryCenter.classify(error)
            if directive.disposition == .reconcile {
                optimisticActionCenter.update(actionID, status: .reconciling)
                await reconcileOptimisticAction(actionID)
                if !isThreadAwaitingCreation(temporaryThreadID) {
                    return
                }
                recoveryCenter.present(directive)
                return
            }
            removeThread(temporaryThreadID, from: workspaceID)
            optimisticResourceActionIDs[temporaryThreadID] = nil
            optimisticActionCenter.rollBack(actionID)
            selectedThreadID = previousThreadID
            recoveryCenter.present(directive)
        }
    }

    func renameThread(_ threadID: String, to rawTitle: String) async {
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty,
              let workspaceID = workspaceID(containing: threadID),
              let previousThread = thread(withID: threadID),
              previousThread.title != title else {
            return
        }

        if isPreview {
            withAnimation(.smooth) {
                updateThread(threadID) { $0.title = title }
            }
            return
        }
        guard let api, let ownerScope else { return }

        let actionID = UUID().uuidString.lowercased()
        let scope = workspaceScope(
            owner: ownerScope,
            surface: "rename-thread",
            workspaceID: workspaceID,
            threadID: threadID
        )
        optimisticActionCenter.begin(id: actionID, type: .renameThread, scope: scope)
        optimisticMutationSnapshots[actionID] = .threadTitle(
            workspaceID: workspaceID,
            threadID: threadID,
            previousTitle: previousThread.title
        )
        withAnimation(.smooth) {
            updateThread(threadID) { $0.title = title }
        }
        saveSnapshot()

        do {
            let syncSubmit = submitSyncV2Mutation
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    id: actionID,
                    label: "thread:rename",
                    kind: "thread-write",
                    priority: .p0,
                    intentRank: 1,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "thread:rename:\(ownerScope):\(threadID):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { context in
                try context.checkCancellation()
                if let serverID = previousThread.serverID {
                    let submitted = try await syncSubmit?(
                        "threads/\(serverID)/metadata",
                        actionID,
                        ["name"],
                        .object(["name": .string(title)])
                    ) ?? false
                    if submitted {
                        var confirmed = previousThread
                        confirmed.title = title
                        return confirmed
                    }
                }
                return try await api.renameThread(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    title: title,
                    sourceActionID: actionID
                )
            }
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            let confirmed = try await handle.value
            withAnimation(.smooth) {
                updateThread(threadID) { $0 = confirmed }
            }
            optimisticMutationSnapshots[actionID] = nil
            optimisticActionCenter.confirm(actionID)
            saveSnapshot()
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
        } catch {
            await resolveOptimisticFailure(actionID: actionID, error: error)
        }
    }

    func renameWorkspace(_ workspaceID: String, to rawTitle: String) async {
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty,
              let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }),
              workspaces[workspaceIndex].title != title else {
            return
        }

        if isPreview {
            withAnimation(.smooth) { workspaces[workspaceIndex].title = title }
            return
        }
        guard let api, let ownerScope else { return }

        let previousTitle = workspaces[workspaceIndex].title
        let previousWorkspace = workspaces[workspaceIndex]
        let actionID = UUID().uuidString.lowercased()
        let scope = workspaceScope(owner: ownerScope, surface: "rename-workspace", workspaceID: workspaceID)
        optimisticActionCenter.begin(id: actionID, type: .renameWorkspace, scope: scope)
        optimisticMutationSnapshots[actionID] = .workspaceTitle(
            workspaceID: workspaceID,
            previousTitle: previousTitle
        )
        withAnimation(.smooth) { workspaces[workspaceIndex].title = title }
        saveSnapshot()

        do {
            let syncSubmit = submitSyncV2Mutation
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    id: actionID,
                    label: "workspace:rename",
                    kind: "workspace-write",
                    priority: .p0,
                    intentRank: 1,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "workspace:rename:\(ownerScope):\(workspaceID):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { context in
                try context.checkCancellation()
                if let serverID = previousWorkspace.serverID {
                    let submitted = try await syncSubmit?(
                        "workspaces/\(serverID)/metadata",
                        actionID,
                        ["name"],
                        .object(["name": .string(title)])
                    ) ?? false
                    if submitted {
                        var confirmed = previousWorkspace
                        confirmed.title = title
                        return confirmed
                    }
                }
                return try await api.renameWorkspace(
                    workspaceID: workspaceID,
                    title: title,
                    sourceActionID: actionID
                )
            }
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            let confirmed = try await handle.value
            withAnimation(.smooth) {
                guard let index = workspaces.firstIndex(where: { $0.id == workspaceID }) else { return }
                workspaces[index].title = confirmed.title
                workspaces[index].chatModel = confirmed.chatModel
            }
            optimisticMutationSnapshots[actionID] = nil
            optimisticActionCenter.confirm(actionID)
            saveSnapshot()
        } catch {
            await resolveOptimisticFailure(actionID: actionID, error: error)
        }
    }

    func deleteThread(_ threadID: String) async {
        guard let workspaceID = workspaceID(containing: threadID),
              let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }),
              let threadIndex = workspaces[workspaceIndex].threads.firstIndex(where: { $0.id == threadID }) else {
            return
        }
        let removed = workspaces[workspaceIndex].threads[threadIndex]
        guard !removed.isOverview else {
            lastError = "概览线程不能删除。"
            return
        }

        if isPreview {
            removeThreadAndSelectFallback(threadID, from: workspaceID)
            return
        }
        guard let api, let ownerScope else { return }

        let actionID = UUID().uuidString.lowercased()
        let scope = workspaceScope(owner: ownerScope, surface: "delete-thread", workspaceID: workspaceID, threadID: threadID)
        let selection = (selectedWorkspaceID, selectedThreadID)
        optimisticActionCenter.begin(id: actionID, type: .deleteThread, scope: scope)
        optimisticMutationSnapshots[actionID] = .deletedThread(
            workspaceID: workspaceID,
            thread: removed,
            index: threadIndex,
            selection: selection
        )
        removeThreadAndSelectFallback(threadID, from: workspaceID)
        saveSnapshot()

        do {
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    id: actionID,
                    label: "thread:delete",
                    kind: "thread-write",
                    priority: .p0,
                    intentRank: 1,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "thread:delete:\(ownerScope):\(threadID):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { context in
                try context.checkCancellation()
                try await api.deleteThread(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    sourceActionID: actionID
                )
            }
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            try await handle.value
            optimisticMutationSnapshots[actionID] = nil
            optimisticActionCenter.confirm(actionID)
            await removeDrawerPins(workspaceID: workspaceID, threadID: threadID)
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
            saveSnapshot()
        } catch {
            await resolveOptimisticFailure(actionID: actionID, error: error)
        }
    }

    func deleteWorkspace(_ workspaceID: String) async {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else { return }
        let removed = workspaces[workspaceIndex]

        if isPreview {
            removeWorkspaceAndSelectFallback(workspaceID)
            return
        }
        guard let api, let ownerScope else { return }

        let actionID = UUID().uuidString.lowercased()
        let scope = workspaceScope(owner: ownerScope, surface: "delete-workspace", workspaceID: workspaceID)
        let selection = (selectedWorkspaceID, selectedThreadID)
        optimisticActionCenter.begin(id: actionID, type: .deleteWorkspace, scope: scope)
        optimisticMutationSnapshots[actionID] = .deletedWorkspace(
            workspace: removed,
            index: workspaceIndex,
            selection: selection
        )
        removeWorkspaceAndSelectFallback(workspaceID)
        saveSnapshot()

        do {
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    id: actionID,
                    label: "workspace:delete",
                    kind: "workspace-write",
                    priority: .p0,
                    intentRank: 1,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "workspace:delete:\(ownerScope):\(workspaceID):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { context in
                try context.checkCancellation()
                return try await api.deleteWorkspace(
                    workspaceID: workspaceID,
                    sourceActionID: actionID
                )
            }
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            let completed = try await handle.value
            if completed {
                optimisticMutationSnapshots[actionID] = nil
                optimisticActionCenter.confirm(actionID)
            } else {
                optimisticActionCenter.update(actionID, status: .reconciling)
            }
            saveSnapshot()
        } catch {
            await resolveOptimisticFailure(actionID: actionID, error: error)
        }
    }

    @discardableResult
    func enqueueMessage(_ rawText: String, to threadID: String) -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return false
        }
        guard !isThreadAwaitingCreation(threadID) else {
            sendErrorByThreadID[threadID] = "线程仍在创建中，请稍候。"
            return false
        }
        guard source == .live,
              let chatStreamClient,
              let agentControlKit,
              let ownerScope,
              let workspaceID = workspaceID(containing: threadID),
              selectedThreadID == threadID,
              chatStreamHandles[threadID] == nil else {
            sendErrorByThreadID[threadID] = "当前会话暂时无法发送，请稍后重试。"
            return false
        }

        let clientTurnID = UUID().uuidString.lowercased()
        let actionID = clientTurnID
        let sendsToWorkspace = thread(withID: threadID)?.isOverview == true
        optimisticActionCenter.begin(
            id: actionID,
            type: .sendChat,
            scope: workspaceScope(
                owner: ownerScope,
                surface: "chat-send",
                workspaceID: workspaceID,
                threadID: threadID,
                transport: "sse"
            )
        )
        withAnimation(.smooth) {
            appendMessage(
                AthenaChatMessage(
                    id: "\(threadID):local:\(clientTurnID):user",
                    role: .user,
                    text: text,
                    sentAt: Date().timeIntervalSince1970,
                    clientTurnID: clientTurnID,
                    deliveryState: .pending
                ),
                to: threadID
            )
        }
        sendingThreadIDs.insert(threadID)
        activeClientTurnIDByThreadID[threadID] = clientTurnID
        sendErrorByThreadID[threadID] = nil

        Task { @MainActor [weak self] in
            await self?.startMessageStream(
                text: text,
                threadID: threadID,
                workspaceID: workspaceID,
                clientTurnID: clientTurnID,
                sendsToWorkspace: sendsToWorkspace,
                chatStreamClient: chatStreamClient,
                agentControlKit: agentControlKit,
                ownerScope: ownerScope
            )
        }
        return true
    }

    @discardableResult
    func beginChatEdit(messageID: String, in threadID: String) -> Bool {
        guard source == .live,
              selectedThreadID == threadID,
              chatStreamHandles[threadID] == nil,
              let message = messages(for: threadID).first(where: { $0.id == messageID }),
              message.role == .user,
              message.isConfirmed,
              let chatID = message.chatID else {
            return false
        }
        chatEditSession = AthenaChatEditSession(
            threadID: threadID,
            messageID: message.id,
            startingChatID: chatID,
            publicChatID: message.publicChatID,
            originalText: message.text,
            submittedText: nil,
            sourceActionID: nil,
            clientTurnID: nil,
            phase: .editing
        )
        timelineRevisionByThreadID[threadID, default: 0] &+= 1
        return true
    }

    func cancelChatEdit(in threadID: String? = nil) {
        guard let session = chatEditSession,
              threadID == nil || session.threadID == threadID,
              session.phase == .editing else {
            return
        }
        chatEditSession = nil
        timelineRevisionByThreadID[session.threadID, default: 0] &+= 1
    }

    @discardableResult
    func commitChatEdit(_ rawText: String, in threadID: String) -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              source == .live,
              let ownerScope,
              let workspaceID = workspaceID(containing: threadID),
              let chatStreamClient,
              let agentControlKit,
              var session = chatEditSession,
              session.threadID == threadID,
              session.phase == .editing,
              chatStreamHandles[threadID] == nil else {
            return false
        }

        let actionID = UUID().uuidString.lowercased()
        let previousMessages = messages(for: threadID)
        optimisticMutationSnapshots[actionID] = .chatMessages(
            workspaceID: workspaceID,
            threadID: threadID,
            messages: previousMessages
        )
        optimisticActionCenter.begin(
            id: actionID,
            type: .editChat,
            scope: workspaceScope(
                owner: ownerScope,
                surface: "chat-edit-stream",
                workspaceID: workspaceID,
                threadID: threadID,
                transport: "sse"
            )
        )

        let pending = AthenaChatMessage(
            id: "\(threadID):local:\(actionID):user",
            role: .user,
            text: text,
            sentAt: Date().timeIntervalSince1970,
            clientTurnID: actionID,
            deliveryState: .pending
        )
        withAnimation(.smooth) {
            let prefix = previousMessages.filter { message in
                guard let chatID = message.chatID else { return false }
                return chatID < session.startingChatID
            }
            let nextMessages = ChatMessageReconciler.canonical(
                deduplicating: prefix + [pending]
            )
            publishMessages(nextMessages, for: threadID)
            updateThread(threadID) { $0.messages = nextMessages }
        }

        session.submittedText = text
        session.sourceActionID = actionID
        session.clientTurnID = actionID
        session.phase = .submitting
        chatEditSession = session
        sendingThreadIDs.insert(threadID)
        activeClientTurnIDByThreadID[threadID] = actionID
        sendErrorByThreadID[threadID] = nil

        let editContext = ChatStreamEditContext(
            startingChatId: session.startingChatID,
            sourceActionId: actionID
        )
        Task { @MainActor [weak self] in
            await self?.startMessageStream(
                text: text,
                threadID: threadID,
                workspaceID: workspaceID,
                clientTurnID: actionID,
                sendsToWorkspace: self?.thread(withID: threadID)?.isOverview == true,
                chatStreamClient: chatStreamClient,
                agentControlKit: agentControlKit,
                ownerScope: ownerScope,
                editContext: editContext
            )
        }
        return true
    }

    func regenerateAssistantMessage(messageID: String, in threadID: String) async throws {
        guard let ownerScope,
              let workspaceID = workspaceID(containing: threadID),
              let chatStreamClient,
              let agentControlKit,
              chatStreamHandles[threadID] == nil,
              let message = messages(for: threadID).first(where: { $0.id == messageID }),
              message.role == .assistant,
              messages(for: threadID).last(where: {
                  $0.role == .assistant && $0.isConfirmed
              })?.id == messageID,
              let chatID = message.chatID,
              let userMessage = messages(for: threadID).first(where: {
                  $0.chatID == chatID && $0.role == .user
              }) else {
            throw APIClientError.invalidResponse
        }
        let clientTurnID = UUID().uuidString.lowercased()
        let previousMessages = messages(for: threadID)
        optimisticMutationSnapshots[clientTurnID] = .chatMessages(
            workspaceID: workspaceID,
            threadID: threadID,
            messages: previousMessages
        )
        optimisticActionCenter.begin(
            id: clientTurnID,
            type: .regenerateChat,
            scope: workspaceScope(
                owner: ownerScope,
                surface: "chat-regenerate",
                workspaceID: workspaceID,
                threadID: threadID,
                transport: "sse"
            )
        )
        withAnimation(.smooth) {
            let regeneratedUser = AthenaChatMessage(
                id: userMessage.id,
                role: .user,
                text: userMessage.text,
                sentAt: userMessage.sentAt ?? Date().timeIntervalSince1970,
                hydrationStatus: userMessage.hydrationStatus,
                clientTurnID: clientTurnID,
                deliveryState: .pending
            )
            let remaining = previousMessages.filter { candidate in
                candidate.chatID != chatID
            } + [regeneratedUser]
            let canonical = ChatMessageReconciler.canonical(deduplicating: remaining)
            publishMessages(canonical, for: threadID)
            updateThread(threadID) { $0.messages = canonical }
        }
        sendingThreadIDs.insert(threadID)
        activeClientTurnIDByThreadID[threadID] = clientTurnID
        sendErrorByThreadID[threadID] = nil

        await startMessageStream(
            text: userMessage.text,
            threadID: threadID,
            workspaceID: workspaceID,
            clientTurnID: clientTurnID,
            sendsToWorkspace: thread(withID: threadID)?.isOverview == true,
            chatStreamClient: chatStreamClient,
            agentControlKit: agentControlKit,
            ownerScope: ownerScope,
            regenerateContext: ChatStreamRegenerateContext(
                targetChatId: chatID,
                sourceActionId: clientTurnID
            )
        )
    }

    func stopGenerating(in threadID: String) {
        let agentSession = agentControlKit?.session(for: threadID)
        guard sendingThreadIDs.contains(threadID) || agentSession?.phase.isTerminal == false else {
            return
        }
        if let session = agentSession, !session.phase.isTerminal {
            let clientTurnID = activeClientTurnIDByThreadID[threadID] ?? session.clientTurnID
            Task { @MainActor [weak self, weak agentControlKit] in
                guard await agentControlKit?.stop(invocationID: session.invocationID) == true else {
                    return
                }
                if let clientTurnID {
                    self?.markClientTurn(clientTurnID, in: threadID, deliveryState: .stopped)
                    self?.optimisticActionCenter.update(clientTurnID, status: .reconciling)
                }
                self?.agentHandoffClientTurnIDs.remove(clientTurnID ?? "")
            }
        }
        chatStreamHandles[threadID]?.cancel()
        chatStreamHandles[threadID] = nil
        sendingThreadIDs.remove(threadID)
        if agentSession?.phase.isTerminal != false,
           let clientTurnID = activeClientTurnIDByThreadID.removeValue(forKey: threadID) {
            markClientTurn(clientTurnID, in: threadID, deliveryState: .stopped)
            optimisticActionCenter.update(clientTurnID, status: .reconciling)
        }
        sendErrorByThreadID[threadID] = nil
    }

    func deleteAssistantMessage(messageID: String, in threadID: String) async throws {
        try await deleteChatTurn(
            messageID: messageID,
            in: threadID,
            actionType: .deleteChat,
            errorTitle: "无法删除消息"
        )
    }

    func forkAssistantMessage(messageID: String, in threadID: String) async throws {
        guard let api,
              let ownerScope,
              let workspaceID = workspaceID(containing: threadID),
              let message = messages(for: threadID).first(where: { $0.id == messageID }),
              message.role == .assistant else {
            throw APIClientError.invalidResponse
        }
        let actionID = UUID().uuidString.lowercased()
        optimisticActionCenter.begin(
            id: actionID,
            type: .forkChat,
            scope: workspaceScope(
                owner: ownerScope,
                surface: "chat-fork",
                workspaceID: workspaceID,
                threadID: threadID
            )
        )
        do {
            let forkedThread = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: "chat:fork",
                    kind: "chat-mutation",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "chat-fork",
                        workspaceID: workspaceID,
                        threadID: threadID
                    ),
                    isProtected: true,
                    isAbortable: false
                )
            ) { _ in
                try await api.forkChat(
                    workspaceID: workspaceID,
                    threadID: self.thread(withID: threadID)?.isOverview == true ? nil : threadID,
                    chatID: message.chatID,
                    publicChatID: message.publicChatID,
                    sourceActionID: actionID
                )
            }
            insertOrReplaceThread(forkedThread, in: workspaceID)
            optimisticActionCenter.confirm(actionID)
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
            await selectThread(forkedThread.id)
        } catch {
            optimisticActionCenter.fail(actionID)
            recoveryCenter.present(recoveryCenter.classify(error), title: "无法创建分支")
            throw error
        }
    }

    private func startMessageStream(
        text: String,
        threadID: String,
        workspaceID: String,
        clientTurnID: String,
        sendsToWorkspace: Bool,
        chatStreamClient: ChatStreamClient,
        agentControlKit: AgentControlKit,
        ownerScope: String,
        editContext: ChatStreamEditContext? = nil,
        regenerateContext: ChatStreamRegenerateContext? = nil
    ) async {
        let actionID = clientTurnID
        if let pendingModelUpdate = threadModelUpdateHandles[threadID] {
            do {
                _ = try await pendingModelUpdate.value
            } catch {
                sendingThreadIDs.remove(threadID)
                activeClientTurnIDByThreadID[threadID] = nil
                sendErrorByThreadID[threadID] = error.localizedDescription
                markClientTurn(clientTurnID, in: threadID, deliveryState: .failed)
                optimisticActionCenter.fail(actionID)
                recoveryCenter.present(recoveryCenter.classify(error), title: "消息未发送")
                return
            }
        }

        do {
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    label: "chat:stream",
                    kind: "chat-stream",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: editContext == nil && regenerateContext == nil
                        ? .currentContent
                        : .interactiveMutation,
                    policy: .realtime,
                    resource: .realtime,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "chat-stream",
                        workspaceID: workspaceID,
                        threadID: threadID,
                        transport: "sse"
                    ),
                    dedupeKey: "chat:stream:\(ownerScope):\(workspaceID):\(threadID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { [weak self] context in
                try context.checkCancellation()
                guard let self else {
                    throw CancellationError()
                }
                let streamRequest = ChatStreamRequest(
                    message: text,
                    clientTurnID: clientTurnID,
                    editContext: editContext,
                    regenerateContext: regenerateContext
                )
                let displayBuffer = await MainActor.run {
                    let buffer = ChatStreamDisplayBuffer { event in
                        self.applyChatStreamEvent(
                            event,
                            workspaceID: workspaceID,
                            threadID: threadID,
                            clientTurnID: clientTurnID,
                            editContext: editContext,
                            regenerateContext: regenerateContext,
                            agentControlKit: agentControlKit
                        )
                    }
                    buffer.setInteractionActive(self.conversationInteractionActive)
                    self.chatStreamDisplayBuffers[threadID] = buffer
                    return buffer
                }
                let onEvent: @MainActor (ChatStreamEvent) -> Void = { event in
                    displayBuffer.submit(event)
                }
                do {
                    if sendsToWorkspace {
                        try await chatStreamClient.consumeWorkspaceStream(
                            workspaceID: workspaceID,
                            request: streamRequest,
                            onEvent: onEvent
                        )
                    } else {
                        try await chatStreamClient.consumeThreadStream(
                            workspaceID: workspaceID,
                            threadID: threadID,
                            request: streamRequest,
                            onEvent: onEvent
                        )
                    }
                } catch {
                    await displayBuffer.finish()
                    await MainActor.run {
                        if self.chatStreamDisplayBuffers[threadID] === displayBuffer {
                            self.chatStreamDisplayBuffers[threadID] = nil
                        }
                    }
                    throw error
                }
                await displayBuffer.finish()
                await MainActor.run {
                    if self.chatStreamDisplayBuffers[threadID] === displayBuffer {
                        self.chatStreamDisplayBuffers[threadID] = nil
                    }
                }
            }
            chatStreamHandles[threadID] = handle
            optimisticActionCenter.update(actionID, status: .confirming, taskID: handle.id)
            Task { @MainActor [weak self] in
                do {
                    try await handle.value
                    let handedOffToAgent = self?.agentHandoffClientTurnIDs.contains(clientTurnID) == true
                    if !handedOffToAgent {
                        await self?.refreshServerConfirmedHistory(
                            workspaceID: workspaceID,
                            threadID: threadID
                        )
                        self?.optimisticMutationSnapshots[actionID] = nil
                        self?.optimisticActionCenter.confirm(actionID)
                        if self?.chatEditSession?.clientTurnID == clientTurnID {
                            self?.chatEditSession = nil
                        }
                    }
                } catch is CancellationError {
                    // Scope cancellation is expected during sign-out.
                } catch {
                    let failureHandledByStream = self?.abortedStreamClientTurnIDs.remove(clientTurnID) != nil
                    if !failureHandledByStream {
                        self?.sendErrorByThreadID[threadID] = error.localizedDescription
                        self?.markClientTurn(clientTurnID, in: threadID, deliveryState: .reconciling)
                        self?.optimisticActionCenter.update(actionID, status: .reconciling)
                        if let self {
                            self.recoveryCenter.present(self.recoveryCenter.classify(error))
                        }
                    }
                }
                guard self?.chatStreamHandles[threadID]?.id == handle.id else {
                    return
                }
                self?.chatStreamHandles[threadID] = nil
                self?.sendingThreadIDs.remove(threadID)
                self?.activeClientTurnIDByThreadID[threadID] = nil
            }
        } catch {
            sendingThreadIDs.remove(threadID)
            activeClientTurnIDByThreadID[threadID] = nil
            sendErrorByThreadID[threadID] = error.localizedDescription
            markClientTurn(clientTurnID, in: threadID, deliveryState: .reconciling)
            optimisticActionCenter.update(actionID, status: .reconciling)
            recoveryCenter.present(recoveryCenter.classify(error))
        }
    }

    @discardableResult
    func refreshHistoryAfterAgentFinalized(threadID: String) async -> Bool {
        guard source == .live else { return true }
        guard selectedThreadID == threadID else { return true }
        guard let workspaceID = workspaceID(containing: threadID) else {
            return false
        }
        if let ownerScope {
            await serverStateCache.markStale(
                key: latestHistoryCacheKey(workspaceID: workspaceID, threadID: threadID),
                ownerScope: ownerScope,
                apiBase: apiClient?.configuration.normalizedBaseURL
            )
        }
        do {
            try await loadInitialHistory(
                workspaceID: workspaceID,
                threadID: threadID,
                generation: navigationGeneration
            )
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func reconcileFinalizedAgentSession(_ session: AgentSessionSnapshot) async -> Bool {
        guard source == .live,
              workspaceID(containing: session.threadID) != nil else {
            return false
        }
        if let clientTurnID = session.clientTurnID {
            confirmClientTurn(
                clientTurnID,
                in: session.threadID,
                chatID: session.finalChatID,
                publicChatID: session.finalPublicChatID
            )
            optimisticMutationSnapshots[clientTurnID] = nil
            optimisticActionCenter.confirm(clientTurnID)
            agentHandoffClientTurnIDs.remove(clientTurnID)
        }
        return await refreshHistoryAfterAgentFinalized(threadID: session.threadID)
    }

    func applyUnifiedSyncInvalidation(
        workspaceID: String?,
        threadID: String?
    ) async {
        guard source == .live,
              let ownerScope,
              let apiClient else {
            return
        }
        let apiBase = apiClient.configuration.normalizedBaseURL
        if let workspaceID, let threadID {
            let scope = workspaceScope(
                owner: ownerScope,
                surface: nil,
                workspaceID: workspaceID,
                threadID: threadID
            )
            await serverStateCache.markScopeStale(
                scope,
                ownerScope: ownerScope,
                apiBase: apiBase
            )
            if selectedThreadID == threadID {
                try? await loadInitialHistory(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    generation: navigationGeneration
                )
            }
            return
        }
        if let workspaceID {
            await serverStateCache.markScopeStale(
                workspaceScope(
                    owner: ownerScope,
                    surface: nil,
                    workspaceID: workspaceID
                ),
                ownerScope: ownerScope,
                apiBase: apiBase
            )
            return
        }
        await serverStateCache.markStale(
            key: "workspace.list",
            ownerScope: ownerScope,
            apiBase: apiBase
        )
    }

    func refreshWorkspaceNavigationFromUnifiedSync() async {
        guard source == .live,
              let ownerScope,
              let apiClient,
              let api else {
            return
        }
        do {
            let refreshed = try await serverStateCache.load(
                [AthenaWorkspace].self,
                key: "workspace.list",
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .workspaceList,
                forceRefresh: true,
                task: AthenaTaskDescriptor(
                    label: "sync:workspace-list",
                    kind: "sync-navigation",
                    priority: .p1,
                    executionClass: .synchronization,
                    policy: .visible,
                    scope: workspaceScope(owner: ownerScope, surface: "workspace-list-sync"),
                    dedupeKey: "sync:workspace-list:\(ownerScope)"
                )
            ) {
                try await api.fetchWorkspaces()
            }
            mergeServerWorkspaces(refreshed)
            if let selectedWorkspaceID,
               !workspaces.contains(where: { $0.id == selectedWorkspaceID }) {
                self.selectedWorkspaceID = workspaces.first?.id
                selectedThreadID = ""
            }
            if self.selectedWorkspaceID == nil {
                self.selectedWorkspaceID = workspaces.first?.id
            }
            if let selectedWorkspaceID = self.selectedWorkspaceID {
                try await loadThreads(for: selectedWorkspaceID, forceRefresh: true)
                let availableThreads = workspace(withID: selectedWorkspaceID)?.threads ?? []
                if !availableThreads.contains(where: { $0.id == selectedThreadID }) {
                    selectedThreadID = availableThreads.first?.id ?? ""
                    onSelectionChanged?(selectedWorkspaceID, currentThreadID)
                }
            }
            saveSnapshot()
        } catch is CancellationError {
            return
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refreshThreadNavigationFromUnifiedSync(workspaceID: String) async {
        guard source == .live,
              let ownerScope,
              let apiClient,
              let api,
              workspace(withID: workspaceID) != nil else {
            return
        }
        do {
            let refreshed = try await serverStateCache.load(
                [AthenaThread].self,
                key: "workspace:\(workspaceID):threads",
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .threadList,
                forceRefresh: true,
                task: AthenaTaskDescriptor(
                    label: "sync:thread-list",
                    kind: "sync-navigation",
                    priority: .p1,
                    executionClass: .synchronization,
                    policy: .visible,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "thread-list-sync",
                        workspaceID: workspaceID
                    ),
                    dedupeKey: "sync:thread-list:\(ownerScope):\(workspaceID)"
                )
            ) {
                try await api.fetchThreads(workspaceID: workspaceID)
            }
            replaceThreads(refreshed, in: workspaceID)
            loadedThreadWorkspaceIDs.insert(workspaceID)
            if selectedWorkspaceID == workspaceID,
               !refreshed.contains(where: { $0.id == selectedThreadID }) {
                selectedThreadID = refreshed.first?.id ?? ""
                onSelectionChanged?(workspaceID, currentThreadID)
            }
            saveSnapshot()
        } catch is CancellationError {
            return
        } catch {
            lastError = error.localizedDescription
        }
    }

    func applySyncV2WorkspaceIndex(_ projected: [AthenaWorkspace]) async {
        guard source == .live else { return }
        let previousSelection = (selectedWorkspaceID, currentThreadID)
        let visibleIDs = Set(projected.map(\.id))
        let removedWorkspaceIDs = workspaces
            .map(\.id)
            .filter { !visibleIDs.contains($0) }
        mergeServerWorkspaces(projected)
        if let selectedWorkspaceID,
           !workspaces.contains(where: { $0.id == selectedWorkspaceID }) {
            self.selectedWorkspaceID = workspaces.first?.id
            selectedThreadID = ""
        } else if selectedWorkspaceID == nil {
            selectedWorkspaceID = workspaces.first?.id
        }
        if let ownerScope {
            try? await persistWorkspaceListCache(ownerScope: ownerScope)
            if let apiClient {
                for workspaceID in removedWorkspaceIDs {
                    await serverStateCache.invalidateScope(
                        AthenaTaskScope(
                            owner: ownerScope,
                            route: "workspace",
                            workspaceID: workspaceID
                        ),
                        ownerScope: ownerScope,
                        apiBase: apiClient.configuration.normalizedBaseURL
                    )
                }
            }
        }
        if previousSelection.0 != selectedWorkspaceID ||
            previousSelection.1 != currentThreadID {
            onSelectionChanged?(selectedWorkspaceID, currentThreadID)
        }
        saveSnapshot()
    }

    func applySyncV2ThreadIndex(
        _ projected: [AthenaThread],
        workspaceID: String
    ) async {
        guard source == .live,
              let existingWorkspace = workspace(withID: workspaceID) else { return }
        let existingByID = Dictionary(
            uniqueKeysWithValues: existingWorkspace.threads.map { ($0.id, $0) }
        )
        let merged = projected.map { projectedThread in
            guard let existing = existingByID[projectedThread.id] else {
                return projectedThread
            }
            var next = projectedThread
            next.historyFingerprint = existing.historyFingerprint
            next.historyRevision = max(
                projectedThread.historyRevision,
                existing.historyRevision
            )
            next.latestChatID = existing.latestChatID
            next.latestChatAt = existing.latestChatAt
            return next
        }
        replaceThreads(merged, in: workspaceID)
        loadedThreadWorkspaceIDs.insert(workspaceID)
        if selectedWorkspaceID == workspaceID,
           !merged.contains(where: { $0.id == selectedThreadID }) {
            selectedThreadID = merged.first?.id ?? ""
            onSelectionChanged?(workspaceID, currentThreadID)
        }
        if let ownerScope {
            try? await persistThreadListCache(
                workspaceID: workspaceID,
                ownerScope: ownerScope
            )
        }
        saveSnapshot()
    }

    func applySyncV2DrawerPins(_ projected: IOSDrawerPinsState) async {
        guard source == .live else { return }
        drawerPins = pruneDrawerPins(projected)
        guard let ownerScope, let apiClient else { return }
        _ = try? await serverStateCache.set(
            drawerPins,
            key: "user-state:\(IOSDrawerPinsState.namespace)",
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .recentNavigation,
            scope: workspaceScope(owner: ownerScope, surface: "sync-v2-drawer-pins")
        )
    }

    func applyWorkspaceDeleteRequested(actionID: String?) {
        guard let actionID else { return }
        optimisticActionCenter.update(actionID, status: .reconciling)
    }

    func applyWorkspaceDeleteFailed(actionID: String?) {
        guard let actionID else { return }
        rollBackOptimisticMutation(actionID)
        optimisticActionCenter.rollBack(actionID)
    }

    func applyWorkspaceDeleted(workspaceID: String?, actionID: String?) async {
        guard let workspaceID else { return }
        if workspaces.contains(where: { $0.id == workspaceID }) {
            removeWorkspaceAndSelectFallback(workspaceID)
        }
        if let actionID {
            optimisticMutationSnapshots[actionID] = nil
            optimisticActionCenter.confirm(actionID)
        }
        await removeDrawerPins(workspaceID: workspaceID)
        await applyUnifiedSyncInvalidation(workspaceID: workspaceID, threadID: nil)
    }

    func fingerprintRequests(limit: Int = 30) -> [ThreadFingerprintRequest] {
        let selectedID = selectedThreadID
        let candidates = persistentWorkspaces.flatMap { workspace in
            workspace.threads.map { thread in
                (workspaceID: workspace.id, thread: thread)
            }
        }
        let sorted = candidates.sorted { lhs, rhs in
            if lhs.thread.id == selectedID { return true }
            if rhs.thread.id == selectedID { return false }
            let left = lhs.thread.latestChatAt.flatMap(Self.syncDate) ?? .distantPast
            let right = rhs.thread.latestChatAt.flatMap(Self.syncDate) ?? .distantPast
            return left > right
        }
        return sorted.prefix(max(1, limit)).map { candidate in
            ThreadFingerprintRequest(
                workspaceSlug: candidate.workspaceID,
                threadSlug: candidate.thread.id,
                fingerprint: candidate.thread.historyFingerprint
            )
        }
    }

    func syncMetadata(for threadID: String) -> AthenaThread? {
        workspaces
            .lazy
            .flatMap(\.threads)
            .first(where: { $0.id == threadID })
    }

    func applySyncedThreadMetadata(
        workspaceID: String,
        threadID: String,
        title: String? = nil,
        chatModel: ThreadChatModel? = nil,
        actionID: String? = nil,
        historyFingerprint: String? = nil,
        historyRevision: Int? = nil,
        latestChatID: Int? = nil,
        latestChatAt: String? = nil
    ) async {
        guard source == .live else { return }
        updateThread(threadID) { thread in
            if let title, !title.isEmpty { thread.title = title }
            if let chatModel {
                thread.chatModel = chatModel
                confirmedModelByThreadID[threadID] = chatModel
                if modelActionIDByThreadID[threadID] == actionID,
                   let actionID {
                    modelActionsConfirmedBySync.insert(actionID)
                }
            }
            if let historyFingerprint { thread.historyFingerprint = historyFingerprint }
            if let historyRevision {
                thread.historyRevision = max(thread.historyRevision, historyRevision)
            }
            if let latestChatID { thread.latestChatID = latestChatID }
            if let latestChatAt { thread.latestChatAt = latestChatAt }
        }
        if let ownerScope {
            try? await persistThreadListCache(
                workspaceID: workspaceID,
                ownerScope: ownerScope
            )
        }
        saveSnapshot()
    }

    func applySyncedWorkspaceMetadata(
        workspaceID: String,
        title: String? = nil,
        chatModel: ThreadChatModel? = nil,
        actionID: String? = nil
    ) async {
        guard source == .live,
              let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            return
        }
        if let title, !title.isEmpty {
            workspaces[workspaceIndex].title = title
        }
        if let chatModel {
            workspaces[workspaceIndex].chatModel = chatModel
            for threadIndex in workspaces[workspaceIndex].threads.indices
            where workspaces[workspaceIndex].threads[threadIndex].isOverview {
                let overviewID = workspaces[workspaceIndex].threads[threadIndex].id
                workspaces[workspaceIndex].threads[threadIndex].chatModel = chatModel
                confirmedModelByThreadID[overviewID] = chatModel
                if modelActionIDByThreadID[overviewID] == actionID,
                   let actionID {
                    modelActionsConfirmedBySync.insert(actionID)
                }
            }
        }
        if let ownerScope {
            try? await persistWorkspaceListCache(ownerScope: ownerScope)
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
        }
        saveSnapshot()
    }

    @discardableResult
    func confirmCreatedThreadFromSync(
        workspaceID: String,
        serverID: Int?,
        threadID: String,
        title: String?,
        threadType: String?,
        chatModel: ThreadChatModel?,
        actionID: String?
    ) async -> Bool {
        guard source == .live,
              let actionID,
              let workspace = workspace(withID: workspaceID),
              let temporaryThread = workspace.threads.first(where: {
                  $0.sourceActionID == actionID && isOptimisticResource($0.id)
              }) else {
            return false
        }
        let confirmed = AthenaThread(
            id: threadID,
            serverID: serverID,
            sourceActionID: actionID,
            workspaceID: workspaceID,
            title: title?.isEmpty == false ? title! : "新线程",
            chatModel: chatModel,
            threadType: threadType ?? "chat"
        )
        await confirmCreatedThread(
            confirmed,
            workspaceID: workspaceID,
            temporaryThreadID: temporaryThread.id,
            actionID: actionID
        )
        return true
    }

    func toggleDrawerThreadPin(_ threadID: String) async {
        guard let workspaceID = workspaceID(containing: threadID) else { return }
        await toggleDrawerPin(kind: .thread, workspaceID: workspaceID, threadID: threadID)
    }

    func toggleDrawerWorkspacePin(_ workspaceID: String) async {
        guard workspace(withID: workspaceID) != nil else { return }
        await toggleDrawerPin(kind: .workspace, workspaceID: workspaceID, threadID: nil)
    }

    func refreshDrawerPinsFromSync() async {
        guard source == .live, let apiClient else { return }
        let fetched = (try? await userStateSyncClient.fetchDrawerPins(using: apiClient)) ?? .empty
        drawerPins = pruneDrawerPins(fetched)
    }

    func removeDrawerPins(workspaceID: String, threadID: String? = nil) async {
        let next = IOSDrawerPinsState(
            pins: drawerPins.pins.filter { pin in
                if let threadID { return pin.threadID != threadID }
                return pin.workspaceID != workspaceID
            }
        )
        guard next != drawerPins else { return }
        drawerPins = next
        await persistDrawerPins(next)
    }

    private func toggleDrawerPin(
        kind: IOSDrawerPin.Kind,
        workspaceID: String,
        threadID: String?
    ) async {
        let identifier = kind == .workspace
            ? "workspace:\(workspaceID)"
            : "thread:\(workspaceID):\(threadID ?? "")"
        var next = drawerPins.pins.filter { $0.id != identifier }
        if next.count == drawerPins.pins.count {
            next.insert(
                IOSDrawerPin(
                    kind: kind,
                    workspaceID: workspaceID,
                    threadID: threadID,
                    pinnedAt: ISO8601DateFormatter().string(from: Date())
                ),
                at: 0
            )
        }
        withAnimation(.smooth) {
            drawerPins = IOSDrawerPinsState(pins: next)
        }
        await persistDrawerPins(drawerPins)
    }

    private func persistDrawerPins(_ pins: IOSDrawerPinsState) async {
        guard source == .live, let apiClient, let ownerScope else { return }
        do {
            try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: "workspace:save-drawer-pins",
                    kind: "user-state-write",
                    priority: .p2,
                    policy: .background,
                    scope: workspaceScope(owner: ownerScope, surface: "drawer-pins-save"),
                    dedupeKey: "drawer-pins-save:\(ownerScope)",
                    isProtected: true,
                    isAbortable: false
                ),
                operation: { [self] _ in
                    try await self.userStateSyncClient.saveDrawerPins(pins, using: apiClient)
                }
            )
        } catch {
            lastError = error.localizedDescription
            recoveryCenter.present(recoveryCenter.classify(error), title: "置顶未同步")
        }
    }

    private func pruneDrawerPins(_ state: IOSDrawerPinsState) -> IOSDrawerPinsState {
        IOSDrawerPinsState(pins: state.pins.filter { pin in
            guard let workspace = workspace(withID: pin.workspaceID) else { return false }
            guard pin.kind == .thread else { return true }
            guard loadedThreadWorkspaceIDs.contains(workspace.id) else { return true }
            return workspace.threads.contains(where: { $0.id == pin.threadID })
        })
    }

    @discardableResult
    func refreshHistoryFromUnifiedSync(
        workspaceID: String,
        threadID: String,
        expectedRevision: Int,
        priority: AthenaTaskPriority
    ) async throws -> Int {
        guard source == .live,
              let api,
              let apiClient,
              let ownerScope else {
            return 0
        }
        let scope = workspaceScope(
            owner: ownerScope,
            surface: nil,
            workspaceID: workspaceID,
            threadID: threadID
        )
        await serverStateCache.markScopeStale(
            scope,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        let key = latestHistoryCacheKey(workspaceID: workspaceID, threadID: threadID)
        await serverStateCache.markStale(
            key: key,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        let result = try await serverStateCache.load(
            ThreadHistoryCacheValue.self,
            key: key,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .latestThreadHistory(threadID: threadID),
            task: AthenaTaskDescriptor(
                label: priority == .p0
                    ? "sync:history-current"
                    : "sync:history-prefetch",
                kind: "chat-sync",
                priority: priority,
                intentRank: priority == .p0 ? 0 : 50,
                executionClass: priority == .p0 ? .currentContent : .synchronization,
                policy: priority == .p0 ? .foreground : .prefetch,
                scope: workspaceScope(
                    owner: ownerScope,
                    surface: "history-fingerprint-refresh",
                    workspaceID: workspaceID,
                    threadID: threadID
                ),
                dedupeKey: "sync:history:\(ownerScope):\(workspaceID):\(threadID)"
            )
        ) {
            let page: AthenaThreadHistoryPage
            if let overview = self.thread(withID: threadID), overview.isOverview {
                page = try await api.fetchOverviewBootstrap(
                    workspaceID: workspaceID,
                    overviewThread: overview
                )
            } else {
                page = try await api.fetchThreadBootstrap(
                    workspaceID: workspaceID,
                    threadID: threadID
                )
            }
            guard let thread = page.thread else {
                throw APIClientError.invalidResponse
            }
            return ThreadHistoryCacheValue(
                thread: thread,
                messages: page.messages,
                page: page.page
            )
        }
        guard result.thread.historyRevision >= expectedRevision else {
            throw APIClientError.superseded
        }
        updateThread(threadID) { thread in
            var refreshed = result.thread
            refreshed.messages = thread.messages
            thread = refreshed
        }
        if selectedThreadID == threadID {
            let mergedMessages = mergeAuthoritativeHistory(
                result.messages,
                with: messages(for: threadID)
            )
            publishMessages(mergedMessages, for: threadID)
            var state = historyState(for: threadID)
            state.page = result.page
            state.olderPageError = nil
            historyStateByThreadID[threadID] = state
        }
        try? await persistThreadListCache(
            workspaceID: workspaceID,
            ownerScope: ownerScope
        )
        saveSnapshot()
        return result.thread.historyRevision
    }

    func reconcileUnifiedSync() async throws {
        guard source == .live, let ownerScope else { return }
        try await bootstrap(ownerScope: ownerScope, refreshMode: .authoritative)
    }

    func reconcileOptimisticAction(_ actionID: String) async {
        guard source == .live, let api, let ownerScope else { return }
        if let temporaryWorkspace = workspaces.first(where: {
            $0.sourceActionID == actionID && isOptimisticResource($0.id)
        }) {
            let workspaceScope = workspaceScope(
                owner: ownerScope,
                surface: "workspace-create-reconcile"
            )
            let serverWorkspaces = try? await taskScheduler.run(
                AthenaTaskDescriptor(
                    id: "reconcile:workspace:\(actionID)",
                    label: "workspace:create:reconcile",
                    kind: "workspace-write-reconcile",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: workspaceScope,
                    dedupeKey: "workspace:create:reconcile:\(ownerScope):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { _ in
                try await api.fetchWorkspaces()
            }
            guard var confirmed = serverWorkspaces?.first(where: {
                $0.sourceActionID == actionID
            }) else { return }
            let confirmedWorkspaceID = confirmed.id
            confirmed.threads = (try? await taskScheduler.run(
                AthenaTaskDescriptor(
                    id: "reconcile:workspace-threads:\(actionID)",
                    label: "workspace:create:threads:reconcile",
                    kind: "workspace-write-reconcile",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: workspaceScope,
                    dedupeKey: "workspace:create:threads:reconcile:\(ownerScope):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { _ in
                try await api.fetchThreads(workspaceID: confirmedWorkspaceID)
            }) ?? []
            await confirmCreatedWorkspace(
                confirmed,
                temporaryWorkspaceID: temporaryWorkspace.id,
                temporaryThreadID: temporaryWorkspace.threads.first?.id ?? "",
                actionID: actionID
            )
            return
        }
        for workspace in workspaces {
            guard let temporaryThread = workspace.threads.first(where: {
                $0.sourceActionID == actionID && isOptimisticResource($0.id)
            }) else { continue }
            let scope = workspaceScope(
                owner: ownerScope,
                surface: "thread-create-reconcile",
                workspaceID: workspace.id
            )
            let serverThreads = try? await taskScheduler.run(
                AthenaTaskDescriptor(
                    id: "reconcile:thread:\(actionID)",
                    label: "thread:create:reconcile",
                    kind: "thread-write-reconcile",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "thread:create:reconcile:\(ownerScope):\(workspace.id):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { _ in
                try await api.fetchThreads(workspaceID: workspace.id)
            }
            guard let confirmed = serverThreads?.first(where: {
                $0.sourceActionID == actionID
            }) else { continue }
            await confirmCreatedThread(
                confirmed,
                workspaceID: workspace.id,
                temporaryThreadID: temporaryThread.id,
                actionID: actionID
            )
            return
        }
        guard let mutation = optimisticMutationSnapshots[actionID] else {
            return
        }
        do {
            let serverWorkspaces = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    id: "reconcile:mutation:\(actionID)",
                    label: "workspace:mutation:reconcile",
                    kind: "workspace-write-reconcile",
                    priority: .p0,
                    intentRank: 1,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "mutation-reconcile",
                        workspaceID: mutation.workspaceID
                    ),
                    dedupeKey: "workspace:mutation:reconcile:\(ownerScope):\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { _ in
                try await api.fetchWorkspaces()
            }
            withAnimation(.smooth) {
                mergeServerWorkspaces(serverWorkspaces)
            }
            if workspaces.contains(where: { $0.id == mutation.workspaceID }) {
                try await loadThreads(for: mutation.workspaceID)
            }
            optimisticMutationSnapshots[actionID] = nil
            optimisticActionCenter.confirm(actionID)
            saveSnapshot()
        } catch {
            lastError = error.localizedDescription
            optimisticActionCenter.update(actionID, status: .reconciling)
            _ = ownerScope
        }
    }

    func reset(clearAuthenticatedCache: Bool) {
        navigationGeneration &+= 1
        snapshotPersistenceTask?.cancel()
        snapshotPersistenceTask = nil
        for handle in chatStreamHandles.values {
            handle.cancel()
        }
        for handle in threadModelUpdateHandles.values {
            handle.cancel()
        }
        chatStreamHandles.removeAll()
        threadModelUpdateHandles.removeAll()
        confirmedModelByThreadID.removeAll()
        modelActionIDByThreadID.removeAll()
        modelActionsConfirmedBySync.removeAll()
        optimisticResourceActionIDs.removeAll()
        optimisticMutationSnapshots.removeAll()
        loadedThreadWorkspaceIDs.removeAll()
        sendingThreadIDs.removeAll()
        activeClientTurnIDByThreadID.removeAll()
        abortedStreamClientTurnIDs.removeAll()
        agentHandoffClientTurnIDs.removeAll()
        regenerateCommittedClientTurnIDs.removeAll()
        sendErrorByThreadID.removeAll()
        modelUpdatingThreadIDs.removeAll()
        modelUpdateErrorByThreadID.removeAll()
        drawerPins = .empty
        chatEditSession = nil
        if let ownerScope {
            if let apiClient {
                let apiBase = apiClient.configuration.normalizedBaseURL
                Task { @MainActor in
                    await serverStateCache.clear(ownerScope: ownerScope, apiBase: apiBase)
                }
            }
            if clearAuthenticatedCache, let apiClient {
                localCache.clearWorkspaceSnapshot(
                    ownerScope: ownerScope,
                    apiBase: apiClient.configuration.normalizedBaseURL
                )
                localCache.clearConversationViewport(
                    ownerScope: ownerScope,
                    apiBase: apiClient.configuration.normalizedBaseURL
                )
            }
        }
        ownerScope = nil
        selectedWorkspaceID = nil
        workspaces = []
        selectedThreadID = ""
        resetPublishedMessages()
        historyStateByThreadID = [:]
        historyLoadingThreadID = nil
        lastError = nil
        cachedFallbackSnapshot = nil
        localConversationViewport = nil
        hasCachedFallback = false
        loadState = .idle
    }

    private func loadInitialHistory(
        workspaceID: String,
        threadID: String,
        generation: UInt64
    ) async throws {
        guard let api, let ownerScope else {
            return
        }
        var state = historyState(for: threadID)
        state.isLoadingInitial = true
        state.olderPageError = nil
        historyStateByThreadID[threadID] = state
        historyLoadingThreadID = threadID
        defer {
            if historyLoadingThreadID == threadID {
                historyLoadingThreadID = nil
            }
            var latestState = historyState(for: threadID)
            latestState.isLoadingInitial = false
            historyStateByThreadID[threadID] = latestState
        }

        let result = try await serverStateCache.load(
            ThreadHistoryCacheValue.self,
            key: latestHistoryCacheKey(workspaceID: workspaceID, threadID: threadID),
            ownerScope: ownerScope,
            apiBase: apiClient?.configuration.normalizedBaseURL,
            policy: .latestThreadHistory(threadID: threadID),
            task: AthenaTaskDescriptor(
                label: "workspace:history-initial",
                kind: "chat",
                priority: .p0,
                intentRank: 0,
                executionClass: .currentContent,
                policy: .foreground,
                scope: workspaceScope(
                    owner: ownerScope,
                    surface: "history-initial",
                    workspaceID: workspaceID,
                    threadID: threadID
                ),
                dedupeKey: "history:initial:\(ownerScope):\(workspaceID):\(threadID)"
            )
        ) {
            let result: AthenaThreadHistoryPage
            if let overview = self.thread(withID: threadID), overview.isOverview {
                result = try await api.fetchOverviewBootstrap(
                    workspaceID: workspaceID,
                    overviewThread: overview
                )
            } else {
                result = try await api.fetchThreadBootstrap(
                    workspaceID: workspaceID,
                    threadID: threadID
                )
            }
            guard let thread = result.thread else {
                throw APIClientError.invalidResponse
            }
            return ThreadHistoryCacheValue(
                thread: thread,
                messages: result.messages,
                page: result.page
            )
        }
        try ensureCurrent(generation: generation, owner: ownerScope, threadID: threadID)
        let priorityMessages = priorityMarkdownMessages(
            in: result.messages,
            threadID: threadID
        )
        await MarkdownRenderCache.shared.prewarm(priorityMessages)
        let priorityIDs = Set(priorityMessages.map(\.id))
        let deferredMessages = Array(
            result.messages.suffix(20).filter { !priorityIDs.contains($0.id) }
        )
        Task(priority: .userInitiated) {
            await MarkdownRenderCache.shared.prewarm(deferredMessages)
        }
        let mergedMessages = mergeAuthoritativeHistory(
            result.messages,
            with: messages(for: threadID)
        )
        publishMessages(mergedMessages, for: threadID)
        state = historyState(for: threadID)
        state.page = result.page
        state.isLoadingInitial = false
        state.olderPageError = nil
        historyStateByThreadID[threadID] = state
        updateThread(threadID) { thread in
            var refreshed = result.thread
            refreshed.messages = []
            thread = refreshed
        }
    }

    private func persistRecentNavigation(generation: UInt64) async throws {
        guard let apiClient, let selectedWorkspaceID else {
            return
        }
        let workspaceName = workspace(withID: selectedWorkspaceID)?.title
        let state = RecentNavigationState(
            workspace: RecentWorkspaceReference(slug: selectedWorkspaceID, name: workspaceName),
            threadsByWorkspace: [selectedWorkspaceID: selectedThreadID.isEmpty ? nil : selectedThreadID]
        )
        guard let ownerScope else {
            return
        }
        try await taskScheduler.run(
            AthenaTaskDescriptor(
                label: "workspace:save-recent-navigation",
                kind: "user-state-write",
                priority: .p2,
                policy: .background,
                scope: workspaceScope(
                    owner: ownerScope,
                    surface: "recent-navigation-save",
                    workspaceID: selectedWorkspaceID,
                    threadID: selectedThreadID.isEmpty ? nil : selectedThreadID
                ),
                isProtected: true,
                isAbortable: false
            )
        ) { [self] _ in
            try await self.userStateSyncClient.saveRecentNavigation(state, using: apiClient)
        }
        try ensureCurrent(generation: generation, owner: ownerScope)
        _ = try await serverStateCache.set(
            state,
            key: "user-state:recent.navigation",
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .recentNavigation,
            scope: workspaceScope(owner: ownerScope, surface: "recent-navigation")
        )
    }

    private func refreshServerConfirmedHistory(
        workspaceID: String,
        threadID: String
    ) async {
        guard source == .live,
              selectedThreadID == threadID,
              let ownerScope else {
            return
        }
        await serverStateCache.markStale(
            key: latestHistoryCacheKey(workspaceID: workspaceID, threadID: threadID),
            ownerScope: ownerScope,
            apiBase: apiClient?.configuration.normalizedBaseURL
        )
        try? await loadInitialHistory(
            workspaceID: workspaceID,
            threadID: threadID,
            generation: navigationGeneration
        )
    }

    private func resolveOptimisticFailure(actionID: String, error: Error) async {
        let directive = recoveryCenter.classify(error)
        if directive.disposition == .reconcile {
            optimisticActionCenter.update(actionID, status: .reconciling)
            recoveryCenter.present(directive)
            return
        }
        rollBackOptimisticMutation(actionID)
        optimisticActionCenter.rollBack(actionID)
        recoveryCenter.present(directive)
    }

    private func rollBackOptimisticMutation(_ actionID: String) {
        guard let snapshot = optimisticMutationSnapshots.removeValue(forKey: actionID) else {
            return
        }
        withAnimation(.smooth) {
            switch snapshot {
            case .workspaceTitle(let workspaceID, let previousTitle):
                if let index = workspaces.firstIndex(where: { $0.id == workspaceID }) {
                    workspaces[index].title = previousTitle
                }
            case .threadTitle(_, let threadID, let previousTitle):
                updateThread(threadID) { $0.title = previousTitle }
            case .deletedThread(let workspaceID, let thread, let index, let selection):
                if let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }),
                   !workspaces[workspaceIndex].threads.contains(where: { $0.id == thread.id }) {
                    workspaces[workspaceIndex].threads.insert(
                        thread,
                        at: min(index, workspaces[workspaceIndex].threads.count)
                    )
                    publishMessages(thread.messages, for: thread.id)
                }
                selectedWorkspaceID = selection.0
                selectedThreadID = selection.1
            case .deletedWorkspace(let workspace, let index, let selection):
                if !workspaces.contains(where: { $0.id == workspace.id }) {
                    workspaces.insert(workspace, at: min(index, workspaces.count))
                    for thread in workspace.threads {
                        publishMessages(thread.messages, for: thread.id)
                    }
                }
                selectedWorkspaceID = selection.0
                selectedThreadID = selection.1
            case .chatMessages(_, let threadID, let messages):
                publishMessages(messages, for: threadID)
            }
        }
        saveSnapshot()
    }

    private func removeThreadAndSelectFallback(_ threadID: String, from workspaceID: String) {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }),
              let threadIndex = workspaces[workspaceIndex].threads.firstIndex(where: { $0.id == threadID }) else {
            return
        }
        let wasSelected = selectedThreadID == threadID
        let fallback = wasSelected ? threadFallback(workspaceIndex: workspaceIndex, threadIndex: threadIndex) : nil
        withAnimation(.smooth) {
            workspaces[workspaceIndex].threads.remove(at: threadIndex)
            clearMessages(for: threadID)
            historyStateByThreadID[threadID] = nil
            if wasSelected {
                selectedThreadID = fallback ?? ""
                selectedWorkspaceID = fallback.flatMap { self.workspaceID(containing: $0) }
            }
        }
        onSelectionChanged?(selectedWorkspaceID, selectedThreadID.isEmpty ? nil : selectedThreadID)
        if let fallback {
            Task { await selectThread(fallback) }
        }
    }

    private func removeWorkspaceAndSelectFallback(_ workspaceID: String) {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            return
        }
        let removedThreadIDs = Set(workspaces[workspaceIndex].threads.map(\.id))
        let wasSelected = removedThreadIDs.contains(selectedThreadID)
        let fallback = workspaces.enumerated()
            .filter { $0.offset != workspaceIndex }
            .lazy
            .compactMap { $0.element.threads.first?.id }
            .first
        withAnimation(.smooth) {
            let removed = workspaces.remove(at: workspaceIndex)
            for thread in removed.threads {
                clearMessages(for: thread.id)
                historyStateByThreadID[thread.id] = nil
            }
            if wasSelected {
                selectedThreadID = fallback ?? ""
                selectedWorkspaceID = fallback.flatMap { self.workspaceID(containing: $0) }
            }
        }
        onSelectionChanged?(selectedWorkspaceID, selectedThreadID.isEmpty ? nil : selectedThreadID)
        if let fallback {
            Task { await selectThread(fallback) }
        }
    }

    private func threadFallback(workspaceIndex: Int, threadIndex: Int) -> String? {
        let threads = workspaces[workspaceIndex].threads
        if threads.indices.contains(threadIndex + 1) { return threads[threadIndex + 1].id }
        if threadIndex > 0 { return threads[threadIndex - 1].id }
        return workspaces.enumerated()
            .filter { $0.offset != workspaceIndex }
            .lazy
            .compactMap { $0.element.threads.first?.id }
            .first
    }

    private func mergeServerWorkspaces(_ serverWorkspaces: [AthenaWorkspace]) {
        let cachedByID = Dictionary(uniqueKeysWithValues: workspaces.map { ($0.id, $0) })
        workspaces = serverWorkspaces.map { workspace in
            guard let cached = cachedByID[workspace.id] else {
                return workspace
            }
            var merged = workspace
            merged.threads = cached.threads
            return merged
        }
    }

    private func replaceThreads(_ threads: [AthenaThread], in workspaceID: String) {
        guard let index = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            return
        }
        for thread in threads where !thread.messages.isEmpty {
            publishMessages(thread.messages, for: thread.id)
        }
        workspaces[index].threads = threads.map { thread in
            var metadata = thread
            metadata.messages = []
            return metadata
        }
    }

    private func persistThreadListCache(
        workspaceID: String,
        ownerScope: String
    ) async throws {
        guard let apiClient,
              let threads = workspace(withID: workspaceID)?.threads else {
            return
        }
        _ = try await serverStateCache.set(
            threads.filter { !isOptimisticResource($0.id) }.map { thread in
                var metadata = thread
                metadata.messages = []
                return metadata
            },
            key: "workspace:\(workspaceID):threads",
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .threadList,
            scope: workspaceScope(
                owner: ownerScope,
                surface: "thread-list",
                workspaceID: workspaceID
            )
        )
    }

    private func apply(snapshot: WorkspaceMetadataSnapshot) {
        workspaces = snapshot.workspaces.map { workspace in
            var next = workspace
            next.threads = workspace.threads.map { thread in
                var thread = thread
                thread.messages = []
                return thread
            }
            return next
        }
        selectedWorkspaceID = snapshot.selectedWorkspaceID
        selectedThreadID = snapshot.selectedThreadID ?? ""
        resetPublishedMessages()
    }

    private func saveSnapshot() {
        guard source == .live, let ownerScope, let apiClient else {
            return
        }
        let metadataOnlyWorkspaces = persistentWorkspaces.map { workspace in
            var next = workspace
            next.threads = workspace.threads.map { thread in
                var thread = thread
                thread.messages = []
                return thread
            }
            return next
        }
        let snapshot = WorkspaceMetadataSnapshot(
            workspaces: metadataOnlyWorkspaces,
            selectedWorkspaceID: selectedWorkspaceID,
            selectedThreadID: selectedThreadID.isEmpty ? nil : selectedThreadID,
            savedAt: Date()
        )
        let apiBase = apiClient.configuration.normalizedBaseURL
        snapshotPersistenceTask?.cancel()
        snapshotPersistenceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, let self else {
                return
            }
            do {
                try await self.localCache.saveWorkspaceSnapshotAsync(
                    snapshot,
                    ownerScope: ownerScope,
                    apiBase: apiBase
                )
            } catch {
                self.lastError = error.localizedDescription
            }
            self.snapshotPersistenceTask = nil
        }
    }

    private func cachedFallbackIsAvailable(
        ownerScope: String,
        apiBase: URL
    ) async -> Bool {
        let cachedWorkspaces: [AthenaWorkspace]? = await serverStateCache.cachedValue(
            [AthenaWorkspace].self,
            key: "workspace.list",
            ownerScope: ownerScope,
            apiBase: apiBase,
            allowExpired: true
        )
        if cachedWorkspaces?.isEmpty == false {
            return true
        }
        guard let snapshot = cachedFallbackSnapshot else {
            return false
        }
        return !snapshot.workspaces.isEmpty
            && snapshot.savedAt >= Date().addingTimeInterval(-ServerStateCachePolicy.workspaceList.retainFor)
    }

    private func workspace(withID id: String) -> AthenaWorkspace? {
        workspaces.first { $0.id == id }
    }

    private func workspaceID(containing threadID: String) -> String? {
        workspaces.first(where: {
            $0.threads.contains(where: { $0.id == threadID })
        })?.id
    }

    private func thread(withID id: String) -> AthenaThread? {
        workspaces.lazy.flatMap(\.threads).first { $0.id == id }
    }

    private func updateThread(_ id: String, update: (inout AthenaThread) -> Void) {
        for workspaceIndex in workspaces.indices {
            guard let threadIndex = workspaces[workspaceIndex].threads.firstIndex(where: { $0.id == id }) else {
                continue
            }
            update(&workspaces[workspaceIndex].threads[threadIndex])
            return
        }
    }

    private func publishMessages(
        _ messages: [AthenaChatMessage],
        for threadID: String,
        mode: MessagePublishMode = .automatic
    ) {
        let previousMessages = messagesByThreadID[threadID] ?? []

        messagesByThreadID[threadID] = messages
        if mode.isAutomatic {
            let previousIDs = previousMessages.map(\.id)
            let nextIDs = messages.map(\.id)
            if previousIDs != nextIDs || messageIndexByThreadID[threadID] == nil {
                messageIndexByThreadID[threadID] = Dictionary(
                    uniqueKeysWithValues: messages.enumerated().map {
                        ($0.element.id, $0.offset)
                    }
                )
            }
        } else if messageIndexByThreadID[threadID] == nil {
            messageIndexByThreadID[threadID] = Dictionary(
                uniqueKeysWithValues: messages.enumerated().map {
                    ($0.element.id, $0.offset)
                }
            )
        }
        if case .contentOnly(let messageID) = mode,
           let index = messageIndexByThreadID[threadID]?[messageID],
           messages.indices.contains(index),
           let store = messageRenderStoresByThreadID[threadID]?[messageID] {
            store.update(
                message: messages[index],
                isLastConfirmedAssistant: store.isLastConfirmedAssistant
            )
        } else {
            updateMessageRenderStores(messages, for: threadID)
        }
        if mode.isAutomatic,
           previousMessages.map(MessageTimelineState.init(message:)) !=
            messages.map(MessageTimelineState.init(message:)) {
            timelineRevisionByThreadID[threadID, default: 0] &+= 1
        }
    }

    private func clearMessages(for threadID: String) {
        messagesByThreadID[threadID] = nil
        messageIndexByThreadID[threadID] = nil
        messageRenderStoresByThreadID[threadID] = nil
        orderedMessageRenderStoresByThreadID[threadID] = nil
        timelineRevisionByThreadID[threadID, default: 0] &+= 1
    }

    private func resetPublishedMessages() {
        let affectedThreadIDs = Set(messagesByThreadID.keys)
        messagesByThreadID = [:]
        messageIndexByThreadID = [:]
        messageRenderStoresByThreadID = [:]
        orderedMessageRenderStoresByThreadID = [:]
        for threadID in affectedThreadIDs {
            timelineRevisionByThreadID[threadID, default: 0] &+= 1
        }
    }

    private func updateMessageRenderStores(
        _ messages: [AthenaChatMessage],
        for threadID: String
    ) {
        var storesByID = messageRenderStoresByThreadID[threadID] ?? [:]
        let lastConfirmedAssistantID = messages.last(where: {
            $0.role == .assistant && $0.isConfirmed
        })?.id
        var orderedStores: [ConversationMessageRenderStore] = []
        orderedStores.reserveCapacity(messages.count)

        for message in messages {
            let isLastConfirmedAssistant = message.id == lastConfirmedAssistantID
            let store: ConversationMessageRenderStore
            if let existing = storesByID[message.id] {
                existing.update(
                    message: message,
                    isLastConfirmedAssistant: isLastConfirmedAssistant
                )
                store = existing
            } else {
                store = ConversationMessageRenderStore(
                    message: message,
                    isLastConfirmedAssistant: isLastConfirmedAssistant
                )
                storesByID[message.id] = store
            }
            orderedStores.append(store)
        }

        let activeIDs = Set(messages.map(\.id))
        storesByID = storesByID.filter { activeIDs.contains($0.key) }
        messageRenderStoresByThreadID[threadID] = storesByID
        orderedMessageRenderStoresByThreadID[threadID] = orderedStores
    }

    private func appendMessage(_ message: AthenaChatMessage, to threadID: String) {
        var messages = messages(for: threadID)
        guard !messages.contains(where: { $0.id == message.id }) else {
            return
        }
        messages.append(message)
        publishMessages(messages, for: threadID)
    }

    private func replaceMessageText(_ messageID: String, text: String, in threadID: String) {
        var messages = messages(for: threadID)
        guard let index = messages.firstIndex(where: { $0.id == messageID }) else { return }
        let current = messages[index]
        messages[index] = AthenaChatMessage(
            id: current.id,
            role: current.role,
            text: text,
            chatID: current.chatID,
            publicChatID: current.publicChatID,
            sentAt: current.sentAt,
            hydrationStatus: current.hydrationStatus,
            clientTurnID: current.clientTurnID,
            deliveryState: current.deliveryState
        )
        publishMessages(
            messages,
            for: threadID,
            mode: .contentOnly(messageID: messageID)
        )
    }

    private func removeMessages(startingAt chatID: Int, in threadID: String) {
        let messages = messages(for: threadID).filter { message in
            guard let messageChatID = message.chatID else { return true }
            return messageChatID < chatID
        }
        publishMessages(messages, for: threadID)
    }

    private func insertOrReplaceThread(_ thread: AthenaThread, in workspaceID: String) {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            return
        }
        if !thread.messages.isEmpty {
            publishMessages(thread.messages, for: thread.id)
        }
        var metadata = thread
        metadata.messages = []
        if let threadIndex = workspaces[workspaceIndex].threads.firstIndex(where: { $0.id == thread.id }) {
            workspaces[workspaceIndex].threads[threadIndex] = metadata
        } else {
            workspaces[workspaceIndex].threads.insert(metadata, at: 0)
        }
    }

    private func deleteChatTurn(
        messageID: String,
        in threadID: String,
        actionType: NativeOptimisticActionType,
        errorTitle: String
    ) async throws {
        guard let api,
              let ownerScope,
              let workspaceID = workspaceID(containing: threadID),
              let message = messages(for: threadID).first(where: { $0.id == messageID }),
              message.role == .assistant,
              message.chatID != nil || message.publicChatID != nil else {
            throw APIClientError.invalidResponse
        }
        let actionID = UUID().uuidString.lowercased()
        let previousMessages = messages(for: threadID)
        optimisticMutationSnapshots[actionID] = .chatMessages(
            workspaceID: workspaceID,
            threadID: threadID,
            messages: previousMessages
        )
        optimisticActionCenter.begin(
            id: actionID,
            type: actionType,
            scope: workspaceScope(
                owner: ownerScope,
                surface: "chat-delete",
                workspaceID: workspaceID,
                threadID: threadID
            )
        )
        withAnimation(.smooth) {
            let remaining = previousMessages.filter { candidate in
                if let chatID = message.chatID { return candidate.chatID != chatID }
                return candidate.publicChatID != message.publicChatID
            }
            publishMessages(remaining, for: threadID)
        }
        do {
            try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: actionType == .regenerateChat ? "chat:regenerate-delete" : "chat:delete",
                    kind: "chat-mutation",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: workspaceScope(
                        owner: ownerScope,
                        surface: "chat-delete",
                        workspaceID: workspaceID,
                        threadID: threadID
                    ),
                    isProtected: true,
                    isAbortable: false
                )
            ) { _ in
                try await api.deleteChat(
                    workspaceID: workspaceID,
                    threadID: self.thread(withID: threadID)?.isOverview == true ? nil : threadID,
                    chatID: message.chatID,
                    publicChatID: message.publicChatID,
                    sourceActionID: actionID
                )
            }
            optimisticMutationSnapshots[actionID] = nil
            optimisticActionCenter.confirm(actionID)
            await serverStateCache.markStale(
                key: latestHistoryCacheKey(workspaceID: workspaceID, threadID: threadID),
                ownerScope: ownerScope,
                apiBase: apiClient?.configuration.normalizedBaseURL
            )
        } catch {
            rollBackOptimisticMutation(actionID)
            optimisticActionCenter.rollBack(actionID)
            recoveryCenter.present(recoveryCenter.classify(error), title: errorTitle)
            throw error
        }
    }

    private func applyChatStreamEvent(
        _ event: ChatStreamEvent,
        workspaceID: String,
        threadID: String,
        clientTurnID: String,
        editContext: ChatStreamEditContext?,
        regenerateContext: ChatStreamRegenerateContext?,
        agentControlKit: AgentControlKit
    ) {
        switch event {
        case .assistantText(let serverID, let text, let replaces, _):
            markClientTurn(clientTurnID, in: threadID, deliveryState: .streaming)
            let messageID = "\(threadID):stream:\(serverID):assistant"
            var messages = messages(for: threadID)
            if let index = messageIndexByThreadID[threadID]?[messageID],
               messages.indices.contains(index) {
                let current = messages[index]
                messages[index] = AthenaChatMessage(
                    id: current.id,
                    role: .assistant,
                    text: replaces ? text : current.text + text,
                    chatID: current.chatID,
                    publicChatID: current.publicChatID,
                    sentAt: current.sentAt,
                    hydrationStatus: current.hydrationStatus,
                    clientTurnID: clientTurnID,
                    deliveryState: .streaming
                )
                publishMessages(
                    messages,
                    for: threadID,
                    mode: .contentOnly(messageID: messageID)
                )
            } else if !text.isEmpty {
                messages.append(
                    AthenaChatMessage(
                        id: messageID,
                        role: .assistant,
                        text: text,
                        sentAt: Date().timeIntervalSince1970,
                        clientTurnID: clientTurnID,
                        deliveryState: .streaming
                    )
                )
                publishMessages(messages, for: threadID)
            }
        case .finalized(let chatID, let publicChatID, let finalizedClientTurnID):
            confirmClientTurn(
                finalizedClientTurnID ?? clientTurnID,
                in: threadID,
                chatID: chatID,
                publicChatID: publicChatID
            )
            if chatEditSession?.clientTurnID == clientTurnID {
                chatEditSession = nil
            }
            regenerateCommittedClientTurnIDs.remove(clientTurnID)
        case .agentInvocation(_, let invocationID):
            agentHandoffClientTurnIDs.insert(clientTurnID)
            if chatEditSession?.clientTurnID == clientTurnID,
               chatEditSession?.phase == .historyTruncated {
                chatEditSession = nil
            }
            Task {
                await agentControlKit.startSession(
                    invocationID: invocationID,
                    workspaceID: workspaceID,
                    threadID: threadID,
                    clientTurnID: clientTurnID
                )
            }
        case .threadRename(let title):
            updateThread(threadID) { thread in
                thread.title = title
            }
            saveSnapshot()
            if let ownerScope {
                Task { @MainActor [weak self] in
                    try? await self?.persistThreadListCache(
                        workspaceID: workspaceID,
                        ownerScope: ownerScope
                    )
                }
            }
        case .status:
            break
        case .editSessionReady(let sourceActionID, _):
            guard editContext != nil,
                  sourceActionID == nil || sourceActionID == editContext?.sourceActionId,
                  var session = chatEditSession,
                  session.clientTurnID == clientTurnID else {
                break
            }
            session.phase = .streamReady
            chatEditSession = session
            markClientTurn(clientTurnID, in: threadID, deliveryState: .confirming)
            optimisticActionCenter.update(clientTurnID, status: .confirming)
        case .editHistoryTruncated(let sourceActionID, _):
            guard editContext != nil,
                  sourceActionID == nil || sourceActionID == editContext?.sourceActionId,
                  var session = chatEditSession,
                  session.clientTurnID == clientTurnID else {
                break
            }
            session.phase = .historyTruncated
            chatEditSession = session
            optimisticMutationSnapshots[clientTurnID] = nil
            optimisticActionCenter.update(clientTurnID, status: .confirming)
        case .regenerateSessionReady(let sourceActionID, _):
            guard let regenerateContext,
                  sourceActionID == nil || sourceActionID == regenerateContext.sourceActionId else {
                break
            }
            markClientTurn(clientTurnID, in: threadID, deliveryState: .confirming)
            optimisticActionCenter.update(clientTurnID, status: .confirming)
        case .regenerateTurnDeleted(let sourceActionID, _):
            guard let regenerateContext,
                  sourceActionID == nil || sourceActionID == regenerateContext.sourceActionId else {
                break
            }
            regenerateCommittedClientTurnIDs.insert(clientTurnID)
            optimisticMutationSnapshots[clientTurnID] = nil
            optimisticActionCenter.update(clientTurnID, status: .confirming)
        case .failure(let message, _):
            sendErrorByThreadID[threadID] = message
            lastError = message
            if editContext != nil,
               let session = chatEditSession,
               session.clientTurnID == clientTurnID,
               session.phase != .historyTruncated {
                abortedStreamClientTurnIDs.insert(clientTurnID)
                rollBackOptimisticMutation(clientTurnID)
                var restoredSession = session
                restoredSession.phase = .editing
                restoredSession.sourceActionID = nil
                restoredSession.clientTurnID = nil
                chatEditSession = restoredSession
                sendingThreadIDs.remove(threadID)
                activeClientTurnIDByThreadID[threadID] = nil
                optimisticActionCenter.rollBack(clientTurnID)
                recoveryCenter.present(
                    recoveryCenter.classify(APIClientError.invalidResponse),
                    title: "无法编辑消息"
                )
            } else if regenerateContext != nil,
                      !regenerateCommittedClientTurnIDs.contains(clientTurnID) {
                abortedStreamClientTurnIDs.insert(clientTurnID)
                rollBackOptimisticMutation(clientTurnID)
                sendingThreadIDs.remove(threadID)
                activeClientTurnIDByThreadID[threadID] = nil
                optimisticActionCenter.rollBack(clientTurnID)
                recoveryCenter.present(
                    recoveryCenter.classify(APIClientError.invalidResponse),
                    title: "无法重新生成"
                )
            }
        }
    }

    private var persistentWorkspaces: [AthenaWorkspace] {
        workspaces.compactMap { workspace in
            guard !isOptimisticResource(workspace.id) else { return nil }
            var persistent = workspace
            persistent.threads = workspace.threads.filter { !isOptimisticResource($0.id) }
            return persistent
        }
    }

    private func confirmCreatedWorkspace(
        _ confirmedWorkspace: AthenaWorkspace,
        temporaryWorkspaceID: String,
        temporaryThreadID: String,
        actionID: String
    ) async {
        guard let index = workspaces.firstIndex(where: { $0.id == temporaryWorkspaceID }) else {
            optimisticActionCenter.confirm(actionID)
            return
        }
        var confirmed = confirmedWorkspace
        if confirmed.threads.isEmpty, let api {
            confirmed.threads = (try? await api.fetchThreads(workspaceID: confirmed.id)) ?? []
        }
        let selected = confirmed.threads.first(where: { !$0.isOverview }) ?? confirmed.threads.first
        withAnimation(.smooth) {
            workspaces[index] = confirmed
            selectedWorkspaceID = confirmed.id
            selectedThreadID = selected?.id ?? ""
        }
        optimisticResourceActionIDs[temporaryWorkspaceID] = nil
        optimisticResourceActionIDs[temporaryThreadID] = nil
        clearMessages(for: temporaryThreadID)
        optimisticActionCenter.confirm(actionID)
        onSelectionChanged?(selectedWorkspaceID, currentThreadID)
        if let ownerScope {
            try? await persistWorkspaceListCache(ownerScope: ownerScope)
            try? await persistThreadListCache(workspaceID: confirmed.id, ownerScope: ownerScope)
        }
        saveSnapshot()
    }

    private func rollBackCreatedWorkspace(
        temporaryWorkspaceID: String,
        actionID: String,
        previousSelection: (String?, String)
    ) {
        let temporaryThreadIDs = workspaces
            .first(where: { $0.id == temporaryWorkspaceID })?
            .threads.map(\.id) ?? []
        workspaces.removeAll { $0.id == temporaryWorkspaceID }
        optimisticResourceActionIDs[temporaryWorkspaceID] = nil
        for threadID in temporaryThreadIDs {
            optimisticResourceActionIDs[threadID] = nil
            clearMessages(for: threadID)
        }
        selectedWorkspaceID = previousSelection.0
        selectedThreadID = previousSelection.1
        optimisticActionCenter.rollBack(actionID)
    }

    private func confirmCreatedThread(
        _ confirmedThread: AthenaThread,
        workspaceID: String,
        temporaryThreadID: String,
        actionID: String
    ) async {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }),
              let threadIndex = workspaces[workspaceIndex].threads.firstIndex(where: {
                  $0.id == temporaryThreadID
              }) else {
            optimisticActionCenter.confirm(actionID)
            return
        }
        let temporaryMessages = messagesByThreadID[temporaryThreadID]
            ?? workspaces[workspaceIndex].threads[threadIndex].messages
        let wasSelected = selectedThreadID == temporaryThreadID
        var confirmed = confirmedThread
        confirmed.messages = []
        withAnimation(.smooth) {
            workspaces[workspaceIndex].threads[threadIndex] = confirmed
            if wasSelected {
                selectedWorkspaceID = workspaceID
                selectedThreadID = confirmed.id
            }
        }
        optimisticResourceActionIDs[temporaryThreadID] = nil
        clearMessages(for: temporaryThreadID)
        if !temporaryMessages.isEmpty {
            publishMessages(temporaryMessages, for: confirmed.id)
        }
        optimisticActionCenter.confirm(actionID)
        if wasSelected {
            onSelectionChanged?(workspaceID, confirmed.id)
        }
        if let ownerScope {
            try? await persistThreadListCache(workspaceID: workspaceID, ownerScope: ownerScope)
        }
        saveSnapshot()
    }

    private func removeThread(_ threadID: String, from workspaceID: String) {
        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            return
        }
        workspaces[workspaceIndex].threads.removeAll { $0.id == threadID }
        clearMessages(for: threadID)
    }

    private func markClientTurn(
        _ clientTurnID: String,
        in threadID: String,
        deliveryState: AthenaChatMessage.DeliveryState
    ) {
        var messages = messages(for: threadID)
        var changed = false
        for index in messages.indices where messages[index].clientTurnID == clientTurnID {
            guard messages[index].deliveryState != deliveryState else { continue }
            messages[index].deliveryState = deliveryState
            changed = true
        }
        guard changed else { return }
        publishMessages(messages, for: threadID)
    }

    private func confirmClientTurn(
        _ clientTurnID: String,
        in threadID: String,
        chatID: Int?,
        publicChatID: String?
    ) {
        var messages = messages(for: threadID)
        var changed = false
        for index in messages.indices where messages[index].clientTurnID == clientTurnID {
            let current = messages[index]
            let confirmedID: String
            if let chatID {
                confirmedID = "\(threadID):\(chatID):\(current.role.rawValue)"
            } else if let publicChatID {
                confirmedID = "\(threadID):\(publicChatID):\(current.role.rawValue)"
            } else {
                confirmedID = current.id
            }
            messages[index] = AthenaChatMessage(
                id: confirmedID,
                role: current.role,
                text: current.text,
                chatID: chatID ?? current.chatID,
                publicChatID: publicChatID ?? current.publicChatID,
                sentAt: current.sentAt,
                hydrationStatus: current.hydrationStatus,
                clientTurnID: clientTurnID,
                deliveryState: .confirmed
            )
            changed = true
        }
        guard changed else { return }
        messages = ChatMessageReconciler.canonical(deduplicating: messages)
        publishMessages(messages, for: threadID)
        updateThread(threadID) { thread in
            thread.latestChatID = chatID ?? thread.latestChatID
        }
    }

    private func persistWorkspaceListCache(ownerScope: String) async throws {
        guard let apiClient else { return }
        let metadata = persistentWorkspaces.map { workspace in
            var item = workspace
            item.threads = []
            return item
        }
        _ = try await serverStateCache.set(
            metadata,
            key: "workspace.list",
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .workspaceList,
            scope: workspaceScope(owner: ownerScope, surface: "workspace-list")
        )
    }

    private func workspaceScope(
        owner: String,
        surface: String?,
        workspaceID: String? = nil,
        threadID: String? = nil,
        transport: String = "http"
    ) -> AthenaTaskScope {
        AthenaTaskScope(
            owner: owner,
            route: "workspace-chat",
            surface: surface,
            workspaceID: workspaceID,
            threadID: threadID,
            transport: transport
        )
    }

    private func latestHistoryCacheKey(workspaceID: String, threadID: String) -> String {
        let route = thread(withID: threadID)?.isOverview == true ? "overview" : "thread"
        return "workspace:\(workspaceID):\(route):\(threadID):history:latest"
    }

    private func olderHistoryCacheKey(
        workspaceID: String,
        threadID: String,
        beforeChatID: Int
    ) -> String {
        let route = thread(withID: threadID)?.isOverview == true ? "overview" : "thread"
        return "workspace:\(workspaceID):\(route):\(threadID):history:before:\(beforeChatID)"
    }

    private func ensureCurrent(
        generation: UInt64,
        owner: String?,
        threadID: String? = nil
    ) throws {
        guard navigationGeneration == generation,
              ownerScope == owner,
              threadID.map({ selectedThreadID == $0 }) ?? true else {
            throw AthenaTaskSchedulerError.stale
        }
    }

    private func mergeHistory(
        older: [AthenaChatMessage],
        current: [AthenaChatMessage]
    ) -> [AthenaChatMessage] {
        ChatMessageReconciler.prepend(older: older, current: current)
    }

    private func mergeAuthoritativeHistory(
        _ authoritative: [AthenaChatMessage],
        with current: [AthenaChatMessage]
    ) -> [AthenaChatMessage] {
        ChatMessageReconciler.mergeAuthoritative(authoritative, current: current)
    }

    private static func syncDate(_ value: String) -> Date? {
        ISO8601DateFormatter().date(from: value)
    }
}

private struct ThreadHistoryCacheValue: Codable {
    let thread: AthenaThread
    let messages: [AthenaChatMessage]
    let page: AthenaHistoryPage
}
