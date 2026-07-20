import SwiftUI
import UIKit
import OSLog
import Observation

private let composerLogger = Logger(
    subsystem: "com.athena.native",
    category: "Composer"
)

private func composerDebugLog(_ message: String) {
    #if DEBUG
    composerLogger.debug("\(message, privacy: .public)")
    #endif
}

struct ConversationHomeView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.scenePhase) private var scenePhase
    let workspaceCenter: WorkspaceCenter

    @State private var draft = ""
    @State private var drawerOpen = false
    @GestureState(resetTransaction: Transaction(animation: .smooth))
    private var drawerDragState = DrawerDragState()
    @State private var drawerTransitionGeneration = 0
    @State private var composerEditing = false
    @State private var composerSelection = ComposerTextSelection(location: 0, length: 0)
    @State private var composerRestoreRequestID = 0
    @State private var composerStateBeforeChatEdit: ComposerStateSnapshot?
    @State private var restoreComposerAfterDrawer = false
    @State private var threadActivityOrder: [String: UInt64] = [:]
    @State private var activitySequence: UInt64 = 0
    @State private var renamingThreadID: String?
    @State private var renameDraft = ""
    @State private var pendingDeletionThreadID: String?
    @State private var renamingWorkspaceID: String?
    @State private var workspaceRenameDraft = ""
    @State private var creatingWorkspaceID: String?
    @State private var pendingDeletionWorkspaceID: String?
    @State private var drawerNavigationSnapshot = DrawerNavigationSnapshot.empty
    @State private var historyPrefetchArmed = false
    @State private var historyPrefetchTriggerVisible = false
    @State private var chatScrollRequest: ChatScrollRequest?
    @State private var chatScrollPosition = ScrollPosition(idType: String.self)
    @State private var chatScrollRuntime = ChatScrollRuntimeState()
    @State private var conversationLayoutState = ConversationLayoutState()
    @State private var viewportSaveTask: Task<Void, Never>?
    @State private var viewportRestoreTask: Task<Void, Never>?
    @State private var restoredViewportThreadIDs: Set<String> = []
    @State private var isRestoringLocalViewport = false
    @State private var stableChatViewportMessageID: String?
    @State private var stableChatViewportWasAtBottom = true
    @State private var chatViewportOrientation: ChatViewportOrientation?
    @State private var chatOrientationRestoreGeneration = 0
    @State private var orientationLockedChatTarget: ChatScrollTarget?
    @State private var scrollToBottomHideTask: Task<Void, Never>?
    @State private var scrollBackgroundResumeTask: Task<Void, Never>?
    @State private var agentCenterPresented = false
    @State private var agentRouter = RouterPath()
    @State private var settingsPresented = false
    @State private var speechController = ChatSpeechController()

    init(workspaceCenter: WorkspaceCenter) {
        self.workspaceCenter = workspaceCenter
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-AthenaConversationFixtureFocusBottom") {
            _composerEditing = State(initialValue: true)
        }
        #endif
    }

    private let composerKeyboardBottomGap: CGFloat = 8
    private let composerRestingBottomGap: CGFloat = 6

    private var selectedThreadID: String {
        get { workspaceCenter.selectedThreadID }
        nonmutating set { workspaceCenter.selectedThreadID = newValue }
    }

    private var workspaces: [DrawerWorkspace] {
        get { workspaceCenter.workspaces.map(drawerWorkspace) }
        nonmutating set { workspaceCenter.workspaces = newValue.map(domainWorkspace) }
    }

    var body: some View {
        GeometryReader { geometry in
            let drawerWidth = min(geometry.size.width * 0.78, 330)
            let offset = normalizedDrawerOffset(drawerWidth: drawerWidth)
            let progress = offset / drawerWidth
            let drawerVisualProgress = progress
            let cornerRadius = conversationCornerRadius(width: geometry.size.width, height: geometry.size.height)
            let drawerNavigation = drawerNavigationSnapshot.isReady
                ? drawerNavigationSnapshot
                : makeDrawerNavigationSnapshot()

            ZStack(alignment: .leading) {
                Color(.systemBackground)
                    .ignoresSafeArea()

                ConversationDrawer(
                    isDrawerOpen: drawerOpen,
                    safeAreaInsets: geometry.safeAreaInsets,
                    managementEnabled: workspaceCenter.allowsLocalMutations,
                    creationEnabled: workspaceCenter.allowsCreation,
                    workspaces: drawerNavigation.workspaces,
                    pinnedThreads: drawerNavigation.pinnedThreads,
                    pinnedThreadIDs: drawerNavigation.pinnedThreadIDs,
                    pinnedWorkspaceIDs: drawerNavigation.pinnedWorkspaceIDs,
                    selectedThreadID: selectedThreadID,
                    renamingThreadID: $renamingThreadID,
                    renameDraft: $renameDraft,
                    renamingWorkspaceID: $renamingWorkspaceID,
                    workspaceRenameDraft: $workspaceRenameDraft,
                    selectThread: { thread in
                        cancelActiveChatEdit()
                        selectThread(thread)
                        setDrawer(open: false)
                    },
                    beginRename: beginRename,
                    finishRename: finishRename,
                    togglePinned: togglePinned,
                    requestDelete: requestDelete,
                    createWorkspace: createWorkspace,
                    loadWorkspaceThreads: loadWorkspaceThreads,
                    beginWorkspaceRename: beginWorkspaceRename,
                    finishWorkspaceRename: finishWorkspaceRename,
                    toggleWorkspacePinned: toggleWorkspacePinned,
                    requestWorkspaceDelete: requestWorkspaceDelete,
                    openAgentCenter: {
                        setDrawer(open: false)
                        agentCenterPresented = true
                    },
                    openSettings: {
                        cancelActiveChatEdit()
                        settingsPresented = true
                    }
                )
                    .frame(width: drawerWidth, height: geometry.size.height, alignment: .leading)
                    .offset(x: -18 * (1 - drawerVisualProgress))
                    .opacity(0.46 + (0.54 * drawerVisualProgress))
                    .overlay {
                        ConversationDrawerRevealMaterial(
                            progress: drawerVisualProgress
                        )
                    }
                    .contentShape(Rectangle())
                    .allowsHitTesting(progress > 0.12)
                    .zIndex(0)

                mainPage(drawerWidth: drawerWidth, safeAreaInsets: geometry.safeAreaInsets)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .background(ConversationPageBackground())
                    .overlay {
                        ConversationDrawerDefocusLayer(
                            progress: drawerVisualProgress
                        )
                    }
                    .clipShape(ConversationPageClipShape(progress: progress, fallbackRadius: cornerRadius))
                    .shadow(color: .black.opacity(0.14 * progress), radius: 24 * progress, x: -8 * progress, y: 0)
                    .shadow(color: .black.opacity(0.05 * progress), radius: 8 * progress, x: -2 * progress, y: 0)
                    .offset(x: offset)
                    .contentShape(Rectangle())
                    .allowsHitTesting(progress < 0.02)
                    .zIndex(1)

                drawerOpenSurface(
                    screenSize: geometry.size,
                    drawerWidth: drawerWidth
                )
                .zIndex(2)

                drawerCloseSurface(
                    screenSize: geometry.size,
                    offset: offset,
                    drawerWidth: drawerWidth
                )
                .zIndex(3)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .onChange(of: drawerDragState.isActive) { _, isActive in
                if isActive {
                    drawerTransitionGeneration &+= 1
                    prepareComposerForDrawerInteraction()
                }
            }
        }
        .ignoresSafeArea(.container, edges: .all)
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .onAppear {
            refreshDrawerNavigationSnapshot()
        }
        .onChange(of: workspaceCenter.workspaces) { _, _ in
            refreshDrawerNavigationSnapshot()
        }
        .onChange(of: workspaceCenter.drawerPins) { _, _ in
            refreshDrawerNavigationSnapshot()
        }
        .onChange(of: creatingWorkspaceID) { _, _ in
            refreshDrawerNavigationSnapshot()
        }
        .task {
            await runDebugConversationFixtureIfNeeded()
        }
        .alert(
            "删除线程？",
            isPresented: deletionAlertIsPresented,
            presenting: pendingDeletionThread
        ) { thread in
            Button("取消", role: .cancel) {
                pendingDeletionThreadID = nil
            }
            Button("删除", role: .destructive) {
                deleteThread(thread.id)
            }
        } message: { thread in
            Text("确认删除“\(thread.title)”？此操作无法撤销。")
        }
        .alert(
            "删除工作区？",
            isPresented: workspaceDeletionAlertIsPresented,
            presenting: pendingDeletionWorkspace
        ) { workspace in
            Button("取消", role: .cancel) {
                pendingDeletionWorkspaceID = nil
            }
            Button("删除", role: .destructive) {
                deleteWorkspace(workspace.id)
            }
        } message: { workspace in
            Text("确认删除“\(workspace.title)”及其中的全部线程？此操作无法撤销。")
        }
        .alert(
            dependencies.recoveryCenter.notice?.title ?? "操作未完成",
            isPresented: Binding(
                get: { dependencies.recoveryCenter.notice != nil },
                set: { if !$0 { dependencies.recoveryCenter.dismissNotice() } }
            )
        ) {
            Button("好", role: .cancel) {
                dependencies.recoveryCenter.dismissNotice()
            }
        } message: {
            Text(dependencies.recoveryCenter.notice?.message ?? "")
        }
        .sheet(isPresented: $agentCenterPresented) {
            NavigationStack(
                path: Binding(
                    get: { agentRouter.path },
                    set: { agentRouter.path = $0 }
                )
            ) {
                AgentView()
                    .withAppRouter()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("关闭", systemImage: "xmark") {
                                agentCenterPresented = false
                            }
                        }
                    }
            }
            .environment(agentRouter)
        }
        .sheet(isPresented: $settingsPresented) {
            NavigationStack {
                SettingsView {
                    settingsPresented = false
                }
            }
            .presentationDetents([.large])
        }
    }

    private func mainPage(drawerWidth: CGFloat, safeAreaInsets: EdgeInsets) -> some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                ConversationPageBackground()

                KeyboardCoordinatedConversationHost(
                    isEditing: $composerEditing,
                    draft: $draft,
                    selection: $composerSelection,
                    restoreSelectionRequestID: $composerRestoreRequestID,
                    chatScrollRuntime: chatScrollRuntime,
                    conversationLayoutState: conversationLayoutState,
                    contentRevision: chatHostContentRevision,
                    keyboardGap: composerKeyboardBottomGap,
                    restingBottomGap: restingComposerBottomPadding(safeAreaInsets: safeAreaInsets),
                    sendBlocked: workspaceCenter.isThreadAwaitingCreation(selectedThreadID),
                    isGenerating: isConversationGenerating,
                    isEditingMessage: workspaceCenter.chatEditSession?.phase == .editing,
                    sendAction: sendDraft,
                    stopAction: {
                        workspaceCenter.stopGenerating(in: selectedThreadID)
                    },
                    cancelEditAction: cancelActiveChatEdit,
                    content: chatConversationArea(drawerWidth: drawerWidth)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea(.container, edges: [.top, .bottom])
                .ignoresSafeArea(.keyboard, edges: .bottom)

                ChatScrollToBottomOverlay(
                    runtime: chatScrollRuntime,
                    isDrawerOpen: drawerOpen,
                    hasMessages: !workspaceCenter
                        .messageRenderStoresForDisplay(in: selectedThreadID)
                        .isEmpty,
                    action: returnToChatBottom
                )
            }
            .ignoresSafeArea(.keyboard, edges: .bottom)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        setDrawer(open: !drawerOpen)
                    } label: {
                        Image(systemName: "sidebar.left")
                    }
                    .tint(.black)
                    .accessibilityLabel("展开栏目")
                }

                ToolbarSpacer(.fixed, placement: .topBarLeading)

                ToolbarItem(placement: .topBarLeading) {
                    nativeModelSelector
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        createThreadInCurrentWorkspace()
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .tint(.black)
                    .accessibilityLabel("创建新栏目")
                    .disabled(
                        workspaceCenter.currentWorkspaceID == nil
                            || workspaceCenter.currentWorkspaceID.map(workspaceCenter.isCreatingThread(in:)) == true
                    )
                }
            }
        }
    }

    private func normalizedDrawerOffset(drawerWidth: CGFloat) -> CGFloat {
        let restingOffset = drawerOpen ? drawerWidth : 0
        return min(max(restingOffset + drawerDragState.translation, 0), drawerWidth)
    }

    private func conversationCornerRadius(width: CGFloat, height: CGFloat) -> CGFloat {
        min(max(min(width, height) * 0.135, 54), 72)
    }

    private func drawerDragGesture(drawerWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .local)
            .updating($drawerDragState) { value, state, transaction in
                let horizontal = value.translation.width
                guard state.isActive || DrawerGestureClassifier.hasHorizontalIntent(
                    translation: value.translation,
                    drawerOpen: drawerOpen
                ) else {
                    return
                }

                transaction.animation = nil
                state = DrawerDragState(isActive: true, translation: horizontal)
            }
            .onEnded { value in
                guard drawerDragState.isActive || DrawerGestureClassifier.hasHorizontalIntent(
                    translation: value.translation,
                    drawerOpen: drawerOpen
                ) else {
                    return
                }

                let base = drawerOpen ? drawerWidth : 0
                let predicted = min(max(base + value.predictedEndTranslation.width, 0), drawerWidth)
                let shouldOpen = predicted > drawerWidth * 0.42
                setDrawer(open: shouldOpen)
            }
    }

    private func drawerOpenSurface(screenSize: CGSize, drawerWidth: CGFloat) -> some View {
        Color.clear
            .frame(width: 24, height: screenSize.height)
            .contentShape(Rectangle())
            .accessibilityHidden(true)
            .gesture(drawerDragGesture(drawerWidth: drawerWidth))
            .allowsHitTesting(!drawerOpen)
    }

    private func drawerCloseSurface(screenSize: CGSize, offset: CGFloat, drawerWidth: CGFloat) -> some View {
        Color.clear
            .frame(width: max(screenSize.width - offset, 0), height: screenSize.height)
            .contentShape(Rectangle())
            .offset(x: offset)
            .accessibilityHidden(true)
            .onTapGesture {
                setDrawer(open: false)
            }
            .simultaneousGesture(drawerDragGesture(drawerWidth: drawerWidth))
            .allowsHitTesting(offset > 1)
    }

    private func setDrawer(open: Bool) {
        drawerTransitionGeneration &+= 1
        let generation = drawerTransitionGeneration

        if open {
            cancelActiveChatEdit()
            prepareComposerForDrawerInteraction()
            withAnimation(.smooth) {
                drawerOpen = true
            }
            return
        }

        withAnimation(.smooth, completionCriteria: .removed) {
            drawerOpen = false
        } completion: {
            Task { @MainActor in
                await Task.yield()
                guard generation == drawerTransitionGeneration,
                      !drawerOpen,
                      !drawerDragState.isActive else {
                    return
                }
                restoreComposerAfterDrawerCloseIfNeeded()
            }
        }
    }

    private func prepareComposerForDrawerInteraction() {
        guard composerEditing else {
            return
        }

        restoreComposerAfterDrawer = true
        composerEditing = false
    }

    private func restoreComposerAfterDrawerCloseIfNeeded() {
        guard restoreComposerAfterDrawer else {
            return
        }
        guard !drawerOpen, !drawerDragState.isActive else {
            return
        }

        restoreComposerAfterDrawer = false
        composerRestoreRequestID &+= 1
        composerEditing = true
    }

    private func restingComposerBottomPadding(safeAreaInsets: EdgeInsets) -> CGFloat {
        composerRestingBottomGap
    }

    @MainActor
    private func runDebugConversationFixtureIfNeeded() async {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("-AthenaConversationFixture") else {
            return
        }
        try? await Task.sleep(for: .milliseconds(700))

        var transaction = Transaction()
        transaction.disablesAnimations = true
        if ProcessInfo.processInfo.arguments.contains("-AthenaConversationFixtureFocusHistory") {
            withTransaction(transaction) {
                requestChatScroll(to: .message("layout-a-18"), animated: false)
            }
            try? await Task.sleep(for: .milliseconds(500))
            composerEditing = true
        } else if ProcessInfo.processInfo.arguments.contains("-AthenaConversationFixtureFocusBottom") {
            withTransaction(transaction) {
                requestChatScroll(to: .bottom, animated: false)
            }
            try? await Task.sleep(for: .milliseconds(500))
            composerEditing = true
        }
        #endif
    }

    private var nativeModelSelector: some View {
        Menu(currentThreadModel.displayName) {
            Picker("模型", selection: threadModelSelection) {
                ForEach(ThreadChatModel.allCases, id: \.self) { model in
                    Text(model.displayName)
                        .tag(model)
                }
            }
            .pickerStyle(.inline)
        }
        .menuIndicator(.hidden)
        .tint(.black)
        .font(.system(size: 15, weight: .semibold))
        .controlSize(.large)
        .accessibilityLabel("模型")
        .disabled(
            selectedThreadID.isEmpty ||
                workspaceCenter.modelUpdatingThreadIDs.contains(selectedThreadID)
        )
    }

    private var currentThreadModel: ThreadChatModel {
        workspaceCenter.threadModel(for: selectedThreadID)
    }

    private var threadModelSelection: Binding<ThreadChatModel> {
        Binding(
            get: { currentThreadModel },
            set: { model in
                let threadID = selectedThreadID
                guard !threadID.isEmpty else {
                    return
                }
                Task {
                    do {
                        try await workspaceCenter.setThreadModel(model, for: threadID)
                    } catch {
                        if dependencies.recoveryCenter.notice == nil {
                            dependencies.recoveryCenter.present(
                                dependencies.recoveryCenter.classify(error),
                                title: "无法切换模型"
                            )
                        }
                    }
                }
            }
        )
    }

    private func chatConversationArea(drawerWidth: CGFloat) -> some View {
        GeometryReader { geometry in
            let activeThreadID = selectedThreadID
            let messageStores = workspaceCenter.messageRenderStoresForDisplay(
                in: activeThreadID
            )
            let historyState = workspaceCenter.historyState(for: selectedThreadID)
            let isGenerating = isConversationGenerating
            let agentSession = dependencies.agentControlKit.sessionRenderStore(
                for: selectedThreadID
            )
            let hasStreamingAssistant = messageStores.contains {
                $0.role == .assistant && $0.deliveryState == .streaming
            }
            let prefetchTriggerID = messageStores.isEmpty
                ? nil
                : messageStores[min(4, messageStores.count - 1)].id

            ZStack(alignment: .bottom) {
                ScrollViewReader { scrollProxy in
                    ChatScrollSurface(
                        activeThreadID: activeThreadID,
                        sizeChangeAnchor: conversationLayoutState.sizeChangeAnchor,
                        bottomContentClearance: conversationLayoutState.bottomContentClearance,
                        scrollPosition: $chatScrollPosition
                    ) {
                        chatTimelineStack(
                            messageStores: messageStores,
                            historyState: historyState,
                            activeThreadID: activeThreadID,
                            prefetchTriggerID: prefetchTriggerID,
                            isGenerating: isGenerating,
                            hasStreamingAssistant: hasStreamingAssistant,
                            agentSession: agentSession,
                            viewportWidth: geometry.size.width
                        )
                    }
                    .onScrollTargetVisibilityChange(
                        idType: String.self,
                        threshold: 0.2
                    ) { visibleIDs in
                        updateVisibleChatMessages(
                            visibleIDs,
                            threadID: activeThreadID
                        )
                    }
                    .onChange(of: chatScrollRequest) { _, request in
                        guard let request,
                              request.threadID == activeThreadID else {
                            return
                        }
                        performChatScroll(request, using: scrollProxy)
                    }
                    .onScrollGeometryChange(for: ChatScrollMetrics.self, of: { scroll in
                        ChatScrollMetrics(
                            distanceFromBottom: max(
                                0,
                                scroll.contentSize.height
                                    + scroll.contentInsets.bottom
                                    - scroll.contentOffset.y
                                    - scroll.containerSize.height
                            ),
                            offsetY: scroll.contentOffset.y,
                            viewportWidth: scroll.containerSize.width
                        )
                    }, action: { _, newMetrics in
                        updateChatScrollMetrics(newMetrics)
                    })
                    .onScrollPhaseChange { _, nextPhase, context in
                        handleChatScrollPhase(
                            nextPhase,
                            velocityY: context.velocity?.dy ?? 0
                        )
                    }
                }

                    if isRestoringLocalViewport {
                        ProgressView()
                            .controlSize(.regular)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .accessibilityLabel("正在恢复阅读位置")
                    }

                }
                .onAppear {
                    restoreViewportOrScrollToBottom(for: selectedThreadID)
                }
                .onChange(of: selectedThreadID) { oldThreadID, newThreadID in
                    handleSelectedThreadChange(
                        from: oldThreadID,
                        to: newThreadID
                    )
                }
                .onChange(of: workspaceCenter.chatEditSession) { _, _ in
                    restoreFailedChatEditIfNeeded()
                }
                .onChange(of: messageStores.last?.id) { _, newLastID in
                    handleLastMessageChange(newLastID)
                }
                .onChange(of: drawerOpen) { _, isOpen in
                    if isOpen {
                        hideScrollToBottomButton(animated: false)
                    }
                }
                .onDisappear {
                    persistViewportImmediately(for: selectedThreadID)
                    viewportSaveTask?.cancel()
                    viewportRestoreTask?.cancel()
                    cancelScrollToBottomHide()
                    resumeBackgroundWorkImmediately()
                }
                .onChange(of: scenePhase) { _, nextPhase in
                    guard nextPhase != .active else { return }
                    persistViewportImmediately(for: selectedThreadID)
                }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .simultaneousGesture(
                TapGesture().onEnded {
                    if drawerOpen {
                        setDrawer(open: false)
                    } else {
                        composerEditing = false
                    }
                }
            )
            .onAppear {
                chatViewportOrientation = ChatViewportOrientation(size: geometry.size)
            }
            .onChange(of: geometry.size) { _, newSize in
                preserveChatViewportAcrossOrientationChange(newSize)
            }
        }
    }

    private func chatTimelineStack(
        messageStores: [ConversationMessageRenderStore],
        historyState: AthenaThreadHistoryState,
        activeThreadID: String,
        prefetchTriggerID: String?,
        isGenerating: Bool,
        hasStreamingAssistant: Bool,
        agentSession: AgentSessionRenderStore?,
        viewportWidth: CGFloat
    ) -> some View {
        LazyVStack(alignment: .center, spacing: 18) {
            historyOlderStatus(state: historyState)

            ForEach(messageStores) { messageStore in
                chatMessageRow(
                    messageStore,
                    activeThreadID: activeThreadID
                )
                if messageStore.id == prefetchTriggerID {
                    Color.clear
                        .frame(height: 1)
                        .onScrollVisibilityChange(threshold: 0.2) { visible in
                            historyPrefetchTriggerVisible = visible
                            if visible {
                                prefetchOlderHistoryIfNeeded()
                            }
                        }
                        .accessibilityHidden(true)
                }
            }

            if isGenerating && !hasStreamingAssistant && agentSession == nil {
                ChatThinkingIndicator()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
            }

            if let agentSession,
               !agentSession.phase.isTerminal || agentSession.hasAssistantContent {
                AgentInlineSessionView(
                    store: agentSession,
                    agentControlKit: dependencies.agentControlKit
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .id("agent:\(agentSession.invocationID)")
                .transition(.opacity)
            }

        }
        .scrollTargetLayout()
        .padding(.top, 28)
        .frame(width: min(max(viewportWidth - 32, 0), 920))
        .frame(width: max(viewportWidth, 0), alignment: .center)
    }

    private var chatHostContentRevision: ChatHostContentRevision {
        ChatHostContentRevision(
            threadID: selectedThreadID,
            timelineRevision: workspaceCenter.timelineRevision(for: selectedThreadID),
            historyState: workspaceCenter.historyState(for: selectedThreadID),
            agentSessionRevision: dependencies.agentControlKit.sessionListRevision,
            isGenerating: isConversationGenerating,
            isRestoringViewport: isRestoringLocalViewport,
            bottomContentClearance: conversationLayoutState.bottomContentClearance,
            sizeChangeAnchor: conversationLayoutState.sizeChangeAnchor,
            scrollRequest: chatScrollRequest
        )
    }

    private func chatMessageRow(
        _ messageStore: ConversationMessageRenderStore,
        activeThreadID: String
    ) -> some View {
        ConversationMessageStoreRow(
            store: messageStore,
            mutationsEnabled: !workspaceCenter.isPreview,
            speechController: speechController,
            onEditUserMessage: workspaceCenter.isPreview ? nil : { messageID in
                beginChatEdit(messageID: messageID)
            },
            onRegenerate: workspaceCenter.isPreview ? nil : { messageID in
                try await workspaceCenter.regenerateAssistantMessage(
                    messageID: messageID,
                    in: activeThreadID
                )
            },
            onFork: workspaceCenter.isPreview ? nil : { messageID in
                try await workspaceCenter.forkAssistantMessage(
                    messageID: messageID,
                    in: activeThreadID
                )
            },
            onDelete: workspaceCenter.isPreview ? nil : { messageID in
                try await workspaceCenter.deleteAssistantMessage(
                    messageID: messageID,
                    in: activeThreadID
                )
            }
        )
        .id(messageStore.id)
        .transition(messageStore.role.insertionTransition)
    }

    @ViewBuilder
    private func historyOlderStatus(
        state: AthenaThreadHistoryState
    ) -> some View {
        ZStack {
            Color.clear
            if state.isLoadingOlder {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("正在加载更早记录")
            } else if state.olderPageError != nil {
                Button {
                    historyPrefetchArmed = true
                    historyPrefetchTriggerVisible = true
                    prefetchOlderHistoryIfNeeded()
                } label: {
                    Label("重试加载更早记录", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.glass)
                .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32)
    }

    private func prefetchOlderHistoryIfNeeded() {
        guard historyPrefetchArmed,
              historyPrefetchTriggerVisible,
              workspaceCenter.historyState(for: selectedThreadID).hasOlder else {
            return
        }
        historyPrefetchArmed = false
        let threadID = selectedThreadID
        Task { @MainActor in
            await workspaceCenter.loadOlderHistory(for: threadID)
        }
    }

    private func sendDraft(_ submittedText: String) {
        let messageText = submittedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !messageText.isEmpty else {
            draft = ""
            return
        }

        let threadID = selectedThreadID
        guard thread(withID: threadID) != nil else {
            draft = ""
            composerEditing = false
            return
        }

        if !workspaceCenter.isPreview {
            let accepted: Bool
            if workspaceCenter.chatEditSession?.threadID == threadID,
               workspaceCenter.chatEditSession?.phase == .editing {
                accepted = workspaceCenter.commitChatEdit(messageText, in: threadID)
            } else {
                accepted = workspaceCenter.enqueueMessage(messageText, to: threadID)
            }
            guard accepted else {
                return
            }
            composerStateBeforeChatEdit = nil
            withAnimation(.smooth) {
                draft = ""
                restoreComposerAfterDrawer = false
                composerEditing = false
            }
            return
        }
        let userMessage = AthenaChatMessage(
            id: "\(threadID)-local-user-\(Date().timeIntervalSince1970)",
            role: .user,
            text: messageText
        )

        withAnimation {
            appendMessage(userMessage, to: threadID)
            draft = ""
            restoreComposerAfterDrawer = false
            composerEditing = false
        }

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 520_000_000)
            withAnimation(.smooth) {
                appendMessage(Self.mockAssistantReply(for: messageText, in: threadID), to: threadID)
            }
        }
    }

    private func beginChatEdit(messageID: String) {
        guard let message = workspaceCenter.message(
            withID: messageID,
            in: selectedThreadID
        ), workspaceCenter.beginChatEdit(
            messageID: message.id,
            in: selectedThreadID
        ) else {
            return
        }
        composerStateBeforeChatEdit = ComposerStateSnapshot(
            draft: draft,
            selection: composerSelection,
            wasEditing: composerEditing
        )
        draft = message.text
        composerSelection = ComposerTextSelection(
            location: message.text.utf16.count,
            length: 0
        )
        composerRestoreRequestID &+= 1
        composerEditing = true
    }

    private func cancelActiveChatEdit() {
        guard workspaceCenter.chatEditSession?.phase == .editing else { return }
        workspaceCenter.cancelChatEdit()
        let previous = composerStateBeforeChatEdit
        composerStateBeforeChatEdit = nil
        draft = previous?.draft ?? ""
        composerSelection = previous?.selection ?? ComposerTextSelection(location: 0, length: 0)
        composerEditing = previous?.wasEditing ?? false
        if composerEditing {
            composerRestoreRequestID &+= 1
        }
    }

    private func restoreFailedChatEditIfNeeded() {
        guard let session = workspaceCenter.chatEditSession,
              session.threadID == selectedThreadID,
              session.phase == .editing,
              let text = session.submittedText else {
            return
        }
        composerStateBeforeChatEdit = ComposerStateSnapshot(
            draft: "",
            selection: ComposerTextSelection(location: 0, length: 0),
            wasEditing: false
        )
        draft = text
        composerSelection = ComposerTextSelection(location: text.utf16.count, length: 0)
        composerRestoreRequestID &+= 1
        composerEditing = true
    }

    private var isConversationGenerating: Bool {
        if workspaceCenter.sendingThreadIDs.contains(selectedThreadID) {
            return true
        }
        guard let phase = dependencies.agentControlKit
            .sessionRenderStore(for: selectedThreadID)?
            .phase else {
            return false
        }
        return phase == .connecting || phase == .open || phase == .reconnecting || phase == .stopping
    }

    private var pinnedThreads: [DrawerThread] {
        workspaces
            .flatMap(\.threads)
            .filter { pinnedThreadIDs.contains($0.id) }
            .sorted { lhs, rhs in
                let lhsOrder = pinOrder(for: lhs.id, kind: .thread)
                let rhsOrder = pinOrder(for: rhs.id, kind: .thread)
                return lhsOrder == rhsOrder ? lhs.id < rhs.id : lhsOrder > rhsOrder
            }
    }

    private var pinnedThreadIDs: Set<String> { workspaceCenter.drawerPinnedThreadIDs }

    private var pinnedWorkspaceIDs: Set<String> { workspaceCenter.drawerPinnedWorkspaceIDs }

    private var orderedWorkspaces: [DrawerWorkspace] {
        var displayWorkspaces = workspaces
        if let creatingWorkspaceID,
           !displayWorkspaces.contains(where: { $0.id == creatingWorkspaceID }) {
            displayWorkspaces.insert(
                DrawerWorkspace(
                    id: creatingWorkspaceID,
                    title: "",
                    systemImage: "folder",
                    tint: .accentColor,
                    threads: []
                ),
                at: 0
            )
        }
        let originalOrder = Dictionary(
            uniqueKeysWithValues: displayWorkspaces.enumerated().map { ($0.element.id, $0.offset) }
        )

        return displayWorkspaces.sorted { lhs, rhs in
            let lhsPinned = pinnedWorkspaceIDs.contains(lhs.id)
            let rhsPinned = pinnedWorkspaceIDs.contains(rhs.id)
            if lhsPinned != rhsPinned {
                return lhsPinned
            }
            if lhsPinned {
                let lhsOrder = pinOrder(for: lhs.id, kind: .workspace)
                let rhsOrder = pinOrder(for: rhs.id, kind: .workspace)
                if lhsOrder != rhsOrder {
                    return lhsOrder > rhsOrder
                }
            }
            return originalOrder[lhs.id, default: 0] < originalOrder[rhs.id, default: 0]
        }
    }

    private func makeDrawerNavigationSnapshot() -> DrawerNavigationSnapshot {
        DrawerNavigationSnapshot(
            workspaces: orderedWorkspaces,
            pinnedThreads: pinnedThreads,
            pinnedThreadIDs: pinnedThreadIDs,
            pinnedWorkspaceIDs: pinnedWorkspaceIDs,
            isReady: true
        )
    }

    private func refreshDrawerNavigationSnapshot() {
        drawerNavigationSnapshot = makeDrawerNavigationSnapshot()
    }

    private var pendingDeletionThread: DrawerThread? {
        guard let pendingDeletionThreadID else {
            return nil
        }
        return thread(withID: pendingDeletionThreadID)
    }

    private var deletionAlertIsPresented: Binding<Bool> {
        Binding(
            get: { pendingDeletionThread != nil },
            set: { isPresented in
                if !isPresented {
                    pendingDeletionThreadID = nil
                }
            }
        )
    }

    private var pendingDeletionWorkspace: DrawerWorkspace? {
        guard let pendingDeletionWorkspaceID else {
            return nil
        }
        return workspaces.first { $0.id == pendingDeletionWorkspaceID }
    }

    private var workspaceDeletionAlertIsPresented: Binding<Bool> {
        Binding(
            get: { pendingDeletionWorkspace != nil },
            set: { isPresented in
                if !isPresented {
                    pendingDeletionWorkspaceID = nil
                }
            }
        )
    }

    private func appendMessage(_ message: AthenaChatMessage, to threadID: String) {
        guard thread(withID: threadID) != nil else { return }
        workspaceCenter.appendPreviewMessage(message, to: threadID)
        markThreadUsed(threadID)
    }

    private func selectThread(_ thread: DrawerThread) {
        withAnimation(.smooth) {
            markThreadUsed(thread.id)
        }
        Task {
            await workspaceCenter.selectThread(thread.id)
        }
    }

    private func beginRename(_ thread: DrawerThread) {
        guard workspaceCenter.allowsLocalMutations else { return }
        if let activeThreadID = renamingThreadID, activeThreadID != thread.id {
            finishRename(activeThreadID)
        }
        renamingThreadID = thread.id
        renameDraft = thread.title
    }

    private func finishRename(_ threadID: String) {
        guard workspaceCenter.allowsLocalMutations else {
            renamingThreadID = nil
            renameDraft = ""
            return
        }
        guard renamingThreadID == threadID else {
            return
        }

        let newTitle = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingThreadID = nil
        renameDraft = ""
        guard !newTitle.isEmpty else { return }
        if workspaceCenter.isPreview {
            if let location = threadLocation(for: threadID),
               workspaces[location.workspace].threads[location.thread].title != newTitle {
                withAnimation(.smooth) {
                    workspaces[location.workspace].threads[location.thread].title = newTitle
                }
            }
        } else {
            Task { await workspaceCenter.renameThread(threadID, to: newTitle) }
        }
    }

    private func togglePinned(_ threadID: String) {
        guard thread(withID: threadID) != nil else {
            return
        }
        Task { await workspaceCenter.toggleDrawerThreadPin(threadID) }
    }

    private func requestDelete(_ threadID: String) {
        guard workspaceCenter.allowsLocalMutations else { return }
        guard thread(withID: threadID) != nil else {
            return
        }
        pendingDeletionThreadID = threadID
    }

    private func createWorkspace() {
        guard workspaceCenter.allowsCreation else {
            dependencies.recoveryCenter.present(
                NativeRecoveryDirective(
                    disposition: .rollback,
                    message: "登录和设备安全状态就绪后才能创建工作区。",
                    mayRetryOnce: false
                ),
                title: "无法创建工作区"
            )
            return
        }
        if let activeThreadID = renamingThreadID {
            finishRename(activeThreadID)
        }
        if let activeWorkspaceID = renamingWorkspaceID {
            finishWorkspaceRename(activeWorkspaceID)
        }

        let workspaceID = "draft:workspace:\(UUID().uuidString.lowercased())"
        creatingWorkspaceID = workspaceID
        renamingWorkspaceID = workspaceID
        workspaceRenameDraft = ""
    }

    private func beginWorkspaceRename(_ workspace: DrawerWorkspace) {
        if let activeThreadID = renamingThreadID {
            finishRename(activeThreadID)
        }
        if let activeWorkspaceID = renamingWorkspaceID, activeWorkspaceID != workspace.id {
            finishWorkspaceRename(activeWorkspaceID)
        }

        renamingWorkspaceID = workspace.id
        workspaceRenameDraft = workspace.title
    }

    private func finishWorkspaceRename(_ workspaceID: String) {
        guard renamingWorkspaceID == workspaceID else {
            return
        }

        let newTitle = workspaceRenameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let isCreating = creatingWorkspaceID == workspaceID

        if isCreating, newTitle.isEmpty {
            creatingWorkspaceID = nil
            renamingWorkspaceID = nil
            workspaceRenameDraft = ""
            return
        }

        guard let workspaceIndex = workspaces.firstIndex(where: { $0.id == workspaceID }) else {
            if isCreating {
                creatingWorkspaceID = nil
                renamingWorkspaceID = nil
                workspaceRenameDraft = ""
                Task { @MainActor in
                    _ = await workspaceCenter.createWorkspace(named: newTitle)
                }
                setDrawer(open: false)
            }
            return
        }

        if !newTitle.isEmpty, workspaceCenter.isPreview {
            withAnimation(.smooth) {
                workspaces[workspaceIndex].title = newTitle
            }
        }

        if isCreating {
            let threadID = "\(workspaceID)-new-thread"
            let thread = DrawerThread(id: threadID, title: "新线程")
            withAnimation(.smooth) {
                workspaces[workspaceIndex].threads.append(thread)
                selectedThreadID = threadID
                markThreadUsed(threadID)
            }
            creatingWorkspaceID = nil
            renamingWorkspaceID = nil
            workspaceRenameDraft = ""
            setDrawer(open: false)
            return
        }

        if !newTitle.isEmpty, !workspaceCenter.isPreview {
            Task { await workspaceCenter.renameWorkspace(workspaceID, to: newTitle) }
        }
        renamingWorkspaceID = nil
        workspaceRenameDraft = ""
    }

    private func createThreadInCurrentWorkspace() {
        guard let workspaceID = workspaceCenter.currentWorkspaceID else { return }
        if let temporaryThreadID = workspaceCenter.createThread(in: workspaceID) {
            withAnimation(.smooth) {
                markThreadUsed(temporaryThreadID)
            }
        }
    }

    private func toggleWorkspacePinned(_ workspaceID: String) {
        guard workspaces.contains(where: { $0.id == workspaceID }) else {
            return
        }
        Task { await workspaceCenter.toggleDrawerWorkspacePin(workspaceID) }
    }

    private func requestWorkspaceDelete(_ workspaceID: String) {
        guard workspaceCenter.allowsLocalMutations else { return }
        guard workspaces.contains(where: { $0.id == workspaceID }) else {
            return
        }
        pendingDeletionWorkspaceID = workspaceID
    }

    private func deleteThread(_ threadID: String) {
        guard workspaceCenter.allowsLocalMutations else {
            pendingDeletionThreadID = nil
            return
        }
        pendingDeletionThreadID = nil
        threadActivityOrder.removeValue(forKey: threadID)
        Task { await workspaceCenter.deleteThread(threadID) }
    }

    private func deleteWorkspace(_ workspaceID: String) {
        guard workspaceCenter.allowsLocalMutations else {
            pendingDeletionWorkspaceID = nil
            return
        }
        pendingDeletionWorkspaceID = nil
        Task { await workspaceCenter.deleteWorkspace(workspaceID) }
    }

    private func markThreadUsed(_ threadID: String) {
        activitySequence &+= 1
        threadActivityOrder[threadID] = activitySequence
    }

    private func pinOrder(for id: String, kind: IOSDrawerPin.Kind) -> Int {
        let matching = workspaceCenter.drawerPins.pins.firstIndex { pin in
            switch kind {
            case .workspace:
                pin.kind == .workspace && pin.workspaceID == id
            case .thread:
                pin.kind == .thread && pin.threadID == id
            }
        }
        return matching.map { workspaceCenter.drawerPins.pins.count - $0 } ?? 0
    }

    private func threadLocation(for threadID: String) -> (workspace: Int, thread: Int)? {
        for workspaceIndex in workspaces.indices {
            if let threadIndex = workspaces[workspaceIndex].threads.firstIndex(where: { $0.id == threadID }) {
                return (workspaceIndex, threadIndex)
            }
        }
        return nil
    }

    private func deletionFallback(for location: (workspace: Int, thread: Int)) -> String? {
        let siblingThreads = workspaces[location.workspace].threads
        if siblingThreads.indices.contains(location.thread + 1) {
            return siblingThreads[location.thread + 1].id
        }
        if location.thread > 0 {
            return siblingThreads[location.thread - 1].id
        }

        return workspaces.enumerated()
            .filter { $0.offset != location.workspace }
            .lazy
            .compactMap { $0.element.threads.first?.id }
            .first
    }

    private func scrollChatToBottom(animated: Bool) {
        orientationLockedChatTarget = nil
        stableChatViewportWasAtBottom = true
        requestChatScroll(to: .bottom, animated: animated)
    }

    private func requestChatScroll(
        to target: ChatScrollTarget,
        animated: Bool
    ) {
        switch target {
        case .bottom:
            stableChatViewportWasAtBottom = true
            let operation = {
                chatScrollPosition.scrollTo(edge: .bottom)
            }
            if animated {
                withAnimation(.smooth) {
                    operation()
                }
            } else {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    operation()
                }
            }
            return
        case .message(let messageID):
            stableChatViewportWasAtBottom = false
            stableChatViewportMessageID = messageID
        }
        chatScrollRequest = ChatScrollRequest(
            threadID: selectedThreadID,
            target: target,
            animated: animated
        )
    }

    private func performChatScroll(
        _ request: ChatScrollRequest,
        using proxy: ScrollViewProxy
    ) {
        let operation = {
            switch request.target {
            case .bottom:
                chatScrollPosition.scrollTo(edge: .bottom)
            case .message(let messageID):
                proxy.scrollTo(messageID, anchor: .top)
            }
        }

        if request.animated {
            withAnimation(.smooth) {
                operation()
            }
        } else {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                operation()
            }
        }
    }

    private func updateStableChatViewportMessageID() {
        stableChatViewportMessageID = currentVisibleChatMessageID()
    }

    private func handleSelectedThreadChange(
        from oldThreadID: String,
        to newThreadID: String
    ) {
        if workspaceCenter.chatEditSession?.threadID == oldThreadID {
            cancelActiveChatEdit()
        }
        persistViewportImmediately(for: oldThreadID)
        viewportRestoreTask?.cancel()
        historyPrefetchArmed = false
        historyPrefetchTriggerVisible = false
        chatScrollRuntime.isAwayFromBottom = false
        chatScrollRuntime.isReturningToBottom = false
        stableChatViewportMessageID = nil
        stableChatViewportWasAtBottom = true
        orientationLockedChatTarget = nil
        chatScrollRuntime.reset()
        hideScrollToBottomButton(animated: false)
        restoreViewportOrScrollToBottom(for: newThreadID)
    }

    private func handleLastMessageChange(_ newLastID: String?) {
        guard newLastID != nil,
              !workspaceCenter.historyState(for: selectedThreadID).isLoadingOlder,
              chatScrollRuntime.phase == .idle,
              !chatScrollRuntime.isAwayFromBottom else {
            return
        }
        scrollChatToBottom(animated: true)
    }

    private func updateVisibleChatMessages(
        _ visibleIDs: [String],
        threadID: String
    ) {
        chatScrollRuntime.visibleMessageIDs = visibleIDs.filter {
            workspaceCenter.containsMessage($0, in: threadID)
        }
    }

    private func updateChatScrollMetrics(_ metrics: ChatScrollMetrics) {
        chatScrollRuntime.latestMetrics = metrics
        if chatScrollRuntime.isAwayFromBottom != metrics.isAwayFromBottom {
            chatScrollRuntime.isAwayFromBottom = metrics.isAwayFromBottom
        }
        if metrics.isAwayFromBottom,
           chatScrollRuntime.phase == .decelerating,
           !chatScrollRuntime.isReturningToBottom,
           !chatScrollRuntime.showsScrollToBottomButton {
            showScrollToBottomButton()
        }
        if !metrics.isAwayFromBottom {
            hideScrollToBottomButton(animated: false)
        }
    }

    private func handleChatScrollPhase(
        _ nextPhase: ScrollPhase,
        velocityY: CGFloat
    ) {
        chatScrollRuntime.phase = nextPhase

        if nextPhase == .interacting || nextPhase == .tracking {
            pauseBackgroundWorkForChatInteraction()
            orientationLockedChatTarget = nil
            historyPrefetchArmed = true
            prefetchOlderHistoryIfNeeded()
            cancelScrollToBottomHide()
        }

        if nextPhase == .decelerating,
           chatScrollRuntime.isAwayFromBottom,
           !chatScrollRuntime.isReturningToBottom,
           abs(velocityY) >= 140 {
            showScrollToBottomButton()
        }

        if chatScrollRuntime.isReturningToBottom, nextPhase == .idle {
            chatScrollRuntime.isReturningToBottom = false
        } else if chatScrollRuntime.isAwayFromBottom,
                  !chatScrollRuntime.isReturningToBottom,
                  nextPhase == .idle {
            scheduleScrollToBottomHide()
        }

        if nextPhase == .idle,
           orientationLockedChatTarget == nil {
            scheduleBackgroundWorkResume()
            let isAtBottom = chatScrollRuntime.latestMetrics?.isAtBottom == true
            stableChatViewportWasAtBottom = isAtBottom
            updateStableChatViewportMessageID()
            scheduleViewportSave()
        }
    }

    private func currentVisibleChatMessageID() -> String? {
        chatScrollRuntime.visibleMessageIDs.first {
            workspaceCenter.containsMessage($0, in: selectedThreadID)
        }
    }

    private func preserveChatViewportAcrossOrientationChange(_ size: CGSize) {
        let nextOrientation = ChatViewportOrientation(size: size)
        guard let nextOrientation else { return }
        guard let previousOrientation = chatViewportOrientation else {
            chatViewportOrientation = nextOrientation
            return
        }
        guard previousOrientation != nextOrientation else { return }

        chatViewportOrientation = nextOrientation
        chatOrientationRestoreGeneration &+= 1
        let generation = chatOrientationRestoreGeneration
        let target: ChatScrollTarget?
        if let orientationLockedChatTarget {
            target = orientationLockedChatTarget
        } else if stableChatViewportWasAtBottom {
            target = .bottom
        } else if let stableChatViewportMessageID {
            target = .message(stableChatViewportMessageID)
        } else {
            target = nil
        }
        guard let target else { return }
        orientationLockedChatTarget = target

        Task { @MainActor in
            await Task.yield()
            guard generation == chatOrientationRestoreGeneration else { return }
            requestChatScroll(to: target, animated: false)
        }
    }

    private func restoreViewportOrScrollToBottom(for threadID: String) {
        guard !threadID.isEmpty else { return }
        guard !restoredViewportThreadIDs.contains(threadID),
              let snapshot = workspaceCenter.localConversationViewport,
              snapshot.threadID == threadID else {
            isRestoringLocalViewport = false
            scrollChatToBottom(animated: false)
            return
        }

        restoredViewportThreadIDs.insert(threadID)
        isRestoringLocalViewport = true
        viewportRestoreTask?.cancel()
        viewportRestoreTask = Task { @MainActor in
            let resolvedMessageID = snapshot.isAtBottom
                ? nil
                : await workspaceCenter.resolveLocalViewportMessage(
                    for: threadID,
                    snapshot: snapshot
                )
            guard !Task.isCancelled, selectedThreadID == threadID else {
                if selectedThreadID == threadID { isRestoringLocalViewport = false }
                return
            }

            await Task.yield()
            guard !Task.isCancelled, selectedThreadID == threadID else {
                if selectedThreadID == threadID { isRestoringLocalViewport = false }
                return
            }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if snapshot.isAtBottom {
                    requestChatScroll(to: .bottom, animated: false)
                } else if let resolvedMessageID {
                    requestChatScroll(to: .message(resolvedMessageID), animated: false)
                } else {
                    requestChatScroll(to: .bottom, animated: false)
                }
            }
            isRestoringLocalViewport = false
            viewportRestoreTask = nil
        }
    }

    private func scheduleViewportSave() {
        viewportSaveTask?.cancel()
        let threadID = selectedThreadID
        viewportSaveTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled, chatScrollRuntime.phase == .idle else { return }
            persistViewportImmediately(for: threadID)
            viewportSaveTask = nil
        }
    }

    private func persistViewportImmediately(for threadID: String) {
        guard !isRestoringLocalViewport,
              !threadID.isEmpty,
              let metrics = chatScrollRuntime.latestMetrics,
              let workspaceID = workspaceCenter.workspaceID(for: threadID) else {
            return
        }
        let stableMessageID = currentVisibleChatMessageID().flatMap { candidate in
            workspaceCenter.containsMessage(candidate, in: threadID) ? candidate : nil
        }
        let chatID = stableMessageID.flatMap {
            workspaceCenter.message(withID: $0, in: threadID)?.chatID
        }
        workspaceCenter.saveLocalConversationViewport(
            LocalConversationViewportSnapshot(
                workspaceID: workspaceID,
                threadID: threadID,
                messageID: stableMessageID,
                chatID: chatID,
                contentOffsetY: metrics.offsetY,
                viewportWidth: metrics.viewportWidth,
                historyRevision: workspaceCenter.historyRevision(for: threadID),
                isAtBottom: metrics.isAtBottom
            )
        )
    }

    private func returnToChatBottom() {
        cancelScrollToBottomHide()
        chatScrollRuntime.isReturningToBottom = true
        hideScrollToBottomButton(animated: true)
        scrollChatToBottom(animated: true)
    }

    private func showScrollToBottomButton() {
        cancelScrollToBottomHide()
        guard !chatScrollRuntime.showsScrollToBottomButton else {
            return
        }
        withAnimation(.smooth) {
            chatScrollRuntime.showsScrollToBottomButton = true
        }
    }

    private func scheduleScrollToBottomHide() {
        cancelScrollToBottomHide()
        guard chatScrollRuntime.showsScrollToBottomButton else {
            return
        }

        scrollToBottomHideTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled,
                  chatScrollRuntime.phase == .idle,
                  chatScrollRuntime.isAwayFromBottom,
                  !chatScrollRuntime.isReturningToBottom else {
                return
            }
            withAnimation(.easeOut(duration: 0.7)) {
                chatScrollRuntime.showsScrollToBottomButton = false
            }
            scrollToBottomHideTask = nil
        }
    }

    private func cancelScrollToBottomHide() {
        scrollToBottomHideTask?.cancel()
        scrollToBottomHideTask = nil
    }

    private func pauseBackgroundWorkForChatInteraction() {
        workspaceCenter.setConversationInteractionActive(true)
        scrollBackgroundResumeTask?.cancel()
        scrollBackgroundResumeTask = nil
        Task {
            await dependencies.taskScheduler.setPaused(
                .p3,
                paused: true,
                reason: "conversation-scroll"
            )
            await dependencies.taskScheduler.setPaused(
                .p4,
                paused: true,
                reason: "conversation-scroll"
            )
        }
    }

    private func scheduleBackgroundWorkResume() {
        scrollBackgroundResumeTask?.cancel()
        scrollBackgroundResumeTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                workspaceCenter.setConversationInteractionActive(false)
            }
            await dependencies.taskScheduler.setPaused(
                .p3,
                paused: false,
                reason: "conversation-scroll"
            )
            await dependencies.taskScheduler.setPaused(
                .p4,
                paused: false,
                reason: "conversation-scroll"
            )
        }
    }

    private func resumeBackgroundWorkImmediately() {
        workspaceCenter.setConversationInteractionActive(false)
        scrollBackgroundResumeTask?.cancel()
        scrollBackgroundResumeTask = nil
        Task {
            await dependencies.taskScheduler.setPaused(
                .p3,
                paused: false,
                reason: "conversation-scroll"
            )
            await dependencies.taskScheduler.setPaused(
                .p4,
                paused: false,
                reason: "conversation-scroll"
            )
        }
    }

    private func hideScrollToBottomButton(animated: Bool) {
        cancelScrollToBottomHide()
        guard chatScrollRuntime.showsScrollToBottomButton else {
            return
        }
        if animated {
            withAnimation(.easeOut(duration: 0.7)) {
                chatScrollRuntime.showsScrollToBottomButton = false
            }
        } else {
            chatScrollRuntime.showsScrollToBottomButton = false
        }
    }

    private func thread(withID id: String) -> DrawerThread? {
        workspaces.lazy
            .flatMap { $0.threads }
            .first { $0.id == id }
    }

    private func loadWorkspaceThreads(_ workspaceID: String) {
        Task {
            do {
                try await workspaceCenter.loadThreads(for: workspaceID)
            } catch {
                dependencies.recoveryCenter.present(
                    dependencies.recoveryCenter.classify(error),
                    title: "无法加载线程"
                )
            }
        }
    }

    private func drawerWorkspace(_ workspace: AthenaWorkspace) -> DrawerWorkspace {
        let appearance = workspaceAppearance(for: workspace.id)
        return DrawerWorkspace(
            id: workspace.id,
            title: workspace.title,
            systemImage: appearance.systemImage,
            tint: appearance.tint,
            threads: workspace.threads.map { thread in
                DrawerThread(
                    id: thread.id,
                    title: thread.title,
                    isOverview: thread.isOverview,
                    isPending: workspaceCenter.isThreadAwaitingCreation(thread.id)
                )
            }
        )
    }

    private func domainWorkspace(_ workspace: DrawerWorkspace) -> AthenaWorkspace {
        let existing = workspaceCenter.workspaces.first { $0.id == workspace.id }
        let existingThreads = Dictionary(
            uniqueKeysWithValues: (existing?.threads ?? []).map { ($0.id, $0) }
        )
        return AthenaWorkspace(
            id: workspace.id,
            serverID: existing?.serverID,
            sourceActionID: existing?.sourceActionID,
            title: workspace.title,
            chatModel: existing?.chatModel,
            threads: workspace.threads.map { thread in
                let existingThread = existingThreads[thread.id]
                return AthenaThread(
                    id: thread.id,
                    serverID: existingThread?.serverID,
                    sourceActionID: existingThread?.sourceActionID,
                    workspaceID: workspace.id,
                    title: thread.title,
                    chatModel: existingThread?.chatModel,
                    threadType: existingThread?.threadType,
                    createdAt: existingThread?.createdAt,
                    lastUpdatedAt: existingThread?.lastUpdatedAt,
                    messages: existingThread?.messages ?? []
                )
            },
            createdAt: existing?.createdAt,
            lastUpdatedAt: existing?.lastUpdatedAt
        )
    }

    private func workspaceAppearance(for id: String) -> (systemImage: String, tint: Color) {
        let appearances: [(String, Color)] = [
            ("book.closed", .orange),
            ("graduationcap", .blue),
            ("bubble.left", .primary),
            ("chart.line.uptrend.xyaxis", .green),
            ("text.book.closed", .purple),
        ]
        let stableIndex = id.unicodeScalars.reduce(0) { partial, scalar in
            (partial + Int(scalar.value)) % appearances.count
        }
        return appearances[stableIndex]
    }

    private static func mockAssistantReply(for prompt: String, in threadID: String) -> AthenaChatMessage {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let replyText = trimmedPrompt.isEmpty
            ? "收到，我会先把这个线程里的上下文整理好。"
            : "收到，这是本地 mock 回复。我已经接收到“\(trimmedPrompt)”，发送与自动回复流程运行正常。"

        return AthenaChatMessage(
            id: "\(threadID)-local-assistant-\(Date().timeIntervalSince1970)",
            role: .assistant,
            text: replyText
        )
    }
}

