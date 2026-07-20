import SwiftUI
import XCTest
@testable import Athena

final class ConversationPerformanceTests: XCTestCase {
    func testComposerBottomClearanceKeepsTwelvePointSpacingAboveComposer() {
        XCTAssertEqual(
            ComposerLayoutPolicy.bottomContentClearance(
                composerHeight: 52,
                bottomGap: 6
            ),
            70
        )
        XCTAssertEqual(
            ComposerLayoutPolicy.bottomContentClearance(
                composerHeight: 58,
                bottomGap: 8
            ),
            78
        )
    }

    func testComposerBottomClearanceCannotGrowWithKeyboardDistance() {
        XCTAssertEqual(
            ComposerLayoutPolicy.bottomContentClearance(
                composerHeight: 58,
                bottomGap: 8
            ),
            78
        )
    }

    func testConversationReturnsToRootOnlyAfterKeyboardGuideReachesBottom() {
        XCTAssertFalse(
            ConversationKeyboardLayoutPolicy.keyboardIsFullyDismissed(
                keyboardTop: 510,
                viewportBottom: 844
            )
        )
        XCTAssertTrue(
            ConversationKeyboardLayoutPolicy.keyboardIsFullyDismissed(
                keyboardTop: 843.5,
                viewportBottom: 844
            )
        )
    }

    func testComposerDoesNotCollapseUntilTextFitsCompactWidth() {
        XCTAssertTrue(
            ComposerLayoutPolicy.shouldExpand(
                hasText: true,
                containsExplicitLineBreak: false,
                hasMarkedText: false,
                compactMeasuredHeight: 64,
                compactTextHeight: 42,
                editingMessage: false,
                wasExpanded: true
            )
        )
        XCTAssertFalse(
            ComposerLayoutPolicy.shouldExpand(
                hasText: true,
                containsExplicitLineBreak: false,
                hasMarkedText: false,
                compactMeasuredHeight: 42,
                compactTextHeight: 42,
                editingMessage: false,
                wasExpanded: true
            )
        )
    }

    func testComposerKeepsExpandedLayoutDuringMarkedTextComposition() {
        XCTAssertTrue(
            ComposerLayoutPolicy.shouldExpand(
                hasText: true,
                containsExplicitLineBreak: false,
                hasMarkedText: true,
                compactMeasuredHeight: 40,
                compactTextHeight: 42,
                editingMessage: false,
                wasExpanded: true
            )
        )
        XCTAssertFalse(
            ComposerLayoutPolicy.shouldExpand(
                hasText: false,
                containsExplicitLineBreak: true,
                hasMarkedText: false,
                compactMeasuredHeight: 64,
                compactTextHeight: 42,
                editingMessage: false,
                wasExpanded: true
            )
        )
    }

    func testMarkdownRenderCacheDeduplicatesConcurrentParsing() async {
        let cache = MarkdownRenderCache(capacity: 4)
        let source = """
        ## 标题

        - 第一项
        - 第二项
        """

        async let first = cache.blocks(for: "message-1", source: source)
        async let second = cache.blocks(for: "message-1", source: source)
        let results = await [first, second]

        XCTAssertEqual(results[0].count, results[1].count)
        XCTAssertEqual(cache.statistics().parseCount, 1)
        XCTAssertEqual(cache.statistics().entryCount, 1)
    }

    func testMarkdownRenderCacheInvalidatesWhenTextChanges() async {
        let cache = MarkdownRenderCache(capacity: 4)

        _ = await cache.blocks(for: "message-1", source: "第一版")
        _ = await cache.blocks(for: "message-1", source: "第二版")

        XCTAssertEqual(cache.statistics().parseCount, 2)
        XCTAssertNotNil(cache.cachedBlocks(for: "message-1", source: "第二版"))
        XCTAssertNil(cache.cachedBlocks(for: "message-1", source: "第一版"))
    }

