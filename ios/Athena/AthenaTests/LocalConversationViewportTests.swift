import Foundation
import XCTest
@testable import Athena

@MainActor
final class LocalConversationViewportTests: XCTestCase {
    func testViewportRoundTripIsPartitionedByOwnerAndAPIBase() throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }
        let cache = LocalCache(rootURL: rootURL)
        let primaryBase = URL(string: "https://athena.example")!
        let otherBase = URL(string: "https://other.example")!
        let snapshot = LocalConversationViewportSnapshot(
            workspaceID: "workspace-a",
            threadID: "thread-a",
            messageID: "thread-a:42:assistant",
            chatID: 42,
            contentOffsetY: 384,
            viewportWidth: 393,
            historyRevision: 8,
            isAtBottom: false
        )

        try cache.saveConversationViewport(
            snapshot,
            ownerScope: "owner-a",
            apiBase: primaryBase
        )

        XCTAssertEqual(
            cache.loadConversationViewport(ownerScope: "owner-a", apiBase: primaryBase),
            snapshot
        )
        XCTAssertNil(
            cache.loadConversationViewport(ownerScope: "owner-b", apiBase: primaryBase)
        )
        XCTAssertNil(
            cache.loadConversationViewport(ownerScope: "owner-a", apiBase: otherBase)
        )
    }

    func testClearingViewportDoesNotClearWorkspaceMetadata() throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }
        let cache = LocalCache(rootURL: rootURL)
        let apiBase = URL(string: "https://athena.example")!
        let viewport = LocalConversationViewportSnapshot(
            workspaceID: "workspace-a",
            threadID: "thread-a",
            messageID: nil,
            chatID: nil,
            contentOffsetY: 0,
            viewportWidth: 393,
            historyRevision: 0,
            isAtBottom: true
        )
        let workspace = AthenaWorkspace(id: "workspace-a", title: "Workspace")
        let metadata = WorkspaceMetadataSnapshot(
            workspaces: [workspace],
            selectedWorkspaceID: workspace.id,
            selectedThreadID: "thread-a",
            savedAt: Date()
        )

        try cache.saveConversationViewport(viewport, ownerScope: "owner-a", apiBase: apiBase)
        try cache.saveWorkspaceSnapshot(metadata, ownerScope: "owner-a", apiBase: apiBase)
        cache.clearConversationViewport(ownerScope: "owner-a", apiBase: apiBase)

        XCTAssertNil(cache.loadConversationViewport(ownerScope: "owner-a", apiBase: apiBase))
        XCTAssertEqual(
            cache.loadWorkspaceSnapshot(ownerScope: "owner-a", apiBase: apiBase),
            metadata
        )
    }

    func testWorkspaceSnapshotAsyncRoundTrip() async throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }
        let cache = LocalCache(rootURL: rootURL)
        let apiBase = URL(string: "https://athena.example")!
        let metadata = WorkspaceMetadataSnapshot(
            workspaces: [
                AthenaWorkspace(id: "workspace-a", title: "Workspace"),
            ],
            selectedWorkspaceID: "workspace-a",
            selectedThreadID: "thread-a",
            savedAt: Date()
        )

        try await cache.saveWorkspaceSnapshotAsync(
            metadata,
            ownerScope: "owner-a",
            apiBase: apiBase
        )

        let restored = await cache.loadWorkspaceSnapshotAsync(
            ownerScope: "owner-a",
            apiBase: apiBase
        )
        XCTAssertEqual(restored, metadata)
    }
}