private struct ComposerTextSelection: Equatable {
    var location: Int
    var length: Int

    init(location: Int, length: Int) {
        self.location = max(location, 0)
        self.length = max(length, 0)
    }

    init(range: NSRange) {
        self.init(
            location: range.location == NSNotFound ? 0 : range.location,
            length: range.length
        )
    }

    var nsRange: NSRange {
        NSRange(location: location, length: length)
    }
}

private struct ComposerStateSnapshot: Equatable {
    let draft: String
    let selection: ComposerTextSelection
    let wasEditing: Bool
}

private struct DrawerDragState: Equatable {
    var isActive = false
    var translation: CGFloat = 0
}

enum DrawerGestureClassifier {
    private static let minimumHorizontalDistance: CGFloat = 18
    private static let horizontalDominance: CGFloat = 1.35

    static func hasHorizontalIntent(
        translation: CGSize,
        drawerOpen: Bool
    ) -> Bool {
        let horizontal = translation.width
        let horizontalDistance = abs(horizontal)
        let verticalDistance = abs(translation.height)
        let movesTowardTarget = drawerOpen ? horizontal < 0 : horizontal > 0

        return movesTowardTarget
            && horizontalDistance >= minimumHorizontalDistance
            && horizontalDistance > verticalDistance * horizontalDominance
    }
}