    @MainActor
    func testChatStreamDisplayBufferCoalescesTextBeforeFinalEvent() {
        var events: [ChatStreamEvent] = []
        let buffer = ChatStreamDisplayBuffer(interval: .seconds(10)) {
            events.append($0)
        }

        buffer.submit(
            .assistantText(id: "assistant", text: "Ath", replaces: true, closes: false)
        )
        buffer.submit(
            .assistantText(id: "assistant", text: "ena", replaces: false, closes: false)
        )
        buffer.submit(
            .finalized(chatID: 7, publicChatID: "public-7", clientTurnID: "turn-7")
        )

        XCTAssertEqual(
            events,
            [
                .assistantText(
                    id: "assistant",
                    text: "Athena",
                    replaces: true,
                    closes: false
                ),
                .finalized(
                    chatID: 7,
                    publicChatID: "public-7",
                    clientTurnID: "turn-7"
                ),
            ]
        )
    }

    @MainActor
    func testChatStreamDisplayBufferUsesInteractionCadenceWithoutLosingFinalText() async {
        var events: [ChatStreamEvent] = []
        let buffer = ChatStreamDisplayBuffer(
            interval: .milliseconds(5),
            interactionInterval: .milliseconds(80)
        ) {
            events.append($0)
        }
        buffer.setInteractionActive(true)

        for index in 0..<500 {
            buffer.submit(
                .assistantText(
                    id: "assistant",
                    text: "\(index),",
                    replaces: index == 0,
                    closes: false
                )
            )
        }

        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(events.isEmpty)

        buffer.submit(
            .finalized(chatID: 8, publicChatID: "public-8", clientTurnID: "turn-8")
        )

        XCTAssertEqual(events.count, 2)
        guard case .assistantText(_, let text, _, _) = events[0] else {
            return XCTFail("Expected a coalesced assistant text event.")
        }
        XCTAssertTrue(text.hasPrefix("0,1,2,"))
        XCTAssertTrue(text.hasSuffix("499,"))
        XCTAssertEqual(
            events[1],
            .finalized(chatID: 8, publicChatID: "public-8", clientTurnID: "turn-8")
        )
    }

    func testCacheCodecRoundTripsOffMainActorBoundary() async throws {
        struct Payload: Codable, Equatable, Sendable {
            let id: Int
            let title: String
        }

        let codec = CacheCodec()
        let expected = Payload(id: 17, title: "Athena")
        let data = try await codec.encode(expected)
        let decoded = try await codec.decode(Payload.self, from: data)

        XCTAssertEqual(decoded, expected)
    }

    @MainActor
    func testTimelineStoreKeepsStableIdentityAcrossContentUpdates() {
        let store = ConversationTimelineStore(content: Text("0"))
        let identity = ObjectIdentifier(store)

        for index in 1...500 {
            store.update(content: Text("\(index)"))
        }

        XCTAssertEqual(ObjectIdentifier(store), identity)
        XCTAssertEqual(store.revision, 500)
    }

    @MainActor
    func testMessageRenderStoreKeepsStableIdentityDuringStreamingUpdates() {
        let initial = AthenaChatMessage(
            id: "assistant-stream",
            role: .assistant,
            text: "A",
            deliveryState: .streaming
        )
        let store = ConversationMessageRenderStore(
            message: initial,
            isLastConfirmedAssistant: false
        )
        let identity = ObjectIdentifier(store)

        for index in 1...500 {
            store.update(
                message: AthenaChatMessage(
                    id: initial.id,
                    role: .assistant,
                    text: String(repeating: "A", count: index),
                    deliveryState: .streaming
                ),
                isLastConfirmedAssistant: false
            )
        }

        XCTAssertEqual(ObjectIdentifier(store), identity)
        XCTAssertEqual(store.message.text.count, 500)
        XCTAssertEqual(store.role, .assistant)
    }

