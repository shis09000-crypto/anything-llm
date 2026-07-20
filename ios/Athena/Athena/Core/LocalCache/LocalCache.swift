import CryptoKit
import Foundation
import Observation

@MainActor
@Observable
final class LocalCache {
    enum Mode: Equatable {
        case metadataOnly
    }

    private let fileManager: FileManager
    private let rootURL: URL
    private let agentDescriptorRetention: TimeInterval = 14 * 24 * 60 * 60
    private let maximumAgentDescriptors = 24

    var mode: Mode = .metadataOnly
    var cachedWorkspaceCount = 0
    var cachedDocumentCount = 0

    init(
        fileManager: FileManager = .default,
        rootURL: URL? = nil
    ) {
        self.fileManager = fileManager
        let applicationSupport = rootURL ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        self.rootURL = applicationSupport
            .appendingPathComponent("Athena", isDirectory: true)
            .appendingPathComponent("AuthenticatedMetadata", isDirectory: true)
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        mode = .metadataOnly
    }

    func loadWorkspaceSnapshot(
        ownerScope: String,
        apiBase: URL
    ) -> WorkspaceMetadataSnapshot? {
        let url = snapshotURL(ownerScope: ownerScope, apiBase: apiBase)
        guard let data = try? Data(contentsOf: url) else {
            return nil
        }
        let snapshot = try? JSONDecoder().decode(WorkspaceMetadataSnapshot.self, from: data)
        cachedWorkspaceCount = snapshot?.workspaces.count ?? 0
        return snapshot
    }

    func loadWorkspaceSnapshotAsync(
        ownerScope: String,
        apiBase: URL
    ) async -> WorkspaceMetadataSnapshot? {
        let url = snapshotURL(ownerScope: ownerScope, apiBase: apiBase)
        let snapshot = await Task.detached(priority: .userInitiated) { () -> WorkspaceMetadataSnapshot? in
            guard let data = try? Data(contentsOf: url) else {
                return nil
            }
            return try? JSONDecoder().decode(WorkspaceMetadataSnapshot.self, from: data)
        }.value
        cachedWorkspaceCount = snapshot?.workspaces.count ?? 0
        return snapshot
    }

    func saveWorkspaceSnapshot(
        _ snapshot: WorkspaceMetadataSnapshot,
        ownerScope: String,
        apiBase: URL
    ) throws {
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let data = try JSONEncoder().encode(snapshot)
        let url = snapshotURL(ownerScope: ownerScope, apiBase: apiBase)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        cachedWorkspaceCount = snapshot.workspaces.count
    }