private struct ConversationPageClipShape: Shape {
    var progress: CGFloat
    var fallbackRadius: CGFloat

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        if #available(iOS 26.0, *), progress > 0.985 {
            return ConcentricRectangle(
                uniformLeadingCorners: .concentric(minimum: .fixed(54)),
                topTrailingCorner: .fixed(0),
                bottomTrailingCorner: .fixed(0)
            )
            .path(in: rect)
        }

        return UnevenRoundedRectangle(
            cornerRadii: .init(
                topLeading: fallbackRadius * progress,
                bottomLeading: fallbackRadius * progress
            ),
            style: .continuous
        )
        .path(in: rect)
    }
}

private struct ConversationDrawer: View {
    let isDrawerOpen: Bool
    let safeAreaInsets: EdgeInsets
    let managementEnabled: Bool
    let creationEnabled: Bool
    let workspaces: [DrawerWorkspace]
    let pinnedThreads: [DrawerThread]
    let pinnedThreadIDs: Set<String>
    let pinnedWorkspaceIDs: Set<String>
    let selectedThreadID: String
    @Binding var renamingThreadID: String?
    @Binding var renameDraft: String
    @Binding var renamingWorkspaceID: String?
    @Binding var workspaceRenameDraft: String
    let selectThread: (DrawerThread) -> Void
    let beginRename: (DrawerThread) -> Void
    let finishRename: (String) -> Void
    let togglePinned: (String) -> Void
    let requestDelete: (String) -> Void
    let createWorkspace: () -> Void
    let loadWorkspaceThreads: (String) -> Void
    let beginWorkspaceRename: (DrawerWorkspace) -> Void
    let finishWorkspaceRename: (String) -> Void
    let toggleWorkspacePinned: (String) -> Void
    let requestWorkspaceDelete: (String) -> Void
    let openAgentCenter: () -> Void
    let openSettings: () -> Void