    @MainActor
    func testAgentSessionRenderStoreKeepsStableIdentityDuringStreamingUpdates() {
        let initial = AgentSessionSnapshot(
            invocationID: "invocation-1",
            workspaceID: "workspace-1",
            threadID: "thread-1",
            clientTurnID: "turn-1",
            phase: .open,
            lastEventSequence: 0,
            retryCount: 0,
            assistantText: "",
            finalChatID: nil,
            finalPublicChatID: nil,
            events: [],
            updatedAt: Date(timeIntervalSince1970: 1)
        )
        let store = AgentSessionRenderStore(session: initial)
        let identity = ObjectIdentifier(store)

        for index in 1...500 {
            store.update(
                session: AgentSessionSnapshot(
                    invocationID: initial.invocationID,
                    workspaceID: initial.workspaceID,
                    threadID: initial.threadID,
                    clientTurnID: initial.clientTurnID,
                    phase: .open,
                    lastEventSequence: index,
                    retryCount: 0,
                    assistantText: String(repeating: "A", count: index),
                    finalChatID: nil,
                    finalPublicChatID: nil,
                    events: [],
                    updatedAt: Date(timeIntervalSince1970: TimeInterval(index + 1))
                )
            )
        }

        XCTAssertEqual(ObjectIdentifier(store), identity)
        XCTAssertEqual(store.assistantText.count, 500)
        XCTAssertEqual(store.lastEventSequence, 500)
        XCTAssertTrue(store.hasAssistantContent)
        XCTAssertEqual(store.phase, .open)
    }

    @MainActor
    func testAgentStreamingDoesNotChangeConversationSessionRevision() {
        let kit = AgentControlKit(events: [])
        kit.sessions = [
            AgentSessionSnapshot(
                invocationID: "invocation-1",
                workspaceID: "workspace-1",
                threadID: "thread-1",
                clientTurnID: "turn-1",
                phase: .open,
                lastEventSequence: 0,
                retryCount: 0,
                assistantText: "",
                finalChatID: nil,
                finalPublicChatID: nil,
                events: [],
                updatedAt: Date(timeIntervalSince1970: 1)
            ),
        ]
        let revision = kit.sessionListRevision
        guard let store = kit.sessionRenderStore(for: "thread-1") else {
            return XCTFail("Expected an Agent render store.")
        }
        let identity = ObjectIdentifier(store)

        for index in 1...500 {
            kit.sessions[0].assistantText = String(repeating: "A", count: index)
            kit.sessions[0].lastEventSequence = index
            kit.sessions[0].updatedAt = Date(
                timeIntervalSince1970: TimeInterval(index + 1)
            )
        }

        XCTAssertEqual(kit.sessionListRevision, revision)
        XCTAssertEqual(
            ObjectIdentifier(kit.sessionRenderStore(for: "thread-1")!),
            identity
        )
        XCTAssertEqual(store.assistantText.count, 500)
    }

    @MainActor
    func testWorkspaceNavigationMetadataDoesNotRetainMessageBodies() {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let scheduler = TaskScheduler()
        let message = AthenaChatMessage(
            id: "message-1",
            role: .assistant,
            text: "A long response that must stay outside drawer metadata."
        )
        let thread = AthenaThread(
            id: "thread-1",
            workspaceID: "workspace-1",
            title: "Thread",
            messages: [message]
        )
        let center = WorkspaceCenter(
            api: nil,
            apiClient: nil,
            taskScheduler: scheduler,
            optimisticActionCenter: NativeOptimisticActionCenter(),
            recoveryCenter: NativeRecoveryCenter(),
            serverStateCache: ServerStateCache(
                scheduler: scheduler,
                secureStore: InMemorySecureValueStore(),
                persistentRootURL: cacheRoot
            ),
            localCache: LocalCache(rootURL: cacheRoot),
            userStateSyncClient: UserStateSyncClient(),
            source: .preview,
            workspaces: [
                AthenaWorkspace(
                    id: "workspace-1",
                    title: "Workspace",
                    threads: [thread]
                ),
            ],
            selectedThreadID: "thread-1"
        )

        XCTAssertTrue(center.workspaces[0].threads[0].messages.isEmpty)
        XCTAssertEqual(center.messages(for: "thread-1"), [message])
        XCTAssertTrue(center.containsMessage("message-1", in: "thread-1"))
        XCTAssertEqual(
            center.messageRenderStoresForDisplay(in: "thread-1").map(\.id),
            ["message-1"]
        )
        XCTAssertEqual(
            center.message(withID: "message-1", in: "thread-1"),
            message
        )
    }
}