    func saveWorkspaceSnapshotAsync(
        _ snapshot: WorkspaceMetadataSnapshot,
        ownerScope: String,
        apiBase: URL
    ) async throws {
        let rootURL = self.rootURL
        let url = snapshotURL(ownerScope: ownerScope, apiBase: apiBase)
        try await Task.detached(priority: .utility) {
            try FileManager.default.createDirectory(
                at: rootURL,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
        }.value
        cachedWorkspaceCount = snapshot.workspaces.count
    }

    func clearWorkspaceSnapshot(ownerScope: String, apiBase: URL) {
        let url = snapshotURL(ownerScope: ownerScope, apiBase: apiBase)
        try? fileManager.removeItem(at: url)
        cachedWorkspaceCount = 0
    }

    func loadConversationViewport(
        ownerScope: String,
        apiBase: URL
    ) -> LocalConversationViewportSnapshot? {
        let url = conversationViewportURL(ownerScope: ownerScope, apiBase: apiBase)
        guard let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(
                  LocalConversationViewportSnapshot.self,
                  from: data
              ),
              snapshot.schemaVersion == LocalConversationViewportSnapshot.currentSchemaVersion else {
            return nil
        }
        return snapshot
    }

    func loadConversationViewportAsync(
        ownerScope: String,
        apiBase: URL
    ) async -> LocalConversationViewportSnapshot? {
        let url = conversationViewportURL(ownerScope: ownerScope, apiBase: apiBase)
        return await Task.detached(priority: .userInitiated) { () -> LocalConversationViewportSnapshot? in
            guard let data = try? Data(contentsOf: url),
                  let snapshot = try? JSONDecoder().decode(
                      LocalConversationViewportSnapshot.self,
                      from: data
                  ),
                  snapshot.schemaVersion == LocalConversationViewportSnapshot.currentSchemaVersion else {
                return nil
            }
            return snapshot
        }.value
    }

    func saveConversationViewport(
        _ snapshot: LocalConversationViewportSnapshot,
        ownerScope: String,
        apiBase: URL
    ) throws {
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let data = try JSONEncoder().encode(snapshot)
        try data.write(
            to: conversationViewportURL(ownerScope: ownerScope, apiBase: apiBase),
            options: [.atomic, .completeFileProtection]
        )
    }

    func clearConversationViewport(ownerScope: String, apiBase: URL) {
        try? fileManager.removeItem(
            at: conversationViewportURL(ownerScope: ownerScope, apiBase: apiBase)
        )
    }

    func loadAccountSettingsPreferences(
        ownerScope: String,
        apiBase: URL
    ) -> AccountSettingsPreferences? {
        let url = accountSettingsURL(ownerScope: ownerScope, apiBase: apiBase)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(AccountSettingsPreferences.self, from: data)
    }

    func saveAccountSettingsPreferences(
        _ preferences: AccountSettingsPreferences,
        ownerScope: String,
        apiBase: URL
    ) throws {
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let data = try JSONEncoder().encode(preferences)
        try data.write(
            to: accountSettingsURL(ownerScope: ownerScope, apiBase: apiBase),
            options: [.atomic, .completeFileProtection]
        )
    }

    func clearAccountSettingsPreferences(ownerScope: String, apiBase: URL) {
        try? fileManager.removeItem(
            at: accountSettingsURL(ownerScope: ownerScope, apiBase: apiBase)
        )
    }

    func clearAllWorkspaceSnapshots() {
        try? fileManager.removeItem(at: rootURL)
        cachedWorkspaceCount = 0
    }

    func loadAgentSessionDescriptors(
        ownerScope: String,
        apiBase: URL
    ) -> [PersistedAgentSessionDescriptor] {
        let url = agentSessionsURL(ownerScope: ownerScope, apiBase: apiBase)
        guard let data = try? Data(contentsOf: url) else {
            return []
        }
        let decoder = JSONDecoder()
        let sessions: [PersistedAgentSessionDescriptor]
        if let envelope = try? decoder.decode(PersistedAgentSessionEnvelope.self, from: data),
           envelope.schemaVersion == PersistedAgentSessionEnvelope.currentSchemaVersion
        {
            sessions = envelope.sessions
        } else {
            // Compatibility with the first native prototype's array-only format.
            sessions = (try? decoder.decode([PersistedAgentSessionDescriptor].self, from: data)) ?? []
        }
        let cutoff = Date().addingTimeInterval(-agentDescriptorRetention)
        return sessions
            .filter { $0.updatedAt >= cutoff }
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(maximumAgentDescriptors)
            .map { $0 }
    }

    func saveAgentSessionDescriptors(
        _ sessions: [PersistedAgentSessionDescriptor],
        ownerScope: String,
        apiBase: URL
    ) throws {
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let retainedSessions = sessions
            .sorted { $0.updatedAt > $1.updatedAt }
            .prefix(maximumAgentDescriptors)
            .map { $0 }
        let data = try JSONEncoder().encode(
            PersistedAgentSessionEnvelope(sessions: retainedSessions)
        )
        try data.write(
            to: agentSessionsURL(ownerScope: ownerScope, apiBase: apiBase),
            options: [.atomic, .completeFileProtection]
        )
    }

    func clearAgentSessionDescriptors(ownerScope: String, apiBase: URL) {
        try? fileManager.removeItem(at: agentSessionsURL(ownerScope: ownerScope, apiBase: apiBase))
    }

    private func snapshotURL(ownerScope: String, apiBase: URL) -> URL {
        let digest = ownerDigest(ownerScope: ownerScope, apiBase: apiBase)
        return rootURL.appendingPathComponent("workspace-\(digest).json")
    }

    private func agentSessionsURL(ownerScope: String, apiBase: URL) -> URL {
        let digest = ownerDigest(ownerScope: ownerScope, apiBase: apiBase)
        return rootURL.appendingPathComponent("agent-sessions-\(digest).json")
    }

    private func conversationViewportURL(ownerScope: String, apiBase: URL) -> URL {
        let digest = ownerDigest(ownerScope: ownerScope, apiBase: apiBase)
        return rootURL.appendingPathComponent("conversation-viewport-\(digest).json")
    }

    private func accountSettingsURL(ownerScope: String, apiBase: URL) -> URL {
        let digest = ownerDigest(ownerScope: ownerScope, apiBase: apiBase)
        return rootURL.appendingPathComponent("account-settings-\(digest).json")
    }

    private func ownerDigest(ownerScope: String, apiBase: URL) -> String {
        let identity = "\(apiBase.absoluteString)|\(ownerScope)"
        return SHA256.hash(data: Data(identity.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