    @State private var expandedWorkspaceIDs: Set<String> = []
    @State private var hasResolvedInitialSelectedWorkspace = false
    @State private var topPullDistance: CGFloat = 0
    @State private var threadScrollPosition = ScrollPosition(idType: String.self)
    @State private var renamingRowID: String?
    @State private var renamingWorkspaceRowID: String?
    @State private var threadRowFrames: [String: CGRect] = [:]
    @State private var keyboardMetrics = DrawerKeyboardMetrics.hidden
    @State private var scrollOffsetY: CGFloat = 0
    @FocusState private var focusedRenameRowID: String?

    private let primaryItems: [DrawerItem] = [
        DrawerItem(title: "库", systemImage: "books.vertical"),
        DrawerItem(title: "项目", systemImage: "folder"),
        DrawerItem(title: "已计划", systemImage: "clock"),
        DrawerItem(title: "应用", systemImage: "circle.grid.2x2"),
        DrawerItem(title: "Agent", systemImage: "sparkles"),
        DrawerItem(title: "更多", systemImage: "ellipsis"),
    ]

    var body: some View {
        ZStack(alignment: .topLeading) {
            drawerScrollLayer

            if focusedRenameRowID != nil {
                DrawerKeyboardLayoutGuideReader { metrics in
                    keyboardMetrics = metrics
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }

            VStack(spacing: 0) {
                Spacer(minLength: 0)
                DrawerBottomTapBlocker()
                    .frame(height: bottomTapBlockerHeight)
            }

            VStack(alignment: .leading, spacing: 0) {
                drawerHeader
                    .offset(y: headerPullOffset)

                Spacer(minLength: 0)

                drawerFooter
            }
        }
        .padding(.horizontal, AthenaSpacing.lg)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .onChange(of: focusedRenameRowID) { oldValue, newValue in
            guard let oldValue, oldValue != newValue else {
                return
            }

            if oldValue == renamingRowID, let renamingThreadID {
                finishRename(renamingThreadID)
                renamingRowID = nil
            } else if oldValue == renamingWorkspaceRowID, let renamingWorkspaceID {
                finishWorkspaceRename(renamingWorkspaceID)
                renamingWorkspaceRowID = nil
            }

            if newValue == nil {
                keyboardMetrics = .hidden
            }
        }
        .onChange(of: renamingThreadID) { _, newValue in
            guard newValue == nil else {
                return
            }
            focusedRenameRowID = nil
            renamingRowID = nil
        }
        .onChange(of: renamingWorkspaceID) { _, newValue in
            guard let newValue else {
                if focusedRenameRowID == renamingWorkspaceRowID {
                    focusedRenameRowID = nil
                }
                renamingWorkspaceRowID = nil
                return
            }

            let rowID = workspaceRowID(newValue)
            guard renamingWorkspaceRowID != rowID else {
                return
            }
            renamingWorkspaceRowID = rowID
            expandedWorkspaceIDs.insert(newValue)
            focusRenameRow(rowID)
        }
        .onChange(of: isDrawerOpen) { _, isOpen in
            if !isOpen {
                dismissActiveRename()
            } else {
                revealSelectedThread(animated: false)
            }
        }
        .onChange(of: keyboardMetrics) { _, _ in
            keepRenamingRowAboveKeyboard()
        }
        .onChange(of: selectedThreadID, initial: true) { _, _ in
            hasResolvedInitialSelectedWorkspace = false
            resolveInitialSelectedWorkspaceIfNeeded()
        }
        .onChange(of: drawerThreadIdentity, initial: true) { _, _ in
            resolveInitialSelectedWorkspaceIfNeeded()
        }
    }

    private var drawerHeader: some View {
        HStack {
            Text("Athena")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.primary.opacity(0.94))
            Spacer()
            GlassIconButton(systemImage: "magnifyingglass") {}
                .opacity(0.86)
        }
        .padding(.top, topPadding)
        .padding(.bottom, 18)
    }

    private var drawerFooter: some View {
        HStack {
            Button(action: createWorkspace) {
                Label("新工作区", systemImage: "folder.badge.plus")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, AthenaSpacing.lg)
                    .frame(height: 48)
                    .background(Color.black, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!creationEnabled)

            Spacer()

            GlassIconButton(systemImage: "gearshape", action: openSettings)
        }
        .padding(.bottom, bottomPadding)
    }

    private var drawerScrollLayer: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 15) {
                    ForEach(primaryItems) { item in
                        DrawerRow(item: item) {
                            if item.title == "Agent" {
                                openAgentCenter()
                            }
                        }
                        .drawerTopScrollFeather()
                    }
                }

                if !pinnedThreads.isEmpty {
                    DrawerSectionTitle("已置顶")
                        .padding(.top, 28)
                        .drawerTopScrollFeather()

                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(pinnedThreads) { thread in
                            let rowID = pinnedRowID(thread.id)
                            DrawerThreadRow(
                                thread: thread,
                                rowID: rowID,
                                managementEnabled: managementEnabled,
                                isActive: thread.id == selectedThreadID,
                                isPinned: true,
                                isRenaming: renamingRowID == rowID,
                                renameDraft: $renameDraft,
                                renameFocus: $focusedRenameRowID,
                                selectThread: selectThreadAndDismissRename,
                                startRename: { startRename(thread, rowID: rowID) },
                                finishRename: { completeRename(thread.id) },
                                togglePinned: { togglePinned(thread.id) },
                                requestDelete: { requestDelete(thread.id) },
                                rowFrameChanged: rowFrameChanged
                            )
                            .drawerTopScrollFeather()
                        }
                    }
                    .scrollTargetLayout()
                    .transition(.opacity)
                }

                DrawerSectionTitle("工作区")
                    .padding(.top, 28)
                    .drawerTopScrollFeather()

                VStack(alignment: .leading, spacing: 10) {
                    ForEach(workspaces) { workspace in
                        DrawerWorkspaceDisclosureRow(
                            workspace: workspace,
                            workspaceRowID: workspaceRowID(workspace.id),
                            managementEnabled: managementEnabled,
                            isPinnedWorkspace: pinnedWorkspaceIDs.contains(workspace.id),
                            selectedThreadID: selectedThreadID,
                            pinnedThreadIDs: pinnedThreadIDs,
                            isExpanded: workspaceExpansionBinding(for: workspace.id),
                            renamingRowID: renamingRowID,
                            isRenamingWorkspace: renamingWorkspaceRowID == workspaceRowID(workspace.id),
                            renameDraft: $renameDraft,
                            workspaceRenameDraft: $workspaceRenameDraft,
                            renameFocus: $focusedRenameRowID,
                            selectThread: selectThreadAndDismissRename,
                            startRename: startRename,
                            finishRename: completeRename,
                            togglePinned: togglePinned,
                            requestDelete: requestDelete,
                            startWorkspaceRename: startWorkspaceRename,
                            finishWorkspaceRename: completeWorkspaceRename,
                            toggleWorkspacePinned: toggleWorkspacePinned,
                            requestWorkspaceDelete: requestWorkspaceDelete,
                            rowFrameChanged: rowFrameChanged
                        )
                        .drawerTopScrollFeather()
                    }
                }
            }
            .scrollTargetLayout()
            .padding(.bottom, scrollContentBottomInset + renameKeyboardBottomInset)
        }
        .safeAreaBar(edge: .top, spacing: 0) {
            Color.clear
                .frame(height: scrollContentTopInset)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .scrollEdgeEffectHidden(true, for: .bottom)
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .scrollPosition($threadScrollPosition)
        .onScrollGeometryChange(for: CGPoint.self, of: { scroll in
            let adjustedOffset = scroll.contentOffset.y + scroll.contentInsets.top
            return CGPoint(
                x: max(0, -adjustedOffset),
                y: max(0, adjustedOffset)
            )
        }, action: { _, metrics in
            topPullDistance = metrics.x
            scrollOffsetY = metrics.y
            if focusedRenameRowID != nil {
                keepRenamingRowAboveKeyboard()
            }
        })
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func startRename(_ thread: DrawerThread, rowID: String) {
        if let activeThreadID = renamingThreadID {
            finishRename(activeThreadID)
        }

        renamingRowID = rowID
        beginRename(thread)
        focusRenameRow(rowID)
    }

    private func completeRename(_ threadID: String) {
        focusedRenameRowID = nil
        finishRename(threadID)
        renamingRowID = nil
    }

    private func startWorkspaceRename(_ workspace: DrawerWorkspace, rowID: String) {
        renamingWorkspaceRowID = rowID
        expandedWorkspaceIDs.insert(workspace.id)
        beginWorkspaceRename(workspace)
        focusRenameRow(rowID)
    }

    private func completeWorkspaceRename(_ workspaceID: String) {
        focusedRenameRowID = nil
        finishWorkspaceRename(workspaceID)
        renamingWorkspaceRowID = nil
    }

    private func focusRenameRow(_ rowID: String) {
        Task { @MainActor in
            await Task.yield()
            focusedRenameRowID = rowID
            await Task.yield()
            keepRenamingRowAboveKeyboard()
        }
    }

    private func selectThreadAndDismissRename(_ thread: DrawerThread) {
        dismissActiveRename()
        selectThread(thread)
    }

    private func dismissActiveRename() {
        if let renamingThreadID {
            finishRename(renamingThreadID)
        }
        if let renamingWorkspaceID {
            finishWorkspaceRename(renamingWorkspaceID)
        }

        focusedRenameRowID = nil
        renamingRowID = nil
        renamingWorkspaceRowID = nil
        keyboardMetrics = .hidden
    }

    private func rowFrameChanged(_ rowID: String, frame: CGRect) {
        threadRowFrames[rowID] = frame
        if focusedRenameRowID == rowID {
            keepRenamingRowAboveKeyboard()
        }
    }

    private func keepRenamingRowAboveKeyboard() {
        guard let rowID = focusedRenameRowID,
              let keyboardTopY = keyboardMetrics.topY,
              let renamingRowFrame = threadRowFrames[rowID] else {
            return
        }

        let systemSpacing: CGFloat = 4
        let overlap = renamingRowFrame.maxY - (keyboardTopY - systemSpacing)
        guard overlap > 0.5 else {
            return
        }

        threadScrollPosition.scrollTo(y: scrollOffsetY + overlap)
    }

    private func pinnedRowID(_ threadID: String) -> String {
        "pinned:\(threadID)"
    }

    private func workspaceRowID(_ workspaceID: String) -> String {
        "workspace-row:\(workspaceID)"
    }

    private var topPadding: CGFloat {
        max(safeAreaInsets.top, 44) + 14
    }

    private var bottomPadding: CGFloat {
        max(safeAreaInsets.bottom, 16) + 18
    }

    private var scrollContentTopInset: CGFloat {
        topPadding + 64
    }

    private var scrollContentBottomInset: CGFloat {
        bottomTapBlockerHeight + 16
    }

    private var renameKeyboardBottomInset: CGFloat {
        focusedRenameRowID == nil ? 0 : keyboardMetrics.coveredHeight
    }

    private var headerPullOffset: CGFloat {
        let amplifiedPull = topPullDistance * 0.72
        let resistance: CGFloat = 44
        return (amplifiedPull * resistance) / (amplifiedPull + resistance)
    }

    private var bottomTapBlockerHeight: CGFloat {
        bottomPadding + 48 + 72
    }

    private var drawerThreadIdentity: [String] {
        workspaces.flatMap { workspace in
            [workspace.id] + workspace.threads.map { "\(workspace.id):\($0.id)" }
        }
    }

    private func resolveInitialSelectedWorkspaceIfNeeded() {
        guard !hasResolvedInitialSelectedWorkspace,
              revealSelectedThread(animated: false) else {
            return
        }
        hasResolvedInitialSelectedWorkspace = true
    }

    @discardableResult
    private func revealSelectedThread(animated: Bool) -> Bool {
        guard !selectedThreadID.isEmpty,
              let workspace = workspaces.first(where: { workspace in
                  workspace.threads.contains(where: { $0.id == selectedThreadID })
              }) else {
            return false
        }

        var expansionTransaction = Transaction(animation: animated ? .smooth : nil)
        expansionTransaction.disablesAnimations = !animated
        withTransaction(expansionTransaction) {
            expandedWorkspaceIDs = [workspace.id]
        }
        let rowID = "workspace:\(workspace.id):\(selectedThreadID)"
        Task { @MainActor in
            await Task.yield()
            var transaction = Transaction(animation: animated ? .smooth : nil)
            transaction.disablesAnimations = !animated
            withTransaction(transaction) {
                threadScrollPosition.scrollTo(id: rowID, anchor: .center)
            }
        }
        return true
    }

    private func workspaceExpansionBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: {
                expandedWorkspaceIDs.contains(id)
            },
            set: { isExpanded in
                withAnimation(.smooth) {
                    if isExpanded {
                        expandedWorkspaceIDs.insert(id)
                        loadWorkspaceThreads(id)
                    } else {
                        expandedWorkspaceIDs.remove(id)
                    }
                }
            }
        )
    }
}

private struct DrawerItem: Identifiable {
    let title: String
    let systemImage: String
    var tint: Color = .primary

    var id: String { title }
}

private struct DrawerWorkspace: Identifiable {
    let id: String
    var title: String
    let systemImage: String
    var tint: Color = .primary
    var threads: [DrawerThread]
}

private struct DrawerThread: Identifiable {
    let id: String
    var title: String
    var isOverview = false
    var isPending = false
}

private struct DrawerNavigationSnapshot {
    static let empty = DrawerNavigationSnapshot(
        workspaces: [],
        pinnedThreads: [],
        pinnedThreadIDs: [],
        pinnedWorkspaceIDs: [],
        isReady: false
    )

    let workspaces: [DrawerWorkspace]
    let pinnedThreads: [DrawerThread]
    let pinnedThreadIDs: Set<String>
    let pinnedWorkspaceIDs: Set<String>
    let isReady: Bool
}

private extension AthenaChatMessage.Role {
    var insertionTransition: AnyTransition {
        switch self {
        case .user:
            .push(from: .bottom)
        case .assistant:
            .opacity
        }
    }
}

private extension AthenaChatMessage {
    var hasStableServerIdentity: Bool {
        chatID != nil || publicChatID != nil
    }
}

enum MessageActionKind: String, CaseIterable, Hashable {
    case copy
    case edit
    case speech
    case regenerate
    case fork
    case delete
}

struct MessageActionCapabilities: Equatable {
    let visibleActions: [MessageActionKind]
    let enabledActions: Set<MessageActionKind>

    func isEnabled(_ action: MessageActionKind) -> Bool {
        enabledActions.contains(action)
    }

    static func user(isConfirmed: Bool, canEdit: Bool) -> Self {
        Self(
            visibleActions: [.copy, .edit],
            enabledActions: isConfirmed && canEdit ? [.copy, .edit] : [.copy]
        )
    }

    static func assistant(
        isConfirmed: Bool,
        isLastConfirmedAssistant: Bool,
        hasStableServerIdentity: Bool,
        canRegenerate: Bool,
        canFork: Bool,
        canDelete: Bool
    ) -> Self {
        guard isConfirmed else {
            return Self(visibleActions: [], enabledActions: [])
        }
        var enabledActions: Set<MessageActionKind> = [.copy, .speech]
        if isLastConfirmedAssistant && canRegenerate {
            enabledActions.insert(.regenerate)
        }
        if hasStableServerIdentity && canFork {
            enabledActions.insert(.fork)
        }
        if hasStableServerIdentity && canDelete {
            enabledActions.insert(.delete)
        }
        return Self(
            visibleActions: [.copy, .speech, .regenerate, .fork, .delete],
            enabledActions: enabledActions
        )
    }
}

private struct ChatScrollMetrics: Equatable {
    let distanceFromBottom: CGFloat
    let offsetY: CGFloat
    let viewportWidth: CGFloat

