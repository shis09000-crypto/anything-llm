import CryptoKit
import Foundation

enum ServerStatePersistence: Equatable, Sendable {
    case memoryOnly
    case metadata
    case recentThreadHistory(threadID: String)
    case historyPage(threadID: String)

    fileprivate var kind: PersistedServerStateEntry.Kind? {
        switch self {
        case .memoryOnly:
            nil
        case .metadata:
            .metadata
        case .recentThreadHistory:
            .recentThreadHistory
        case .historyPage:
            .historyPage
        }
    }

    fileprivate var threadID: String? {
        switch self {
        case .recentThreadHistory(let threadID), .historyPage(let threadID):
            threadID
        case .memoryOnly, .metadata:
            nil
        }
    }
}

struct ServerStateCachePolicy: Equatable, Sendable {
    let freshFor: TimeInterval
    let retainFor: TimeInterval
    let persistence: ServerStatePersistence

    static let memoryOnly = ServerStateCachePolicy(
        freshFor: 30,
        retainFor: 30,
        persistence: .memoryOnly
    )

    static let recentNavigation = ServerStateCachePolicy(
        freshFor: 60,
        retainFor: 180 * 24 * 60 * 60,
        persistence: .metadata
    )

    static let workspaceList = ServerStateCachePolicy(
        freshFor: 15 * 24 * 60 * 60,
        retainFor: 180 * 24 * 60 * 60,
        persistence: .metadata
    )

    static let threadList = ServerStateCachePolicy(
        freshFor: 15 * 24 * 60 * 60,
        retainFor: 180 * 24 * 60 * 60,
        persistence: .metadata
    )

    static let accountProfile = ServerStateCachePolicy(
        freshFor: 180 * 24 * 60 * 60,
        retainFor: 180 * 24 * 60 * 60,
        persistence: .metadata
    )

    static let longTermMemory = ServerStateCachePolicy(
        freshFor: 15 * 60,
        retainFor: 30 * 24 * 60 * 60,
        persistence: .metadata
    )

    static let providerCatalog = ServerStateCachePolicy(
        freshFor: 30 * 24 * 60 * 60,
        retainFor: 30 * 24 * 60 * 60,
        persistence: .metadata
    )

    static let providerConfiguration = ServerStateCachePolicy(
        freshFor: 15 * 60,
        retainFor: 24 * 60 * 60,
        persistence: .metadata
    )

    static func latestThreadHistory(threadID: String) -> ServerStateCachePolicy {
        ServerStateCachePolicy(
            freshFor: 30,
            retainFor: 30 * 24 * 60 * 60,
            persistence: .recentThreadHistory(threadID: threadID)
        )
    }

    static func olderHistoryPage(threadID: String) -> ServerStateCachePolicy {
        ServerStateCachePolicy(
            freshFor: 10 * 60,
            retainFor: 12 * 60 * 60,
            persistence: .historyPage(threadID: threadID)
        )
    }
}

struct PersistedServerStateRecord: Sendable {
    let data: Data
    let freshUntil: Date
    let retainUntil: Date
    let scope: AthenaTaskScope

    var isFresh: Bool {
        freshUntil > Date()
    }
}

struct PersistentServerStateMetrics: Equatable, Sendable {
    let entryCount: Int
    let byteCount: Int
    let archiveWriteCount: Int
}

struct PersistentServerStateWrite: Sendable {
    let data: Data
    let key: String
    let policy: ServerStateCachePolicy
    let scope: AthenaTaskScope
}

private struct PersistedServerStateArchive: Codable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    var entries: [String: PersistedServerStateEntry]
}

fileprivate struct PersistedServerStateEntry: Codable {
    enum Kind: String, Codable {
        case metadata
        case recentThreadHistory
        case historyPage
    }

    let key: String
    var data: Data
    var freshUntil: Date
    var retainUntil: Date
    var lastAccessedAt: Date
    let kind: Kind
    let threadID: String?
    let scope: AthenaTaskScope
}