    var isAwayFromBottom: Bool {
        distanceFromBottom > 220
    }

    var isAtBottom: Bool {
        distanceFromBottom <= 12
    }
}

struct ComposerLayoutPolicy {
    static let bottomContentSpacing: CGFloat = 12
    static let defaultBottomContentClearance: CGFloat = 52 + bottomContentSpacing

    static func bottomContentClearance(
        composerHeight: CGFloat,
        bottomGap: CGFloat
    ) -> CGFloat {
        max(
            defaultBottomContentClearance,
            composerHeight + max(bottomGap, 0) + bottomContentSpacing
        )
    }

    static func shouldExpand(
        hasText: Bool,
        containsExplicitLineBreak: Bool,
        hasMarkedText: Bool,
        compactMeasuredHeight: CGFloat,
        compactTextHeight: CGFloat,
        editingMessage: Bool,
        wasExpanded: Bool
    ) -> Bool {
        if editingMessage {
            return true
        }
        guard hasText else { return false }
        if containsExplicitLineBreak {
            return true
        }
        if hasMarkedText, wasExpanded {
            return true
        }
        return ceil(compactMeasuredHeight) > ceil(compactTextHeight)
    }
}

struct ConversationKeyboardLayoutPolicy {
    static func keyboardIsFullyDismissed(
        keyboardTop: CGFloat,
        viewportBottom: CGFloat
    ) -> Bool {
        keyboardTop >= viewportBottom - 1
    }
}

@MainActor
@Observable
private final class ConversationLayoutState {
    private(set) var bottomContentClearance: CGFloat
    private(set) var sizeChangeAnchor: UnitPoint = .bottom
    @ObservationIgnored private var pendingBottomContentClearance: CGFloat?
    @ObservationIgnored private var updateScheduled = false

    init(
        bottomContentClearance: CGFloat = ComposerLayoutPolicy.defaultBottomContentClearance
    ) {
        self.bottomContentClearance = bottomContentClearance
    }

    func scheduleBottomContentClearance(_ clearance: CGFloat) {
        pendingBottomContentClearance = max(clearance, 0)
        guard !updateScheduled else { return }
        updateScheduled = true

        Task { @MainActor [weak self] in
            await Task.yield()
            guard let self else { return }
            updateScheduled = false
            guard let pendingBottomContentClearance else { return }
            self.pendingBottomContentClearance = nil
            guard abs(bottomContentClearance - pendingBottomContentClearance) > 0.5 else {
                return
            }
            bottomContentClearance = pendingBottomContentClearance
        }
    }

    func setSizeChangeAnchor(_ anchor: UnitPoint) {
        guard sizeChangeAnchor != anchor else { return }
        sizeChangeAnchor = anchor
    }
}

private struct ChatScrollSurface<Content: View>: View {
    let activeThreadID: String
    let sizeChangeAnchor: UnitPoint
    let bottomContentClearance: CGFloat
    @Binding var scrollPosition: ScrollPosition
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView(showsIndicators: false) {
            content
        }
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(sizeChangeAnchor, for: .sizeChanges)
        .contentMargins(.bottom, bottomContentClearance, for: .scrollContent)
        .scrollPosition($scrollPosition)
        .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
        .scrollClipDisabled()
        .scrollIndicators(.hidden)
        .id("chat-scroll:\(activeThreadID)")
    }
}

@MainActor
@Observable
private final class ChatScrollRuntimeState {
    @ObservationIgnored
    var visibleMessageIDs: [String] = []
    @ObservationIgnored
    var phase: ScrollPhase = .idle
    @ObservationIgnored
    var latestMetrics: ChatScrollMetrics?
    var isAwayFromBottom = false
    var showsScrollToBottomButton = false
    @ObservationIgnored
    var isReturningToBottom = false

    func reset() {
        visibleMessageIDs = []
        phase = .idle
        latestMetrics = nil
        isAwayFromBottom = false
        showsScrollToBottomButton = false
        isReturningToBottom = false
    }
}

private struct ChatScrollToBottomOverlay: View {
    let runtime: ChatScrollRuntimeState
    let isDrawerOpen: Bool
    let hasMessages: Bool
    let action: () -> Void

    var body: some View {
        if runtime.showsScrollToBottomButton,
           runtime.isAwayFromBottom,
           !isDrawerOpen,
           hasMessages {
            Button(action: action) {
                Image(systemName: "arrow.down")
                    .font(.footnote.weight(.semibold))
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .tint(.black)
            .glassEffectTransition(.materialize)
            .accessibilityLabel("返回最新消息")
            .padding(.bottom, 72)
            .transition(.opacity)
        }
    }
}

private enum ChatScrollTarget: Equatable {
    case bottom
    case message(String)
}

private struct ChatScrollRequest: Equatable {
    let id = UUID()
    let threadID: String
    let target: ChatScrollTarget
    let animated: Bool
}

private struct ChatHostContentRevision: Equatable {
    let threadID: String
    let timelineRevision: UInt64
    let historyState: AthenaThreadHistoryState
    let agentSessionRevision: UInt64
    let isGenerating: Bool
    let isRestoringViewport: Bool
    let bottomContentClearance: CGFloat
    let sizeChangeAnchor: UnitPoint
    let scrollRequest: ChatScrollRequest?
}

private enum ChatViewportOrientation: Equatable {
    case portrait
    case landscape

    init?(size: CGSize) {
        guard size.width > 0, size.height > 0 else { return nil }
        self = size.width > size.height ? .landscape : .portrait
    }
}

private struct MessageRenderSnapshot: Equatable {
    let message: AthenaChatMessage
    let isLastConfirmedAssistant: Bool
    let canEdit: Bool
    let canRegenerate: Bool
    let canFork: Bool
    let canDelete: Bool
}

private struct ConversationMessageStoreRow: View {
    let store: ConversationMessageRenderStore
    let mutationsEnabled: Bool
    let speechController: ChatSpeechController
    let onEditUserMessage: ((String) -> Void)?
    let onRegenerate: ((String) async throws -> Void)?
    let onFork: ((String) async throws -> Void)?
    let onDelete: ((String) async throws -> Void)?

    var body: some View {
        AthenaChatMessageRow(
            snapshot: MessageRenderSnapshot(
                message: store.message,
                isLastConfirmedAssistant: store.isLastConfirmedAssistant,
                canEdit: mutationsEnabled,
                canRegenerate: mutationsEnabled,
                canFork: mutationsEnabled,
                canDelete: mutationsEnabled
            ),
            speechController: speechController,
            onEditUserMessage: onEditUserMessage.map { action in
                { action(store.id) }
            },
            onRegenerate: onRegenerate.map { action in
                { try await action(store.id) }
            },
            onFork: onFork.map { action in
                { try await action(store.id) }
            },
            onDelete: onDelete.map { action in
                { try await action(store.id) }
            }
        )
    }
}

private struct AthenaChatMessageRow: View {
    let snapshot: MessageRenderSnapshot
    let speechController: ChatSpeechController
    let onEditUserMessage: (() -> Void)?
    let onRegenerate: (() async throws -> Void)?
    let onFork: (() async throws -> Void)?
    let onDelete: (() async throws -> Void)?

    var body: some View {
        Group {
            switch snapshot.message.role {
            case .user:
                TrailingMessageRail(maximumContentFraction: 0.78, minimumContentWidth: 220) {
                    MockUserMessageBubble(
                        message: snapshot.message,
                        onEdit: onEditUserMessage
                    )
                }
                .frame(maxWidth: .infinity)
            case .assistant:
                MockAssistantMessageBody(
                    message: snapshot.message,
                    isLastConfirmedAssistant: snapshot.isLastConfirmedAssistant,
                    speechController: speechController,
                    onRegenerate: onRegenerate,
                    onFork: onFork,
                    onDelete: onDelete
                )
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct MockUserMessageBubble: View {
    let message: AthenaChatMessage
    let onEdit: (() -> Void)?
    @State private var showsTextSelection = false

    private var actionCapabilities: MessageActionCapabilities {
        .user(
            isConfirmed: message.isConfirmed,
            canEdit: onEdit != nil
        )
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 5) {
            AthenaMarkdownView(message.text, cacheKey: message.id)
                .foregroundStyle(.primary.opacity(0.94))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(
                    Color(.secondarySystemBackground),
                    in: ChatUserBubbleShape()
                )
                .contextMenu {
                    Button("选择文本", systemImage: "selection.pin.in.out") {
                        showsTextSelection = true
                    }
                }

            if message.deliveryState == .pending || message.deliveryState == .streaming {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("正在发送")
            } else if message.deliveryState == .confirming {
                Label("正在准备会话", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if message.deliveryState == .reconciling {
                Label("正在确认", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if message.deliveryState == .failed {
                Label("发送失败", systemImage: "exclamationmark.circle")
                    .font(.caption2)
                    .foregroundStyle(.red)
            } else if message.deliveryState == .stopped {
                Label("已停止", systemImage: "stop.circle")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 4) {
                MessageCopyActionButton(text: message.text)
                MessageActionIconButton(
                    "编辑",
                    systemImage: "pencil",
                    identifier: "message-action-edit",
                    isEnabled: actionCapabilities.isEnabled(.edit)
                ) {
                    onEdit?()
                }
            }
        }
        .sheet(isPresented: $showsTextSelection) {
            MessageTextSelectionView(
                text: message.text,
                cacheKey: message.id
            )
        }
    }
}

private struct TrailingMessageRail: Layout {
    let maximumContentFraction: CGFloat
    let minimumContentWidth: CGFloat

    private func contentWidth(for rowWidth: CGFloat) -> CGFloat {
        min(rowWidth, max(rowWidth * maximumContentFraction, minimumContentWidth))
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard let subview = subviews.first else {
            return .zero
        }

        let rowWidth = max(proposal.width ?? 0, 0)
        let childSize = subview.sizeThatFits(
            ProposedViewSize(
                width: contentWidth(for: rowWidth),
                height: nil
            )
        )
        return CGSize(width: rowWidth, height: childSize.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard let subview = subviews.first else {
            return
        }

        let childSize = subview.sizeThatFits(
            ProposedViewSize(
                width: contentWidth(for: bounds.width),
                height: nil
            )
        )
        subview.place(
            at: CGPoint(x: bounds.maxX, y: bounds.minY),
            anchor: .topTrailing,
            proposal: ProposedViewSize(childSize)
        )
    }
}

private struct MockAssistantMessageBody: View {
    let message: AthenaChatMessage
    let isLastConfirmedAssistant: Bool
    let speechController: ChatSpeechController
    let onRegenerate: (() async throws -> Void)?
    let onFork: (() async throws -> Void)?
    let onDelete: (() async throws -> Void)?

    @State private var showsDeleteConfirmation = false
    @State private var showsTextSelection = false

    private var actionCapabilities: MessageActionCapabilities {
        .assistant(
            isConfirmed: message.isConfirmed,
            isLastConfirmedAssistant: isLastConfirmedAssistant,
            hasStableServerIdentity: message.hasStableServerIdentity,
            canRegenerate: onRegenerate != nil,
            canFork: onFork != nil,
            canDelete: onDelete != nil
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AthenaMarkdownView(
                message.text,
                cacheKey: message.id,
                isStreaming: message.deliveryState == .streaming
                )
                .foregroundStyle(.primary.opacity(0.88))
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 4)
                .contextMenu {
                    Button("选择文本", systemImage: "selection.pin.in.out") {
                        showsTextSelection = true
                    }
                }

            if !actionCapabilities.visibleActions.isEmpty {
                HStack(spacing: 4) {
                    MessageCopyActionButton(text: message.text)
                    MessageActionIconButton(
                        speechController.speakingMessageID == message.id ? "停止朗读" : "朗读",
                        systemImage: speechController.speakingMessageID == message.id ? "stop.fill" : "speaker.wave.2",
                        identifier: "message-action-speech"
                    ) {
                        speechController.toggle(messageID: message.id, text: message.text)
                    }
                    MessageAsyncActionIconButton(
                        "重新生成",
                        systemImage: "arrow.clockwise",
                        identifier: "message-action-regenerate",
                        isEnabled: actionCapabilities.isEnabled(.regenerate)
                    ) {
                        guard let onRegenerate else { return }
                        try await onRegenerate()
                    }
                    MessageAsyncActionIconButton(
                        "分支",
                        systemImage: "arrow.triangle.branch",
                        identifier: "message-action-fork",
                        isEnabled: actionCapabilities.isEnabled(.fork)
                    ) {
                        guard let onFork else { return }
                        try await onFork()
                    }
                    MessageActionIconButton(
                        "删除",
                        systemImage: "trash",
                        identifier: "message-action-delete",
                        tint: .red,
                        isEnabled: actionCapabilities.isEnabled(.delete)
                    ) {
                        showsDeleteConfirmation = true
                    }
                }
            }
        }
        .confirmationDialog(
            "删除这轮会话？",
            isPresented: $showsDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("删除", role: .destructive) {
                guard let onDelete else { return }
                Task { try? await onDelete() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("对应的用户消息和模型回复都会被删除。")
        }
        .sheet(isPresented: $showsTextSelection) {
            MessageTextSelectionView(
                text: message.text,
                cacheKey: message.id
            )
        }
    }
}

private struct MessageTextSelectionView: View {
    @Environment(\.dismiss) private var dismiss

    let text: String
    let cacheKey: String

    var body: some View {
        NavigationStack {
            ScrollView {
                AthenaMarkdownView(text, cacheKey: cacheKey)
                    .textSelection(.enabled)
                    .padding(20)
            }
            .navigationTitle("选择文本")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct ChatThinkingIndicator: View {
    var body: some View {
        HStack(spacing: AthenaSpacing.sm) {
            ProgressView()
                .controlSize(.small)
            Text("正在思考")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("模型正在思考，可以使用输入框中的停止按钮中断回答")
    }
}

private struct MessageActionIconButton: View {
    let title: String
    let systemImage: String
    let identifier: String
    let tint: Color
    let isEnabled: Bool
    let action: () -> Void

    init(
        _ title: String,
        systemImage: String,
        identifier: String,
        tint: Color = .secondary,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.identifier = identifier
        self.tint = tint
        self.isEnabled = isEnabled
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.caption.weight(.medium))
                .frame(width: 28, height: 28)
        }
            .buttonStyle(.plain)
            .foregroundStyle(tint)
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityIdentifier(identifier)
    }
}

private struct MessageCopyActionButton: View {
    let text: String

    @State private var copied = false
    @State private var resetTask: Task<Void, Never>?

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            resetTask?.cancel()
            resetTask = Task {
                try? await Task.sleep(for: .seconds(1.5))
                guard !Task.isCancelled else { return }
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.caption.weight(.medium))
                .frame(width: 28, height: 28)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel(copied ? "已复制" : "复制")
        .accessibilityIdentifier("message-action-copy")
        .onDisappear {
            resetTask?.cancel()
        }
    }
}

private struct MessageAsyncActionIconButton: View {
    let title: String
    let systemImage: String
    let identifier: String
    let isEnabled: Bool
    let action: () async throws -> Void
    @State private var isRunning = false

    init(
        _ title: String,
        systemImage: String,
        identifier: String,
        isEnabled: Bool = true,
        action: @escaping () async throws -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.identifier = identifier
        self.isEnabled = isEnabled
        self.action = action
    }

    var body: some View {
        Button {
            isRunning = true
            Task {
                try? await action()
                isRunning = false
            }
        } label: {
            if isRunning {
                ProgressView()
                    .controlSize(.mini)
                    .frame(width: 28, height: 28)
            } else {
                Image(systemName: systemImage)
                    .font(.caption.weight(.medium))
                    .frame(width: 28, height: 28)
            }
        }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(isRunning || !isEnabled)
            .accessibilityLabel(title)
            .accessibilityIdentifier(identifier)
    }
}

private struct ChatUserBubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            cornerRadii: .init(
                topLeading: 18,
                bottomLeading: 18,
                bottomTrailing: 18,
                topTrailing: 7
            ),
            style: .continuous
        )
        .path(in: rect)
    }
}

private struct DrawerKeyboardMetrics: Equatable {
    var topY: CGFloat?
    var coveredHeight: CGFloat

    static let hidden = DrawerKeyboardMetrics(topY: nil, coveredHeight: 0)
}

private struct DrawerKeyboardLayoutGuideReader: UIViewRepresentable {
    let keyboardMetricsChanged: (DrawerKeyboardMetrics) -> Void

    func makeUIView(context: Context) -> DrawerKeyboardTrackingView {
        let view = DrawerKeyboardTrackingView()
        view.keyboardMetricsChanged = keyboardMetricsChanged
        return view
    }

    func updateUIView(_ view: DrawerKeyboardTrackingView, context: Context) {
        view.keyboardMetricsChanged = keyboardMetricsChanged
    }
}

private final class DrawerKeyboardTrackingView: UIView {
    var keyboardMetricsChanged: ((DrawerKeyboardMetrics) -> Void)?

    private let trackingProbe = UIView()
    private var lastReportedMetrics = DrawerKeyboardMetrics.hidden

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = false

        keyboardLayoutGuide.followsUndockedKeyboard = true
        keyboardLayoutGuide.usesBottomSafeArea = false

        trackingProbe.translatesAutoresizingMaskIntoConstraints = false
        trackingProbe.alpha = 0
        trackingProbe.isUserInteractionEnabled = false
        addSubview(trackingProbe)
        NSLayoutConstraint.activate([
            trackingProbe.leadingAnchor.constraint(equalTo: leadingAnchor),
            trackingProbe.topAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
            trackingProbe.widthAnchor.constraint(equalToConstant: 1),
            trackingProbe.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let keyboardFrame = keyboardLayoutGuide.layoutFrame
        let metrics: DrawerKeyboardMetrics
        if keyboardFrame.height > 0.5 {
            let keyboardTop = convert(
                CGPoint(x: keyboardFrame.minX, y: keyboardFrame.minY),
                to: nil
            ).y
            metrics = DrawerKeyboardMetrics(
                topY: keyboardTop,
                coveredHeight: keyboardFrame.height
            )
        } else {
            metrics = .hidden
        }
        guard metrics != lastReportedMetrics else {
            return
        }

        lastReportedMetrics = metrics
        DispatchQueue.main.async { [weak self] in
            self?.keyboardMetricsChanged?(metrics)
        }
    }
}

private struct DrawerBottomTapBlocker: View {
    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .onTapGesture {}
            .accessibilityHidden(true)
    }
}

private struct DrawerWorkspaceDisclosureRow: View {
    let workspace: DrawerWorkspace
    let workspaceRowID: String
    let managementEnabled: Bool
    let isPinnedWorkspace: Bool
    let selectedThreadID: String
    let pinnedThreadIDs: Set<String>
    @Binding var isExpanded: Bool
    let renamingRowID: String?
    let isRenamingWorkspace: Bool
    @Binding var renameDraft: String
    @Binding var workspaceRenameDraft: String
    let renameFocus: FocusState<String?>.Binding
    let selectThread: (DrawerThread) -> Void
    let startRename: (DrawerThread, String) -> Void
    let finishRename: (String) -> Void
    let togglePinned: (String) -> Void
    let requestDelete: (String) -> Void
    let startWorkspaceRename: (DrawerWorkspace, String) -> Void
    let finishWorkspaceRename: (String) -> Void
    let toggleWorkspacePinned: (String) -> Void
    let requestWorkspaceDelete: (String) -> Void
    let rowFrameChanged: (String, CGRect) -> Void
    @State private var showsAllThreads = false

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(collapsedThreads) { thread in
                    threadRow(thread)
                        .transition(.opacity)
                }

                if !overflowThreads.isEmpty {
                    DisclosureGroup(isExpanded: $showsAllThreads) {
                        VStack(alignment: .leading, spacing: 7) {
                            ForEach(overflowThreads) { thread in
                                threadRow(thread)
                                    .transition(.opacity)
                            }
                        }
                        .padding(.top, 7)
                    } label: {
                        Text(showsAllThreads ? "收起" : "展开全部（还有 \(overflowThreads.count) 个）")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .tint(.secondary)
                }
            }
            .scrollTargetLayout()
            .padding(.top, 8)
            .padding(.leading, 32)
        } label: {
            HStack(spacing: 2) {
                if isRenamingWorkspace {
                    workspaceIcon

                    TextField("工作区名称", text: $workspaceRenameDraft)
                        .textFieldStyle(.plain)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .submitLabel(.done)
                        .focused(renameFocus, equals: workspaceRowID)
                        .onSubmit {
                            finishWorkspaceRename(workspace.id)
                        }
                } else {
                    Menu {
                        workspaceActionItems
                    } label: {
                        HStack(spacing: AthenaSpacing.md) {
                            workspaceIcon

                            Text(workspace.title)
                                .font(.body.weight(.medium))
                                .foregroundStyle(.primary.opacity(0.94))
                                .lineLimit(1)

                            Spacer(minLength: 0)
                        }
                        .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
                        .contentShape(Rectangle())
                    } primaryAction: {
                        isExpanded.toggle()
                    }
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                    .accessibilityLabel(workspace.title)
                    .accessibilityHint(isExpanded ? "收起线程" : "展开线程")
                }
            }
            .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
            .contentShape(Rectangle())
            .id(workspaceRowID)
            .onGeometryChange(for: CGRect.self) { geometry in
                geometry.frame(in: .global)
            } action: { frame in
                rowFrameChanged(workspaceRowID, frame)
            }
        }
        .tint(.primary.opacity(0.54))
        .animation(.smooth, value: isExpanded)
        .animation(.smooth, value: collapsedThreads.map(\.id))
        .animation(.smooth, value: showsAllThreads)
    }

    private var collapsedThreads: [DrawerThread] {
        guard workspace.threads.count > 6 else { return workspace.threads }
        let overview = workspace.threads.first(where: \.isOverview)
        let chats = workspace.threads.filter { !$0.isOverview }
        var visible = overview.map { [$0] } ?? []
        let availableChatSlots = 6 - visible.count
        visible.append(contentsOf: chats.prefix(availableChatSlots))
        if let selected = workspace.threads.first(where: { $0.id == selectedThreadID }),
           !visible.contains(where: { $0.id == selected.id }) {
            if visible.count == 6 {
                visible.removeLast()
            }
            visible.append(selected)
        }
        return visible
    }

    private var overflowThreads: [DrawerThread] {
        let visibleIDs = Set(collapsedThreads.map(\.id))
        return workspace.threads.filter { !visibleIDs.contains($0.id) }
    }

    private func threadRow(_ thread: DrawerThread) -> some View {
        let rowID = "workspace:\(workspace.id):\(thread.id)"
        return DrawerThreadRow(
            thread: thread,
            rowID: rowID,
            managementEnabled: managementEnabled,
            isActive: thread.id == selectedThreadID,
            isPinned: pinnedThreadIDs.contains(thread.id),
            isRenaming: renamingRowID == rowID,
            renameDraft: $renameDraft,
            renameFocus: renameFocus,
            selectThread: selectThread,
            startRename: { startRename(thread, rowID) },
            finishRename: { finishRename(thread.id) },
            togglePinned: { togglePinned(thread.id) },
            requestDelete: { requestDelete(thread.id) },
            rowFrameChanged: rowFrameChanged
        )
    }

    private var workspaceIcon: some View {
        Image(systemName: workspace.systemImage)
            .font(.body.weight(.medium))
            .foregroundStyle(workspace.tint)
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var workspaceActionItems: some View {
        Button {
            startWorkspaceRename(workspace, workspaceRowID)
        } label: {
            Label("重命名", systemImage: "pencil")
        }
        .disabled(!managementEnabled)

        Button {
            toggleWorkspacePinned(workspace.id)
        } label: {
            Label(
                isPinnedWorkspace ? "取消置顶" : "置顶",
                systemImage: isPinnedWorkspace ? "pin.slash" : "pin"
            )
        }

        Button(role: .destructive) {
            requestWorkspaceDelete(workspace.id)
        } label: {
            Label("删除", systemImage: "trash")
        }
        .disabled(!managementEnabled)
    }
}

private struct DrawerThreadRow: View {
    let thread: DrawerThread
    let rowID: String
    let managementEnabled: Bool
    let isActive: Bool
    let isPinned: Bool
    let isRenaming: Bool
    @Binding var renameDraft: String
    let renameFocus: FocusState<String?>.Binding
    let selectThread: (DrawerThread) -> Void
    let startRename: () -> Void
    let finishRename: () -> Void
    let togglePinned: () -> Void
    let requestDelete: () -> Void
    let rowFrameChanged: (String, CGRect) -> Void

    var body: some View {
        HStack(spacing: 2) {
            if isRenaming {
                threadIcon

                TextField("线程名称", text: $renameDraft)
                    .textFieldStyle(.plain)
                    .font(.subheadline.weight(.regular))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .submitLabel(.done)
                    .focused(renameFocus, equals: rowID)
                    .onSubmit(finishRename)
            } else {
                Button {
                    selectThread(thread)
                } label: {
                    HStack(spacing: 8) {
                        threadIcon

                        Text(thread.title)
                            .font(.subheadline.weight(isActive ? .semibold : .regular))
                            .lineLimit(1)

                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            Menu {
                Button(action: startRename) {
                    Label("重命名", systemImage: "pencil")
                }
                .disabled(!managementEnabled)

                Button(action: togglePinned) {
                    Label(
                        isPinned ? "取消置顶" : "置顶",
                        systemImage: isPinned ? "pin.slash" : "pin"
                    )
                }

                Button(role: .destructive, action: requestDelete) {
                    Label("删除", systemImage: "trash")
                }
                .disabled(!managementEnabled)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .menuIndicator(.hidden)
            .menuOrder(.fixed)
            .accessibilityLabel("\(thread.title)操作")
            .disabled(thread.isPending)
        }
        .foregroundStyle(isActive ? Color.accentColor : Color.primary.opacity(0.84))
        .padding(.leading, 10)
        .padding(.trailing, 2)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .background(
            isActive ? Color.accentColor.opacity(0.12) : Color.clear,
            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
        )
        .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .id(rowID)
        .onGeometryChange(for: CGRect.self) { geometry in
            geometry.frame(in: .global)
        } action: { frame in
            rowFrameChanged(rowID, frame)
        }
        .accessibilityElement(children: .contain)
    }

    private var threadIcon: some View {
        Image(systemName: "bubble.left")
            .font(.footnote.weight(.medium))
            .frame(width: 18, height: 24)
            .accessibilityHidden(true)
    }
}

private struct DrawerRow: View {
    let item: DrawerItem
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: AthenaSpacing.md) {
                Image(systemName: item.systemImage)
                    .font(.body.weight(.medium))
                    .foregroundStyle(item.tint)
                    .frame(width: 28, height: 28)

                Text(item.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary.opacity(0.94))
                    .lineLimit(1)

                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct DrawerSectionTitle: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.primary.opacity(0.86))
            .padding(.bottom, AthenaSpacing.sm)
    }
}

private struct ConversationBackground: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(.systemBackground),
                Color(.secondarySystemBackground).opacity(0.46),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }
}

private struct ConversationPageBackground: View {
    var body: some View {
        Color(.systemBackground)
            .ignoresSafeArea()
    }
}

private struct ConversationDrawerDefocusLayer: View {
    let progress: CGFloat

    var body: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .opacity(min(max(progress, 0), 1) * 0.58)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private struct ConversationDrawerRevealMaterial: View {
    let progress: CGFloat

    var body: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .opacity((1 - min(max(progress, 0), 1)) * 0.72)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

private extension View {
    func drawerTopScrollFeather() -> some View {
        scrollTransition(
            topLeading: .interactive,
            bottomTrailing: .identity,
            axis: .vertical
        ) { content, phase in
            content
                .opacity(phase == .topLeading ? 0.08 : 1)
                .blur(radius: phase == .topLeading ? 5 : 0)
        }
    }

    @ViewBuilder
    func athenaConcentricGlass(minimum: CGFloat, fallbackRadius: CGFloat, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if interactive {
                self.glassEffect(
                    .regular.interactive(),
                    in: ConcentricRectangle(corners: .concentric(minimum: .fixed(minimum)), isUniform: true)
                )
            } else {
                self.glassEffect(
                    .regular,
                    in: ConcentricRectangle(corners: .concentric(minimum: .fixed(minimum)), isUniform: true)
                )
            }
        } else {
            self.background(
                .ultraThinMaterial,
                in: RoundedRectangle(cornerRadius: fallbackRadius, style: .continuous)
            )
        }
    }
}

private struct GlassIconButton: View {
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .frame(width: 46, height: 46)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .athenaGlass(in: Circle(), interactive: true)
        .accessibilityLabel(systemImage)
    }
}

private struct KeyboardCoordinatedConversationHost<Content: View>: UIViewControllerRepresentable {
    @Binding var isEditing: Bool
    @Binding var draft: String
    @Binding var selection: ComposerTextSelection
    @Binding var restoreSelectionRequestID: Int

    let chatScrollRuntime: ChatScrollRuntimeState
    let conversationLayoutState: ConversationLayoutState
    let contentRevision: ChatHostContentRevision
    let keyboardGap: CGFloat
    let restingBottomGap: CGFloat
    let sendBlocked: Bool
    let isGenerating: Bool
    let isEditingMessage: Bool
    let sendAction: (String) -> Void
    let stopAction: () -> Void
    let cancelEditAction: () -> Void
    let content: Content

    func makeCoordinator() -> Coordinator {
        Coordinator(
            isEditing: $isEditing,
            draft: $draft,
            selection: $selection,
            restoreSelectionRequestID: restoreSelectionRequestID
        )
    }

    func makeUIViewController(context: Context) -> KeyboardCoordinatedConversationController<Content> {
        let controller = KeyboardCoordinatedConversationController(
            content: content,
            contentRevision: contentRevision,
            chatScrollRuntime: chatScrollRuntime,
            conversationLayoutState: conversationLayoutState,
            keyboardGap: keyboardGap,
            restingBottomGap: restingBottomGap
        )
        configure(controller.composerHostView, coordinator: context.coordinator)
        return controller
    }

    func updateUIViewController(
        _ controller: KeyboardCoordinatedConversationController<Content>,
        context: Context
    ) {
        let view = controller.composerHostView
        context.coordinator.isEditing = $isEditing
        context.coordinator.draft = $draft
        context.coordinator.selection = $selection
        controller.updateContent(content, revision: contentRevision)
        view.keyboardGap = keyboardGap
        view.restingBottomGap = restingBottomGap
        view.setSendBlocked(sendBlocked)
        view.setGenerating(isGenerating)
        let editModeChanged = context.coordinator.lastEditingMessage != isEditingMessage
        view.setEditingMessage(isEditingMessage)
        context.coordinator.lastEditingMessage = isEditingMessage
        configure(view, coordinator: context.coordinator)

        composerDebugLog(
            "updateUIView desiredEditing=\(isEditing) firstResponder=\(view.isComposerFirstResponder) draftLength=\(draft.utf16.count)"
        )

        context.coordinator.isApplyingSwiftUIState = true
        defer {
            context.coordinator.isApplyingSwiftUIState = false
        }
        view.setDraft(draft, force: editModeChanged)
        view.setEditing(isEditing)

        if context.coordinator.lastRestoreSelectionRequestID != restoreSelectionRequestID {
            context.coordinator.lastRestoreSelectionRequestID = restoreSelectionRequestID
            if isEditing {
                view.restoreFocus(selection: selection.nsRange)
            }
        }
    }

    private func configure(_ view: KeyboardComposerHostView, coordinator: Coordinator) {
        view.onTextChange = { text in
            guard !coordinator.isApplyingSwiftUIState else {
                composerDebugLog("text callback suppressed length=\(text.utf16.count)")
                return
            }
            guard coordinator.draft.wrappedValue != text else {
                return
            }
            composerDebugLog("text callback accepted length=\(text.utf16.count)")
            coordinator.draft.wrappedValue = text
        }
        view.onEditingChanged = { active in
            guard !coordinator.isApplyingSwiftUIState else {
                composerDebugLog("editing callback suppressed active=\(active)")
                return
            }
            guard coordinator.isEditing.wrappedValue != active else {
                return
            }
            composerDebugLog("editing callback accepted active=\(active)")
            coordinator.isEditing.wrappedValue = active
        }
        view.onSelectionChange = { range in
            guard !coordinator.isApplyingSwiftUIState else {
                return
            }
            let selection = ComposerTextSelection(range: range)
            guard coordinator.selection.wrappedValue != selection else {
                return
            }
            coordinator.selection.wrappedValue = selection
        }
        view.onSend = sendAction
        view.onStop = stopAction
        view.onCancelEdit = cancelEditAction
    }

    final class Coordinator {
        var isEditing: Binding<Bool>
        var draft: Binding<String>
        var selection: Binding<ComposerTextSelection>
        var lastRestoreSelectionRequestID: Int
        var lastEditingMessage = false
        var isApplyingSwiftUIState = false

        init(
            isEditing: Binding<Bool>,
            draft: Binding<String>,
            selection: Binding<ComposerTextSelection>,
            restoreSelectionRequestID: Int
        ) {
            self.isEditing = isEditing
            self.draft = draft
            self.selection = selection
            self.lastRestoreSelectionRequestID = restoreSelectionRequestID
        }
    }
}

private final class KeyboardCoordinatedConversationController<Content: View>: UIViewController {
    let composerHostView: KeyboardComposerHostView

    private let timelineStore: ConversationTimelineStore<Content>
    private let contentController: UIHostingController<ConversationTimelineHostingRoot<Content>>
    private let chatScrollRuntime: ChatScrollRuntimeState
    private let conversationLayoutState: ConversationLayoutState
    private var contentRevision: ChatHostContentRevision
    private var contentRootBottomConstraint: NSLayoutConstraint?
    private var contentKeyboardBottomConstraint: NSLayoutConstraint?
    private weak var conversationScrollView: UIScrollView?
    private var horizontalOffsetObservation: NSKeyValueObservation?
    private var isCorrectingHorizontalOffset = false
    private var bottomScrollEdgeInteraction: UIScrollEdgeElementContainerInteraction?
    private var followsKeyboardForCurrentFocus = false
    private var returnsToRootAfterKeyboardDismissal = false
    private var userMovedConversationDuringKeyboardFocus = false
    #if DEBUG
    private var lastLoggedLayout: KeyboardLayoutSnapshot?
    #endif

    init(
        content: Content,
        contentRevision: ChatHostContentRevision,
        chatScrollRuntime: ChatScrollRuntimeState,
        conversationLayoutState: ConversationLayoutState,
        keyboardGap: CGFloat,
        restingBottomGap: CGFloat
    ) {
        let timelineStore = ConversationTimelineStore(content: content)
        self.timelineStore = timelineStore
        self.contentRevision = contentRevision
        contentController = UIHostingController(
            rootView: ConversationTimelineHostingRoot(store: timelineStore)
        )
        contentController.safeAreaRegions = []
        self.chatScrollRuntime = chatScrollRuntime
        self.conversationLayoutState = conversationLayoutState
        composerHostView = KeyboardComposerHostView(
            keyboardGap: keyboardGap,
            restingBottomGap: restingBottomGap
        )
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.isOpaque = false
        view.clipsToBounds = false

        if #available(iOS 17.0, *) {
            view.keyboardLayoutGuide.followsUndockedKeyboard = true
            view.keyboardLayoutGuide.usesBottomSafeArea = false
        }

        addChild(contentController)
        let contentView = contentController.view!
        contentView.translatesAutoresizingMaskIntoConstraints = false
        contentView.backgroundColor = .clear
        contentView.isOpaque = false
        view.addSubview(contentView)
        contentController.didMove(toParent: self)

        composerHostView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(composerHostView)

        let contentRootBottomConstraint = contentView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        let contentKeyboardBottomConstraint = contentView.bottomAnchor.constraint(
            equalTo: view.keyboardLayoutGuide.topAnchor
        )
        contentKeyboardBottomConstraint.isActive = false
        self.contentRootBottomConstraint = contentRootBottomConstraint
        self.contentKeyboardBottomConstraint = contentKeyboardBottomConstraint

        NSLayoutConstraint.activate([
            contentView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentView.topAnchor.constraint(equalTo: view.topAnchor),
            contentRootBottomConstraint,
            composerHostView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerHostView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composerHostView.topAnchor.constraint(equalTo: view.topAnchor),
            composerHostView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        composerHostView.onWillBeginEditing = { [weak self] in
            self?.prepareConversationForComposerFocus()
        }
        composerHostView.onDidEndEditing = { [weak self] in
            self?.finishConversationComposerFocus()
        }
        composerHostView.attachKeyboardGuide(view.keyboardLayoutGuide)

        if #available(iOS 26.0, *) {
            let interaction = UIScrollEdgeElementContainerInteraction()
            interaction.edge = .bottom
            composerHostView.addInteraction(interaction)
            bottomScrollEdgeInteraction = interaction
        }
    }

    func updateContent(_ content: Content, revision: ChatHostContentRevision) {
        guard contentRevision != revision else { return }
        contentRevision = revision
        timelineStore.update(content: content)
    }

    private func prepareConversationForComposerFocus() {
        returnsToRootAfterKeyboardDismissal = false
        userMovedConversationDuringKeyboardFocus = false
        followsKeyboardForCurrentFocus = chatScrollRuntime.latestMetrics?.isAtBottom ?? true
        conversationLayoutState.setSizeChangeAnchor(
            followsKeyboardForCurrentFocus ? .bottom : .top
        )
        setConversationFollowsKeyboard(followsKeyboardForCurrentFocus)
    }

    private func finishConversationComposerFocus() {
        guard contentKeyboardBottomConstraint?.isActive == true else {
            followsKeyboardForCurrentFocus = false
            return
        }

        // Keep following the system keyboard guide throughout dismissal. Once the
        // guide reaches the root bottom, both constraints are equivalent and can be
        // swapped without introducing a second animation or a visible jump.
        returnsToRootAfterKeyboardDismissal = true
        completeKeyboardDismissalIfNeeded()
    }

    private func setConversationFollowsKeyboard(_ followsKeyboard: Bool) {
        guard contentKeyboardBottomConstraint?.isActive != followsKeyboard else {
            return
        }
        contentRootBottomConstraint?.isActive = !followsKeyboard
        contentKeyboardBottomConstraint?.isActive = followsKeyboard
        view.layoutIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        completeKeyboardDismissalIfNeeded()
        configureConversationScrollEdgeEffects()
        maintainConversationBottomDuringKeyboardTransition()
        updateConversationBottomClearance()
        #if DEBUG
        guard let contentView = contentController.view else { return }
        let snapshot = KeyboardLayoutSnapshot(
            root: view.bounds.integral,
            content: contentView.frame.integral,
            composerHost: composerHostView.frame.integral,
            followsKeyboard: followsKeyboardForCurrentFocus
        )
        if snapshot != lastLoggedLayout {
            lastLoggedLayout = snapshot
            composerDebugLog(
                "layout root=\(snapshot.root.debugDescription) content=\(snapshot.content.debugDescription) composerHost=\(snapshot.composerHost.debugDescription) followsKeyboard=\(snapshot.followsKeyboard)"
            )
        }
        assert(abs(contentView.frame.minX) < 1, "Conversation content drifted horizontally")
        assert(abs(contentView.frame.midX - view.bounds.midX) < 1, "Conversation content lost horizontal centering")
        #endif
    }

    private func completeKeyboardDismissalIfNeeded() {
        guard returnsToRootAfterKeyboardDismissal,
              ConversationKeyboardLayoutPolicy.keyboardIsFullyDismissed(
                keyboardTop: view.keyboardLayoutGuide.layoutFrame.minY,
                viewportBottom: view.bounds.maxY
              ) else {
            return
        }

        returnsToRootAfterKeyboardDismissal = false
        followsKeyboardForCurrentFocus = false
        userMovedConversationDuringKeyboardFocus = false
        setConversationFollowsKeyboard(false)
    }

    private func maintainConversationBottomDuringKeyboardTransition() {
        guard followsKeyboardForCurrentFocus,
              !userMovedConversationDuringKeyboardFocus,
              let scrollView = conversationScrollView else {
            return
        }

        if chatScrollRuntime.phase == .tracking
            || chatScrollRuntime.phase == .interacting
            || chatScrollRuntime.phase == .decelerating {
            userMovedConversationDuringKeyboardFocus = true
            return
        }

        guard composerHostView.isComposerFirstResponder
                || returnsToRootAfterKeyboardDismissal else {
            return
        }

        let minimumOffsetY = -scrollView.adjustedContentInset.top
        let maximumOffsetY = max(
            minimumOffsetY,
            scrollView.contentSize.height
                - scrollView.bounds.height
                + scrollView.adjustedContentInset.bottom
        )
        guard abs(scrollView.contentOffset.y - maximumOffsetY) > 0.5 else {
            return
        }

        scrollView.setContentOffset(
            CGPoint(x: scrollView.contentOffset.x, y: maximumOffsetY),
            animated: false
        )
    }

    private func updateConversationBottomClearance() {
        guard let contentView = contentController.view else { return }
        let composerFrame = composerHostView.composerFrame(in: contentView)
        guard composerFrame.height.isFinite, composerFrame.height > 0 else { return }
        let keyboardIsVisible = view.keyboardLayoutGuide.layoutFrame.minY
            < view.bounds.maxY - 1
        conversationLayoutState.scheduleBottomContentClearance(
            ComposerLayoutPolicy.bottomContentClearance(
                composerHeight: composerFrame.height,
                bottomGap: keyboardIsVisible
                    ? composerHostView.keyboardGap
                    : composerHostView.restingBottomGap
            )
        )
    }

    private func configureConversationScrollEdgeEffects() {
        guard #available(iOS 26.0, *) else {
            return
        }
        guard conversationScrollView == nil else { return }

        guard let contentView = contentController.view,
              let scrollView = contentView.largestDescendantScrollView else {
            return
        }

        conversationScrollView = scrollView
        scrollView.alwaysBounceHorizontal = false
        scrollView.isDirectionalLockEnabled = true
        scrollView.showsHorizontalScrollIndicator = false
        horizontalOffsetObservation = scrollView.observe(
            \.contentOffset,
            options: [.initial, .new]
        ) { [weak self, weak scrollView] _, _ in
            guard let self, let scrollView else { return }
            self.keepConversationScrollViewHorizontallyCentered(scrollView)
        }
        bottomScrollEdgeInteraction?.scrollView = scrollView
    }

    private func keepConversationScrollViewHorizontallyCentered(
        _ scrollView: UIScrollView
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !isCorrectingHorizontalOffset else { return }
        let expectedOffsetX = -scrollView.adjustedContentInset.left
        guard abs(scrollView.contentOffset.x - expectedOffsetX) > 0.5 else {
            return
        }

        isCorrectingHorizontalOffset = true
        scrollView.contentOffset = CGPoint(
            x: expectedOffsetX,
            y: scrollView.contentOffset.y
        )
        isCorrectingHorizontalOffset = false
    }

}

private extension UIView {
    var largestDescendantScrollView: UIScrollView? {
        descendantScrollViews.max { lhs, rhs in
            lhs.bounds.width * lhs.bounds.height < rhs.bounds.width * rhs.bounds.height
        }
    }

    var descendantScrollViews: [UIScrollView] {
        subviews.flatMap { subview -> [UIScrollView] in
            let current = (subview as? UIScrollView).map { [$0] } ?? []
            return current + subview.descendantScrollViews
        }
    }
}

#if DEBUG
private struct KeyboardLayoutSnapshot: Equatable {
    let root: CGRect
    let content: CGRect
    let composerHost: CGRect
    let followsKeyboard: Bool
}
#endif

private final class KeyboardComposerHostView: UIView {
    private enum Metrics {
        static let restingHorizontalInset: CGFloat = 44
        static let editingHorizontalInset: CGFloat = 16
    }

    var onTextChange: ((String) -> Void)?
    var onEditingChanged: ((Bool) -> Void)?
    var onSelectionChange: ((NSRange) -> Void)?
    var onSend: ((String) -> Void)?
    var onStop: (() -> Void)?
    var onCancelEdit: (() -> Void)?
    var onWillBeginEditing: (() -> Void)?
    var onDidEndEditing: (() -> Void)?

    var keyboardGap: CGFloat {
        didSet {
            keyboardPinConstraint?.constant = -keyboardGap
            updateKeyboardDismissPadding()
        }
    }

    var restingBottomGap: CGFloat {
        didSet {
            restingBottomConstraint?.constant = -restingBottomGap
            restingBottomCapConstraint?.constant = -restingBottomGap
        }
    }

    private let composerView = UIKitKeyboardComposerView()
    private var keyboardPinConstraint: NSLayoutConstraint?
    private var restingBottomConstraint: NSLayoutConstraint?
    private var restingBottomCapConstraint: NSLayoutConstraint?
    private var widthConstraint: NSLayoutConstraint?
    private var heightConstraint: NSLayoutConstraint?
    private var isEditing = false

    var isComposerFirstResponder: Bool {
        composerView.isComposerFirstResponder
    }

    func composerFrame(in view: UIView) -> CGRect {
        composerView.convert(composerView.bounds, to: view)
    }

    init(keyboardGap: CGFloat, restingBottomGap: CGFloat) {
        self.keyboardGap = keyboardGap
        self.restingBottomGap = restingBottomGap
        super.init(frame: .zero)
        setup()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let convertedPoint = composerView.convert(point, from: self)
        guard composerView.point(inside: convertedPoint, with: event) else {
            return nil
        }
        return composerView.hitTest(convertedPoint, with: event)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let targetWidth = composerWidth(editing: isEditing)
        if abs((widthConstraint?.constant ?? 0) - targetWidth) > 0.5 {
            widthConstraint?.constant = targetWidth
        }
    }

    func attachKeyboardGuide(_ keyboardGuide: UIKeyboardLayoutGuide) {
        keyboardPinConstraint?.isActive = false
        let constraint = composerView.bottomAnchor.constraint(
            equalTo: keyboardGuide.topAnchor,
            constant: -keyboardGap
        )
        constraint.priority = UILayoutPriority(999)
        constraint.isActive = true
        keyboardPinConstraint = constraint
    }

    func setDraft(_ draft: String, force: Bool = false) {
        composerView.setText(draft, force: force)
    }

    func setEditing(_ editing: Bool) {
        composerDebugLog(
            "host setEditing requested=\(editing) hostState=\(isEditing) firstResponder=\(composerView.isComposerFirstResponder)"
        )
        if editing != isEditing {
            isEditing = editing
            composerView.setEditing(editing, animated: true)
            widthConstraint?.constant = composerWidth(editing: editing)

            UIView.animate(
                withDuration: 0.28,
                delay: 0,
                usingSpringWithDamping: 0.92,
                initialSpringVelocity: 0.08,
                options: [.beginFromCurrentState, .allowUserInteraction]
            ) {
                self.layoutIfNeeded()
            }
        }

        if editing {
            if !composerView.isComposerFirstResponder {
                composerView.focus()
            }
        } else {
            composerView.resignComposer()
        }
    }

    func restoreFocus(selection: NSRange) {
        if !isEditing {
            setEditing(true)
        }
        composerView.focus(restoring: selection)
    }

    func setSendBlocked(_ blocked: Bool) {
        composerView.setSendBlocked(blocked)
    }

    func setGenerating(_ generating: Bool) {
        composerView.setGenerating(generating)
    }

    func setEditingMessage(_ active: Bool) {
        composerView.setEditingMessage(active)
    }

    private func setup() {
        backgroundColor = .clear
        isOpaque = false
        if #available(iOS 17.0, *) {
            keyboardLayoutGuide.followsUndockedKeyboard = true
            keyboardLayoutGuide.usesBottomSafeArea = false
        }

        composerView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(composerView)

        let centerXConstraint = composerView.centerXAnchor.constraint(equalTo: centerXAnchor)
        let widthConstraint = composerView.widthAnchor.constraint(equalToConstant: 0)
        let keyboardPinConstraint = composerView.bottomAnchor.constraint(
            equalTo: keyboardLayoutGuide.topAnchor,
            constant: -keyboardGap
        )
        keyboardPinConstraint.priority = UILayoutPriority(999)
        let restingBottomConstraint = composerView.bottomAnchor.constraint(
            equalTo: safeAreaLayoutGuide.bottomAnchor,
            constant: -restingBottomGap
        )
        restingBottomConstraint.priority = UILayoutPriority(998)
        let restingBottomCapConstraint = composerView.bottomAnchor.constraint(
            lessThanOrEqualTo: safeAreaLayoutGuide.bottomAnchor,
            constant: -restingBottomGap
        )
        let heightConstraint = composerView.heightAnchor.constraint(equalToConstant: UIKitKeyboardComposerView.restingHeight)

        self.widthConstraint = widthConstraint
        self.keyboardPinConstraint = keyboardPinConstraint
        self.restingBottomConstraint = restingBottomConstraint
        self.restingBottomCapConstraint = restingBottomCapConstraint
        self.heightConstraint = heightConstraint

        NSLayoutConstraint.activate([
            centerXConstraint,
            widthConstraint,
            keyboardPinConstraint,
            restingBottomConstraint,
            restingBottomCapConstraint,
            heightConstraint,
        ])

        composerView.onTextChange = { [weak self] text in
            self?.onTextChange?(text)
        }
        composerView.onEditingChanged = { [weak self] active in
            self?.onEditingChanged?(active)
        }
        composerView.onSelectionChange = { [weak self] range in
            self?.onSelectionChange?(range)
        }
        composerView.onWillBeginEditing = { [weak self] in
            self?.onWillBeginEditing?()
        }
        composerView.onDidEndEditing = { [weak self] in
            self?.onDidEndEditing?()
        }
        composerView.onHeightChange = { [weak self] height in
            self?.updateComposerHeight(height)
        }
        composerView.onSend = { [weak self] text in
            self?.onSend?(text)
        }
        composerView.onStop = { [weak self] in
            self?.onStop?()
        }
        composerView.onCancelEdit = { [weak self] in
            self?.onCancelEdit?()
        }
        updateKeyboardDismissPadding()
    }

    private func composerWidth(editing: Bool) -> CGFloat {
        let inset = editing ? Metrics.editingHorizontalInset : Metrics.restingHorizontalInset
        return max(bounds.width - (inset * 2), 0)
    }

    private func updateComposerHeight(_ height: CGFloat) {
        guard heightConstraint?.constant != height else {
            return
        }

        heightConstraint?.constant = height
        setNeedsLayout()
        superview?.layoutIfNeeded()
        updateKeyboardDismissPadding()
    }

    private func updateKeyboardDismissPadding() {
        if #available(iOS 17.0, *) {
            keyboardLayoutGuide.keyboardDismissPadding = max(
                UIKitKeyboardComposerView.editingCompactHeight + max(keyboardGap, 0),
                heightConstraint?.constant ?? UIKitKeyboardComposerView.editingCompactHeight
            )
        }
    }
}

private struct KeyboardComposerGlassBackground: View {
    var body: some View {
        Color.clear
            .athenaConcentricGlass(minimum: 28, fallbackRadius: 29, interactive: true)
    }
}

private struct KeyboardComposerMenuGlassBackground: View {
    var body: some View {
        Color.clear
            .athenaConcentricGlass(minimum: 18, fallbackRadius: 22, interactive: true)
    }
}

private final class UIKitKeyboardComposerView: UIView, UITextViewDelegate {
    static let restingHeight: CGFloat = 52
    static let editingCompactHeight: CGFloat = 58

    var onTextChange: ((String) -> Void)?
    var onEditingChanged: ((Bool) -> Void)?
    var onSelectionChange: ((NSRange) -> Void)?
    var onHeightChange: ((CGFloat) -> Void)?
    var onSend: ((String) -> Void)?
    var onStop: (() -> Void)?
    var onCancelEdit: (() -> Void)?
    var onWillBeginEditing: (() -> Void)?
    var onDidEndEditing: (() -> Void)?

    private let glassHostingController = UIHostingController(rootView: KeyboardComposerGlassBackground())
    private let contentView = UIView()
    private let plusMenuGlassHostingController = UIHostingController(rootView: KeyboardComposerMenuGlassBackground())
    private let plusMenuView = UIView()
    private let plusMenuStackView = UIStackView()
    private let textView = UITextView()
    private let placeholderLabel = UILabel()
    private let plusButton = UIButton(type: .system)
    private let voiceButton = UIButton(type: .system)
    private let sendButton = UIButton(type: .system)
    private let sendProgressView = UIActivityIndicatorView(style: .medium)
    private let editStatusView = UIView()
    private let editIndicatorButton = UIButton(type: .system)
    private let cancelEditButton = UIButton(type: .system)

    private var compactConstraints: [NSLayoutConstraint] = []
    private var expandedConstraints: [NSLayoutConstraint] = []
    private var textHeightConstraint: NSLayoutConstraint?
    private var voiceWidthConstraint: NSLayoutConstraint?
    private var expandedTextTopConstraint: NSLayoutConstraint?
    private var expanded = false
    private var editing = false
    private var lastReportedHeight = restingHeight
    private var plusMenuVisible = false
    private var sendBlocked = false
    private var generating = false
    private var editingMessage = false
    private var hasSendText = false
    private var lastLayoutWidth: CGFloat = 0
    private var focusRequestID = 0

    var isComposerFirstResponder: Bool {
        textView.isFirstResponder
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard abs(bounds.width - lastLayoutWidth) > 0.5 else {
            return
        }

        lastLayoutWidth = bounds.width
        updateLayout(animated: false)
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        super.point(inside: point, with: event)
            || (!plusMenuView.isHidden && plusMenuView.frame.insetBy(dx: -8, dy: -8).contains(point))
    }

    func setText(_ text: String, force: Bool = false) {
        guard textView.text != text else {
            return
        }
        guard force || !textView.isFirstResponder else {
            composerDebugLog(
                "external text sync ignored while editing externalLength=\(text.utf16.count) nativeLength=\(textView.text.utf16.count) marked=\(textView.markedTextRange != nil)"
            )
            return
        }

        textView.text = text
        textView.selectedRange = clampedRange(textView.selectedRange)
        onSelectionChange?(textView.selectedRange)
        updateLayout(animated: false)
    }

    func focus() {
        focus(restoring: nil)
    }

    func focus(restoring selection: NSRange?) {
        focusRequestID &+= 1
        let requestID = focusRequestID
        composerDebugLog("focus scheduled request=\(requestID)")
        DispatchQueue.main.async {
            guard requestID == self.focusRequestID else {
                composerDebugLog(
                    "focus cancelled request=\(requestID) current=\(self.focusRequestID)"
                )
                return
            }
            composerDebugLog("focus executing request=\(requestID)")
            self.setEditing(true, animated: true)
            if !self.textView.isFirstResponder {
                self.textView.becomeFirstResponder()
            }
            if let selection {
                let restoredRange = self.clampedRange(selection)
                self.textView.selectedRange = restoredRange
                self.textView.scrollRangeToVisible(restoredRange)
                self.onSelectionChange?(restoredRange)
            }
        }
    }

    func resignComposer() {
        focusRequestID &+= 1
        let requestID = focusRequestID
        composerDebugLog(
            "resign scheduled request=\(requestID) firstResponder=\(textView.isFirstResponder)"
        )
        setPlusMenuVisible(false, animated: false)
        onSelectionChange?(textView.selectedRange)
        setEditing(false, animated: true)
        guard textView.isFirstResponder else {
            return
        }

        DispatchQueue.main.async {
            guard requestID == self.focusRequestID else {
                composerDebugLog(
                    "resign cancelled request=\(requestID) current=\(self.focusRequestID)"
                )
                return
            }
            let resigned = self.textView.resignFirstResponder()
            composerDebugLog(
                "resign executed request=\(requestID) result=\(resigned) firstResponder=\(self.textView.isFirstResponder)"
            )
        }
    }

    func setEditing(_ editing: Bool, animated: Bool) {
        guard self.editing != editing else {
            return
        }

        self.editing = editing
        updateLayout(animated: animated)
    }

    func textViewShouldBeginEditing(_ textView: UITextView) -> Bool {
        onWillBeginEditing?()
        return true
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
        composerDebugLog("textView didBegin")
        setEditing(true, animated: true)
        onEditingChanged?(true)
    }

    func textViewDidChange(_ textView: UITextView) {
        composerDebugLog("textView didChange length=\(textView.text.utf16.count)")
        onTextChange?(textView.text ?? "")
        onSelectionChange?(textView.selectedRange)
        updateLayout(animated: true)
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        onSelectionChange?(textView.selectedRange)
    }

    func textViewDidEndEditing(_ textView: UITextView) {
        composerDebugLog("textView didEnd")
        focusRequestID &+= 1
        setPlusMenuVisible(false, animated: false)
        setEditing(false, animated: true)
        onEditingChanged?(false)
        onDidEndEditing?()
    }

    private func setup() {
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.06
        layer.shadowRadius = 12
        layer.shadowOffset = CGSize(width: 0, height: 4)

        let glassView = glassHostingController.view!
        glassView.backgroundColor = .clear
        glassView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glassView)

        contentView.translatesAutoresizingMaskIntoConstraints = false
        contentView.backgroundColor = .clear
        addSubview(contentView)

        setupPlusMenu()

        [editStatusView, textView, placeholderLabel, plusButton, voiceButton, sendButton, sendProgressView].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            contentView.addSubview($0)
        }

        configureTextView()
        configureButtons()
        configureEditStatus()

        textHeightConstraint = textView.heightAnchor.constraint(equalToConstant: 42)
        voiceWidthConstraint = voiceButton.widthAnchor.constraint(equalToConstant: 32)

        compactConstraints = [
            plusButton.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            plusButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            sendButton.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            sendButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            voiceButton.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
            voiceButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            textView.leadingAnchor.constraint(equalTo: plusButton.trailingAnchor, constant: 8),
            textView.trailingAnchor.constraint(equalTo: voiceButton.leadingAnchor, constant: -6),
            textView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
        ]

        let expandedTextTopConstraint = textView.topAnchor.constraint(
            equalTo: contentView.topAnchor,
            constant: 10
        )
        self.expandedTextTopConstraint = expandedTextTopConstraint
        expandedConstraints = [
            textView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
            textView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
            expandedTextTopConstraint,
            plusButton.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            plusButton.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
            sendButton.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            sendButton.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
            voiceButton.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
            voiceButton.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -8),
        ]

        NSLayoutConstraint.activate([
            glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
            glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
            glassView.topAnchor.constraint(equalTo: topAnchor),
            glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: trailingAnchor),
            contentView.topAnchor.constraint(equalTo: topAnchor),
            contentView.bottomAnchor.constraint(equalTo: bottomAnchor),
            plusButton.widthAnchor.constraint(equalToConstant: 34),
            plusButton.heightAnchor.constraint(equalToConstant: 42),
            voiceButton.heightAnchor.constraint(equalToConstant: 42),
            sendButton.widthAnchor.constraint(equalToConstant: 42),
            sendButton.heightAnchor.constraint(equalToConstant: 42),
            editStatusView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            editStatusView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            editStatusView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 7),
            editStatusView.heightAnchor.constraint(equalToConstant: 30),
            placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: textView.topAnchor, constant: 9),
            textHeightConstraint!,
            voiceWidthConstraint!,
        ])
        NSLayoutConstraint.activate(compactConstraints)
        updateLayout(animated: false)
    }

    private func configureEditStatus() {
        editStatusView.isHidden = true
        editStatusView.backgroundColor = .clear

        var indicatorConfiguration = UIButton.Configuration.plain()
        indicatorConfiguration.image = UIImage(systemName: "pencil")
        indicatorConfiguration.imagePadding = 7
        indicatorConfiguration.title = "编辑消息"
        indicatorConfiguration.baseForegroundColor = .secondaryLabel
        indicatorConfiguration.contentInsets = .zero
        editIndicatorButton.configuration = indicatorConfiguration
        editIndicatorButton.isUserInteractionEnabled = false
        editIndicatorButton.translatesAutoresizingMaskIntoConstraints = false

        var cancelConfiguration = UIButton.Configuration.plain()
        cancelConfiguration.image = UIImage(systemName: "xmark.circle.fill")
        cancelConfiguration.baseForegroundColor = .secondaryLabel
        cancelConfiguration.contentInsets = .zero
        cancelEditButton.configuration = cancelConfiguration
        cancelEditButton.translatesAutoresizingMaskIntoConstraints = false
        cancelEditButton.addTarget(self, action: #selector(cancelEditTapped), for: .touchUpInside)
        cancelEditButton.accessibilityLabel = "取消编辑"

        editStatusView.addSubview(editIndicatorButton)
        editStatusView.addSubview(cancelEditButton)
        NSLayoutConstraint.activate([
            editIndicatorButton.leadingAnchor.constraint(equalTo: editStatusView.leadingAnchor),
            editIndicatorButton.centerYAnchor.constraint(equalTo: editStatusView.centerYAnchor),
            cancelEditButton.trailingAnchor.constraint(equalTo: editStatusView.trailingAnchor),
            cancelEditButton.centerYAnchor.constraint(equalTo: editStatusView.centerYAnchor),
            cancelEditButton.widthAnchor.constraint(equalToConstant: 30),
            cancelEditButton.heightAnchor.constraint(equalToConstant: 30),
        ])
    }

    @objc private func cancelEditTapped() {
        onCancelEdit?()
    }

    private func setupPlusMenu() {
        plusMenuView.translatesAutoresizingMaskIntoConstraints = false
        plusMenuView.alpha = 0
        plusMenuView.isHidden = true
        plusMenuView.transform = hiddenPlusMenuTransform
        plusMenuView.layer.shadowColor = UIColor.black.cgColor
        plusMenuView.layer.shadowOpacity = 0.08
        plusMenuView.layer.shadowRadius = 18
        plusMenuView.layer.shadowOffset = CGSize(width: 0, height: 8)
        addSubview(plusMenuView)

        let menuGlassView = plusMenuGlassHostingController.view!
        menuGlassView.backgroundColor = .clear
        menuGlassView.translatesAutoresizingMaskIntoConstraints = false
        plusMenuView.addSubview(menuGlassView)

        plusMenuStackView.axis = .vertical
        plusMenuStackView.alignment = .fill
        plusMenuStackView.distribution = .fillEqually
        plusMenuStackView.spacing = 2
        plusMenuStackView.translatesAutoresizingMaskIntoConstraints = false
        plusMenuView.addSubview(plusMenuStackView)

        [
            makePlusMenuButton(title: "相机", systemImage: "camera"),
            makePlusMenuButton(title: "图片", systemImage: "photo"),
            makePlusMenuButton(title: "文件", systemImage: "doc"),
            makePlusMenuButton(title: "测试题", systemImage: "checklist"),
        ].forEach(plusMenuStackView.addArrangedSubview)

        NSLayoutConstraint.activate([
            plusMenuView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            plusMenuView.bottomAnchor.constraint(equalTo: topAnchor, constant: -8),
            plusMenuView.widthAnchor.constraint(equalToConstant: 166),
            plusMenuView.heightAnchor.constraint(equalToConstant: 184),
            menuGlassView.leadingAnchor.constraint(equalTo: plusMenuView.leadingAnchor),
            menuGlassView.trailingAnchor.constraint(equalTo: plusMenuView.trailingAnchor),
            menuGlassView.topAnchor.constraint(equalTo: plusMenuView.topAnchor),
            menuGlassView.bottomAnchor.constraint(equalTo: plusMenuView.bottomAnchor),
            plusMenuStackView.leadingAnchor.constraint(equalTo: plusMenuView.leadingAnchor, constant: 10),
            plusMenuStackView.trailingAnchor.constraint(equalTo: plusMenuView.trailingAnchor, constant: -10),
            plusMenuStackView.topAnchor.constraint(equalTo: plusMenuView.topAnchor, constant: 10),
            plusMenuStackView.bottomAnchor.constraint(equalTo: plusMenuView.bottomAnchor, constant: -10),
        ])
    }

    private func makePlusMenuButton(title: String, systemImage: String) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: systemImage)
        configuration.imagePadding = 10
        configuration.title = title
        configuration.baseForegroundColor = .label
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8)

        let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in
            self?.setPlusMenuVisible(false, animated: true)
            self?.focus()
        })
        button.contentHorizontalAlignment = .leading
        return button
    }

    private func configureTextView() {
        textView.delegate = self
        textView.backgroundColor = .clear
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = .label
        textView.tintColor = .label
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 7, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = false
        textView.autocorrectionType = .yes
        textView.autocapitalizationType = .sentences
        textView.spellCheckingType = .yes
        textView.smartDashesType = .yes
        textView.smartQuotesType = .yes
        textView.keyboardDismissMode = .none
        textView.accessibilityLabel = "Message"

        placeholderLabel.text = "Message"
        placeholderLabel.font = UIFont.preferredFont(forTextStyle: .body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = UIColor.secondaryLabel.withAlphaComponent(0.42)
        placeholderLabel.isUserInteractionEnabled = false
    }

    private func configureButtons() {
        plusButton.setImage(UIImage(systemName: "plus"), for: .normal)
        plusButton.tintColor = .secondaryLabel
        plusButton.addTarget(self, action: #selector(togglePlusMenu), for: .touchUpInside)
        plusButton.accessibilityLabel = "Add"

        voiceButton.setImage(UIImage(systemName: "waveform"), for: .normal)
        voiceButton.tintColor = .secondaryLabel
        voiceButton.accessibilityLabel = "Voice"

        var sendConfiguration = UIButton.Configuration.filled()
        sendConfiguration.cornerStyle = .capsule
        sendConfiguration.image = UIImage(systemName: "arrow.up")
        sendButton.configuration = sendConfiguration
        sendButton.configurationUpdateHandler = { [weak self] button in
            guard let self else { return }
            var configuration = button.configuration ?? .filled()
            let canSend = self.hasSendText && !self.sendBlocked
            let active = self.generating || canSend
            configuration.image = UIImage(
                systemName: self.generating ? "stop.fill" : "arrow.up"
            )
            configuration.baseBackgroundColor = active
                ? .label
                : UIColor.secondaryLabel.withAlphaComponent(0.08)
            configuration.baseForegroundColor = active
                ? .systemBackground
                : UIColor.secondaryLabel.withAlphaComponent(0.38)
            button.configuration = configuration
            button.isEnabled = active
            button.accessibilityLabel = self.generating ? "停止生成" : "发送"
        }
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        sendProgressView.hidesWhenStopped = true
        sendProgressView.isUserInteractionEnabled = false
        sendProgressView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            sendProgressView.centerXAnchor.constraint(equalTo: sendButton.centerXAnchor),
            sendProgressView.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
        ])
    }

    func setSendBlocked(_ blocked: Bool) {
        guard sendBlocked != blocked else { return }
        sendBlocked = blocked
        updateButtonState(hasText: !trimmedText.isEmpty, animated: false)
    }

    func setGenerating(_ generating: Bool) {
        guard self.generating != generating else { return }
        self.generating = generating
        updateButtonState(hasText: !trimmedText.isEmpty, animated: true)
    }

    func setEditingMessage(_ active: Bool) {
        guard editingMessage != active else { return }
        editingMessage = active
        editStatusView.isHidden = !active
        setPlusMenuVisible(false, animated: false)
        updateLayout(animated: true)
    }

    @objc private func sendTapped() {
        if generating {
            onStop?()
            return
        }
        if textView.markedTextRange != nil {
            textView.unmarkText()
        }
        let submittedText = trimmedText
        composerDebugLog("send tapped length=\(submittedText.utf16.count)")
        guard !sendBlocked, !submittedText.isEmpty else {
            return
        }

        setPlusMenuVisible(false, animated: true)
        textView.text = ""
        textView.selectedRange = NSRange(location: 0, length: 0)
        updateLayout(animated: true)
        onTextChange?("")
        onSelectionChange?(textView.selectedRange)
        onSend?(submittedText)
    }

    @objc private func togglePlusMenu() {
        focus()
        setPlusMenuVisible(!plusMenuVisible, animated: true)
    }

    private func setPlusMenuVisible(_ visible: Bool, animated: Bool) {
        guard visible != plusMenuVisible else {
            return
        }

        plusMenuVisible = visible
        if visible {
            plusMenuView.isHidden = false
            plusMenuView.alpha = 0
            plusMenuView.transform = hiddenPlusMenuTransform
            UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.55)
        }

        let updates = {
            self.plusMenuView.alpha = visible ? 1 : 0
            self.plusMenuView.transform = visible
                ? .identity
                : self.hiddenPlusMenuTransform
        }

        let completion: (Bool) -> Void = { _ in
            if !visible {
                self.plusMenuView.isHidden = true
            }
        }

        if animated && visible {
            UIView.animate(
                withDuration: 0.34,
                delay: 0,
                usingSpringWithDamping: 0.66,
                initialSpringVelocity: 0.38,
                options: [.beginFromCurrentState, .allowUserInteraction],
                animations: updates,
                completion: completion
            )
        } else if animated {
            UIView.animate(
                withDuration: 0.14,
                delay: 0,
                options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction],
                animations: updates,
                completion: completion
            )
        } else {
            updates()
            completion(true)
        }
    }

    private func updateLayout(animated: Bool) {
        guard bounds.width > 0 else {
            return
        }

        placeholderLabel.isHidden = !textView.text.isEmpty
        let hasText = !trimmedText.isEmpty
        let compactMeasuredHeight = measuredTextHeight(
            width: compactTextWidth(hasText: hasText)
        )
        let shouldExpand = ComposerLayoutPolicy.shouldExpand(
            hasText: hasText,
            containsExplicitLineBreak: textView.text.contains("\n"),
            hasMarkedText: textView.markedTextRange != nil,
            compactMeasuredHeight: compactMeasuredHeight,
            compactTextHeight: compactTextHeight,
            editingMessage: editingMessage,
            wasExpanded: expanded
        )
        let expandedMeasuredHeight = shouldExpand
            ? measuredTextHeight(width: expandedTextWidth)
            : compactMeasuredHeight
        let targetTextHeight = shouldExpand
            ? min(max(expandedMeasuredHeight, compactTextHeight), maximumTextHeight)
            : compactTextHeight
        let baseHeight = editing ? Self.editingCompactHeight : Self.restingHeight
        let editStatusHeight: CGFloat = editingMessage ? 34 : 0
        let targetHeight = shouldExpand
            ? max(Self.editingCompactHeight, targetTextHeight + 66 + editStatusHeight)
            : baseHeight
        let isCollapsing = expanded && !shouldExpand

        expandedTextTopConstraint?.constant = editingMessage ? 42 : 10

        if expanded != shouldExpand {
            expanded = shouldExpand
            NSLayoutConstraint.deactivate(shouldExpand ? compactConstraints : expandedConstraints)
            NSLayoutConstraint.activate(shouldExpand ? expandedConstraints : compactConstraints)
        }

        textView.isScrollEnabled = shouldExpand && expandedMeasuredHeight > maximumTextHeight + 1
        textHeightConstraint?.constant = targetTextHeight
        updateButtonState(hasText: hasText, animated: animated)

        let finishLayout = {
            guard isCollapsing else { return }
            self.textView.layoutIfNeeded()
            self.textView.setContentOffset(.zero, animated: false)
            self.textView.scrollRangeToVisible(self.textView.selectedRange)
        }

        if animated {
            UIView.animate(
                withDuration: 0.24,
                delay: 0,
                usingSpringWithDamping: 0.88,
                initialSpringVelocity: 0.14,
                options: [.beginFromCurrentState, .allowUserInteraction]
            ) {
                self.reportHeight(targetHeight)
                self.layoutIfNeeded()
                self.superview?.layoutIfNeeded()
            } completion: { _ in
                finishLayout()
            }
        } else {
            reportHeight(targetHeight)
            layoutIfNeeded()
            superview?.layoutIfNeeded()
            finishLayout()
        }
    }

    private func updateButtonState(hasText: Bool, animated: Bool) {
        let update = {
            self.hasSendText = hasText
            self.voiceButton.alpha = hasText ? 0 : 1
            self.voiceWidthConstraint?.constant = hasText ? 0 : 32
            self.sendProgressView.stopAnimating()
            self.sendButton.setNeedsUpdateConfiguration()
        }

        if animated {
            UIView.animate(
                withDuration: 0.2,
                delay: 0,
                options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction],
                animations: update
            )
        } else {
            update()
        }
    }

    private func reportHeight(_ height: CGFloat) {
        guard abs(lastReportedHeight - height) > 0.5 else {
            return
        }

        lastReportedHeight = height
        onHeightChange?(height)
    }

    private func measuredTextHeight(width: CGFloat) -> CGFloat {
        let fittingWidth = max(width, 80)
        let size = textView.sizeThatFits(CGSize(width: fittingWidth, height: CGFloat.greatestFiniteMagnitude))
        return ceil(size.height)
    }

    private func compactTextWidth(hasText: Bool) -> CGFloat {
        let voiceWidth: CGFloat = hasText ? 0 : 32
        return bounds.width - 16 - 34 - 8 - 6 - voiceWidth - 8 - 42 - 12
    }

    private var expandedTextWidth: CGFloat {
        bounds.width - 40
    }

    private var compactTextHeight: CGFloat {
        42
    }

    private var maximumTextHeight: CGFloat {
        let lineHeight = textView.font?.lineHeight ?? 22
        return ceil((lineHeight * 8) + textView.textContainerInset.top + textView.textContainerInset.bottom)
    }

    private var trimmedText: String {
        textView.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func clampedRange(_ range: NSRange) -> NSRange {
        let textLength = (textView.text as NSString?)?.length ?? 0
        let location = range.location == NSNotFound
            ? textLength
            : min(max(range.location, 0), textLength)
        let length = min(max(range.length, 0), max(textLength - location, 0))

        return NSRange(location: location, length: length)
    }

    private var hiddenPlusMenuTransform: CGAffineTransform {
        CGAffineTransform(translationX: -6, y: 14).scaledBy(x: 0.82, y: 0.82)
    }
}

struct ConversationHomeView_Previews: PreviewProvider {
    static var previews: some View {
        let dependencies = AppDependencies.preview()
        ConversationHomeView(workspaceCenter: dependencies.workspaceCenter)
            .environment(dependencies)
    }
}