actor PersistentServerStateStore {
    static let defaultMaximumBytes = 64 * 1_024 * 1_024
    static let defaultMaximumRecentThreads = 30

    private let fileManager: FileManager
    private let secureStore: SecureValueStore
    private let rootURL: URL
    private let maximumBytes: Int
    private let maximumRecentThreads: Int
    private var loadedArchives: [String: PersistedServerStateArchive] = [:]
    private var accessPersistenceTasks: [String: Task<Void, Never>] = [:]
    private var archiveWriteCount = 0

    init(
        secureStore: SecureValueStore,
        fileManager: FileManager = .default,
        rootURL: URL? = nil,
        maximumBytes: Int = PersistentServerStateStore.defaultMaximumBytes,
        maximumRecentThreads: Int = PersistentServerStateStore.defaultMaximumRecentThreads
    ) {
        self.secureStore = secureStore
        self.fileManager = fileManager
        let applicationSupport = rootURL ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
        self.rootURL = applicationSupport
            .appendingPathComponent("Athena", isDirectory: true)
            .appendingPathComponent("AuthenticatedServerState", isDirectory: true)
        self.maximumBytes = maximumBytes
        self.maximumRecentThreads = maximumRecentThreads
    }

    func record(
        key: String,
        ownerScope: String,
        apiBase: URL
    ) throws -> PersistedServerStateRecord? {
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        var archive = try loadArchive(partition: partition)
        let now = Date()
        let removedExpired = removeExpiredEntries(from: &archive, now: now)
        guard var entry = archive.entries[key] else {
            if removedExpired {
                try saveArchive(archive, partition: partition)
            }
            return nil
        }
        guard entry.retainUntil > now else {
            archive.entries.removeValue(forKey: key)
            try saveArchive(archive, partition: partition)
            return nil
        }
        entry.lastAccessedAt = now
        archive.entries[key] = entry
        loadedArchives[partition] = archive
        scheduleAccessPersistence(partition: partition)
        return PersistedServerStateRecord(
            data: entry.data,
            freshUntil: entry.freshUntil,
            retainUntil: entry.retainUntil,
            scope: entry.scope
        )
    }

    func store(
        data: Data,
        key: String,
        ownerScope: String,
        apiBase: URL,
        policy: ServerStateCachePolicy,
        scope: AthenaTaskScope
    ) throws {
        guard let kind = policy.persistence.kind else {
            return
        }
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        var archive = try loadArchive(partition: partition)
        let now = Date()
        archive.entries[key] = PersistedServerStateEntry(
            key: key,
            data: data,
            freshUntil: now.addingTimeInterval(policy.freshFor),
            retainUntil: now.addingTimeInterval(policy.retainFor),
            lastAccessedAt: now,
            kind: kind,
            threadID: policy.persistence.threadID,
            scope: scope
        )
        trim(&archive, now: now)
        try saveArchive(archive, partition: partition)
    }

    func storeMany(
        _ writes: [PersistentServerStateWrite],
        ownerScope: String,
        apiBase: URL
    ) throws {
        let retained = writes.filter { $0.policy.persistence.kind != nil }
        guard !retained.isEmpty else { return }
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        var archive = try loadArchive(partition: partition)
        let now = Date()
        for write in retained {
            guard let kind = write.policy.persistence.kind else { continue }
            archive.entries[write.key] = PersistedServerStateEntry(
                key: write.key,
                data: write.data,
                freshUntil: now.addingTimeInterval(write.policy.freshFor),
                retainUntil: now.addingTimeInterval(write.policy.retainFor),
                lastAccessedAt: now,
                kind: kind,
                threadID: write.policy.persistence.threadID,
                scope: write.scope
            )
        }
        trim(&archive, now: now)
        try saveArchive(archive, partition: partition)
    }

    func markStale(
        key: String,
        ownerScope: String,
        apiBase: URL
    ) throws {
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        var archive = try loadArchive(partition: partition)
        guard var entry = archive.entries[key] else {
            return
        }
        entry.freshUntil = .distantPast
        archive.entries[key] = entry
        try saveArchive(archive, partition: partition)
    }

    func markScopeStale(
        _ scope: AthenaTaskScope,
        ownerScope: String,
        apiBase: URL
    ) throws {
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        var archive = try loadArchive(partition: partition)
        var changed = false
        for key in archive.entries.keys {
            guard var entry = archive.entries[key], entry.scope.matches(scope) else {
                continue
            }
            entry.freshUntil = .distantPast
            archive.entries[key] = entry
            changed = true
        }
        if changed {
            try saveArchive(archive, partition: partition)
        }
    }

    func invalidate(
        ownerScope: String,
        apiBase: URL,
        matching predicate: @Sendable (String, AthenaTaskScope) -> Bool
    ) throws {
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        var archive = try loadArchive(partition: partition)
        let keys = archive.entries.compactMap { key, entry in
            predicate(key, entry.scope) ? key : nil
        }
        guard !keys.isEmpty else {
            return
        }
        keys.forEach { archive.entries.removeValue(forKey: $0) }
        try saveArchive(archive, partition: partition)
    }

    func clear(ownerScope: String, apiBase: URL) throws {
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        accessPersistenceTasks.removeValue(forKey: partition)?.cancel()
        loadedArchives.removeValue(forKey: partition)
        try? fileManager.removeItem(at: archiveURL(partition: partition))
        try secureStore.removeData(forKey: encryptionKeyName(partition: partition))
    }

    func metrics(ownerScope: String, apiBase: URL) throws -> PersistentServerStateMetrics {
        let partition = partitionDigest(ownerScope: ownerScope, apiBase: apiBase)
        let archive = try loadArchive(partition: partition)
        let byteCount = (try? encodedArchive(archive).count) ?? 0
        return PersistentServerStateMetrics(
            entryCount: archive.entries.count,
            byteCount: byteCount,
            archiveWriteCount: archiveWriteCount
        )
    }

    private func loadArchive(partition: String) throws -> PersistedServerStateArchive {
        if let archive = loadedArchives[partition] {
            return archive
        }
        let url = archiveURL(partition: partition)
        guard let encrypted = try? Data(contentsOf: url),
              let keyData = try secureStore.data(forKey: encryptionKeyName(partition: partition)) else {
            let archive = emptyArchive()
            loadedArchives[partition] = archive
            return archive
        }
        do {
            let sealedBox = try AES.GCM.SealedBox(combined: encrypted)
            let decrypted = try AES.GCM.open(sealedBox, using: SymmetricKey(data: keyData))
            let archive = try JSONDecoder().decode(PersistedServerStateArchive.self, from: decrypted)
            guard archive.schemaVersion == PersistedServerStateArchive.currentSchemaVersion else {
                throw CocoaError(.coderReadCorrupt)
            }
            loadedArchives[partition] = archive
            return archive
        } catch {
            try? fileManager.removeItem(at: url)
            try? secureStore.removeData(forKey: encryptionKeyName(partition: partition))
            let archive = emptyArchive()
            loadedArchives[partition] = archive
            return archive
        }
    }

    private func saveArchive(
        _ archive: PersistedServerStateArchive,
        partition: String
    ) throws {
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let keyName = encryptionKeyName(partition: partition)
        let keyData: Data
        if let existing = try secureStore.data(forKey: keyName) {
            keyData = existing
        } else {
            keyData = Data((0..<32).map { _ in UInt8.random(in: .min ... .max) })
            try secureStore.setData(keyData, forKey: keyName)
        }
        let sealed = try AES.GCM.seal(
            encodedArchive(archive),
            using: SymmetricKey(data: keyData)
        )
        guard let encrypted = sealed.combined else {
            throw CocoaError(.fileWriteUnknown)
        }
        try encrypted.write(
            to: archiveURL(partition: partition),
            options: [.atomic, .completeFileProtection]
        )
        loadedArchives[partition] = archive
        archiveWriteCount += 1
    }

    private func scheduleAccessPersistence(partition: String) {
        accessPersistenceTasks[partition]?.cancel()
        accessPersistenceTasks[partition] = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(750))
            guard !Task.isCancelled else {
                return
            }
            await self?.persistAccessUpdates(partition: partition)
        }
    }

    private func persistAccessUpdates(partition: String) {
        defer {
            accessPersistenceTasks.removeValue(forKey: partition)
        }
        guard let archive = loadedArchives[partition] else {
            return
        }
        try? saveArchive(archive, partition: partition)
    }

    private func trim(_ archive: inout PersistedServerStateArchive, now: Date) {
        _ = removeExpiredEntries(from: &archive, now: now)

        let recentThreadDates = archive.entries.values.reduce(into: [String: Date]()) { result, entry in
            guard entry.kind == .recentThreadHistory, let threadID = entry.threadID else {
                return
            }
            result[threadID] = max(result[threadID] ?? .distantPast, entry.lastAccessedAt)
        }
        let retainedThreadIDs = Set(
            recentThreadDates
                .sorted { $0.value > $1.value }
                .prefix(maximumRecentThreads)
                .map(\.key)
        )
        archive.entries = archive.entries.filter { _, entry in
            guard entry.kind == .recentThreadHistory || entry.kind == .historyPage else {
                return true
            }
            guard let threadID = entry.threadID else {
                return false
            }
            return retainedThreadIDs.contains(threadID)
        }

        while (try? encodedArchive(archive).count) ?? 0 > maximumBytes,
              let key = evictionCandidate(in: archive) {
            archive.entries.removeValue(forKey: key)
        }
    }

    @discardableResult
    private func removeExpiredEntries(
        from archive: inout PersistedServerStateArchive,
        now: Date
    ) -> Bool {
        let count = archive.entries.count
        archive.entries = archive.entries.filter { $0.value.retainUntil > now }
        return archive.entries.count != count
    }

    private func evictionCandidate(in archive: PersistedServerStateArchive) -> String? {
        archive.entries.max { lhs, rhs in
            let lhsRank = evictionRank(lhs.value.kind)
            let rhsRank = evictionRank(rhs.value.kind)
            if lhsRank != rhsRank {
                return lhsRank < rhsRank
            }
            return lhs.value.lastAccessedAt > rhs.value.lastAccessedAt
        }?.key
    }

    private func evictionRank(_ kind: PersistedServerStateEntry.Kind) -> Int {
        switch kind {
        case .metadata:
            0
        case .recentThreadHistory:
            1
        case .historyPage:
            2
        }
    }

    private func encodedArchive(_ archive: PersistedServerStateArchive) throws -> Data {
        try JSONEncoder().encode(archive)
    }

    private func emptyArchive() -> PersistedServerStateArchive {
        PersistedServerStateArchive(
            schemaVersion: PersistedServerStateArchive.currentSchemaVersion,
            entries: [:]
        )
    }

    private func archiveURL(partition: String) -> URL {
        rootURL.appendingPathComponent("state-\(partition).cache")
    }

    private func encryptionKeyName(partition: String) -> String {
        "server-state-cache.encryption.v1.\(partition)"
    }

    private func partitionDigest(ownerScope: String, apiBase: URL) -> String {
        let identity = "\(apiBase.absoluteString)|\(ownerScope)"
        return SHA256.hash(data: Data(identity.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
