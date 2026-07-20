import Foundation

enum ServerStateCacheStatus: String, Codable, Sendable {
    case fresh
    case stale
    case missing
}

struct ServerStateCacheSnapshot: Codable, Equatable, Sendable {
    let memoryEntryCount: Int
    let freshEntryCount: Int
    let staleEntryCount: Int
    let inFlightCount: Int
    let persistentEntryCount: Int
    let persistentByteCount: Int
    let archiveWriteCount: Int
}

struct ServerStateCacheBatchItem<Value: Codable & Sendable>: Sendable {
    let value: Value
    let key: String
    let policy: ServerStateCachePolicy
    let scope: AthenaTaskScope
}

@MainActor
final class ServerStateCache {
    private struct ScopedKey: Hashable {
        let ownerScope: String
        let key: String
    }

    private struct Entry {
        let data: Data
        var freshUntil: Date
        let retainUntil: Date
        let generation: UInt64
        let policy: ServerStateCachePolicy
        let scope: AthenaTaskScope
        let apiBase: URL?
    }

    private struct InFlightEntry {
        let valueType: String
        let task: Task<Data, Error>
    }

    private var entries: [ScopedKey: Entry] = [:]
    private var inFlight: [ScopedKey: InFlightEntry] = [:]
    private var generations: [ScopedKey: UInt64] = [:]
    private let scheduler: TaskScheduler
    private let persistentStore: PersistentServerStateStore
    private let codec = CacheCodec()

    init(
        scheduler: TaskScheduler = TaskScheduler(),
        secureStore: SecureValueStore = InMemorySecureValueStore(),
        persistentRootURL: URL? = nil,
        maximumPersistentBytes: Int = PersistentServerStateStore.defaultMaximumBytes,
        maximumRecentThreads: Int = PersistentServerStateStore.defaultMaximumRecentThreads
    ) {
        self.scheduler = scheduler
        self.persistentStore = PersistentServerStateStore(
            secureStore: secureStore,
            rootURL: persistentRootURL,
            maximumBytes: maximumPersistentBytes,
            maximumRecentThreads: maximumRecentThreads
        )
    }

    func cachedValue<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        ownerScope: String,
        allowExpired: Bool = false
    ) -> Value? {
        guard let data = cachedData(
            key: key,
            ownerScope: ownerScope,
            allowExpired: allowExpired
        ) else {
            return nil
        }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    func cachedValue<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        ownerScope: String,
        apiBase: URL,
        allowExpired: Bool = false
    ) async -> Value? {
        if let data = cachedData(
            key: key,
            ownerScope: ownerScope,
            allowExpired: allowExpired
        ) {
            return try? await codec.decode(type, from: data)
        }
        let scopedKey = ScopedKey(ownerScope: ownerScope, key: key)
        guard let record = try? await persistentStore.record(
            key: key,
            ownerScope: ownerScope,
            apiBase: apiBase
        ) else {
            return nil
        }
        guard allowExpired || record.isFresh else {
            return nil
        }
        entries[scopedKey] = Entry(
            data: record.data,
            freshUntil: record.freshUntil,
            retainUntil: record.retainUntil,
            generation: generations[scopedKey, default: 0],
            policy: .memoryOnly,
            scope: record.scope,
            apiBase: apiBase
        )
        return try? await codec.decode(type, from: record.data)
    }

    func load<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        ownerScope: String,
        ttl: TimeInterval,
        forceRefresh: Bool = false,
        task descriptor: AthenaTaskDescriptor? = nil,
        fetcher: @escaping @MainActor @Sendable () async throws -> Value
    ) async throws -> Value {
        try await load(
            type,
            key: key,
            ownerScope: ownerScope,
            apiBase: nil,
            policy: ServerStateCachePolicy(
                freshFor: ttl,
                retainFor: ttl,
                persistence: .memoryOnly
            ),
            forceRefresh: forceRefresh,
            task: descriptor,
            fetcher: fetcher
        )
    }

    func load<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        ownerScope: String,
        apiBase: URL?,
        policy: ServerStateCachePolicy,
        forceRefresh: Bool = false,
        task descriptor: AthenaTaskDescriptor? = nil,
        fetcher: @escaping @MainActor @Sendable () async throws -> Value
    ) async throws -> Value {
        let scopedKey = ScopedKey(ownerScope: ownerScope, key: key)
        if !forceRefresh,
           let cachedData = cachedData(
               key: key,
               ownerScope: ownerScope,
               allowExpired: false
           ) {
            if policy.persistence != .memoryOnly, let apiBase {
                _ = try? await persistentStore.record(
                    key: key,
                    ownerScope: ownerScope,
                    apiBase: apiBase
                )
            }
            return try await codec.decode(type, from: cachedData)
        }

        if !forceRefresh,
           policy.persistence != .memoryOnly,
           let apiBase,
           let record = try? await persistentStore.record(
               key: key,
               ownerScope: ownerScope,
               apiBase: apiBase
           )
        {
            entries[scopedKey] = Entry(
                data: record.data,
                freshUntil: record.freshUntil,
                retainUntil: record.retainUntil,
                generation: generations[scopedKey, default: 0],
                policy: policy,
                scope: record.scope,
                apiBase: apiBase
            )
            if record.isFresh {
                return try await codec.decode(type, from: record.data)
            }
        }

        let valueType = String(reflecting: type)
        if let inFlight = inFlight[scopedKey] {
            guard inFlight.valueType == valueType else {
                throw AthenaTaskSchedulerError.dedupeTypeMismatch(key)
            }
            let data = try await inFlight.task.value
            return try await codec.decode(type, from: data)
        }

        let generation = generations[scopedKey, default: 0]
        var scheduledDescriptor = descriptor ?? AthenaTaskDescriptor(
            label: "server-state:\(key)",
            kind: "server-state",
            priority: .p2,
            policy: .background,
            resource: .network,
            scope: AthenaTaskScope(owner: ownerScope),
            dedupeKey: "server-state:\(ownerScope):\(key)"
        )
        if scheduledDescriptor.scope.owner == nil {
            scheduledDescriptor.scope.owner = ownerScope
        }
        if scheduledDescriptor.dedupeKey == nil {
            scheduledDescriptor.dedupeKey = "server-state:\(ownerScope):\(key)"
        }
        let task = Task<Data, Error> {
            let value = try await scheduler.run(scheduledDescriptor) { context in
                try context.checkCancellation()
                return try await fetcher()
            }
            return try await codec.encode(value)
        }
        inFlight[scopedKey] = InFlightEntry(valueType: valueType, task: task)

        do {
            let data = try await task.value
            inFlight.removeValue(forKey: scopedKey)
            guard generations[scopedKey, default: 0] == generation else {
                throw APIClientError.superseded
            }
            let now = Date()
            entries[scopedKey] = Entry(
                data: data,
                freshUntil: now.addingTimeInterval(policy.freshFor),
                retainUntil: now.addingTimeInterval(policy.retainFor),
                generation: generation,
                policy: policy,
                scope: scheduledDescriptor.scope,
                apiBase: apiBase
            )
            if policy.persistence != .memoryOnly, let apiBase {
                try await persistentStore.store(
                    data: data,
                    key: key,
                    ownerScope: ownerScope,
                    apiBase: apiBase,
                    policy: policy,
                    scope: scheduledDescriptor.scope
                )
            }
            return try await codec.decode(type, from: data)
        } catch {
            inFlight.removeValue(forKey: scopedKey)
            throw error
        }
    }

    func markStale(key: String, ownerScope: String, apiBase: URL? = nil) async {
        let scopedKey = ScopedKey(ownerScope: ownerScope, key: key)
        generations[scopedKey, default: 0] &+= 1
        if var entry = entries[scopedKey] {
            entry.freshUntil = .distantPast
            entries[scopedKey] = entry
        }
        inFlight[scopedKey]?.task.cancel()
        inFlight.removeValue(forKey: scopedKey)
        let resolvedBase = apiBase ?? entries[scopedKey]?.apiBase
        if let resolvedBase {
            try? await persistentStore.markStale(
                key: key,
                ownerScope: ownerScope,
                apiBase: resolvedBase
            )
        }
    }

    @discardableResult
    func set<Value: Codable & Sendable>(
        _ value: Value,
        key: String,
        ownerScope: String,
        apiBase: URL?,
        policy: ServerStateCachePolicy,
        scope: AthenaTaskScope
    ) async throws -> Value {
        let scopedKey = ScopedKey(ownerScope: ownerScope, key: key)
        generations[scopedKey, default: 0] &+= 1
        inFlight[scopedKey]?.task.cancel()
        inFlight.removeValue(forKey: scopedKey)
        let data = try await codec.encode(value)
        let now = Date()
        entries[scopedKey] = Entry(
            data: data,
            freshUntil: now.addingTimeInterval(policy.freshFor),
            retainUntil: now.addingTimeInterval(policy.retainFor),
            generation: generations[scopedKey, default: 0],
            policy: policy,
            scope: scope,
            apiBase: apiBase
        )
        if policy.persistence != .memoryOnly, let apiBase {
            try await persistentStore.store(
                data: data,
                key: key,
                ownerScope: ownerScope,
                apiBase: apiBase,
                policy: policy,
                scope: scope
            )
        }
        return value
    }

    func setMany<Value: Codable & Sendable>(
        _ items: [ServerStateCacheBatchItem<Value>],
        ownerScope: String,
        apiBase: URL?
    ) async throws {
        guard !items.isEmpty else { return }
        var encoded: [(item: ServerStateCacheBatchItem<Value>, data: Data)] = []
        encoded.reserveCapacity(items.count)
        for item in items {
            encoded.append((item, try await codec.encode(item.value)))
        }

        let now = Date()
        var persistentWrites: [PersistentServerStateWrite] = []
        for entry in encoded {
            let item = entry.item
            let scopedKey = ScopedKey(ownerScope: ownerScope, key: item.key)
            generations[scopedKey, default: 0] &+= 1
            inFlight[scopedKey]?.task.cancel()
            inFlight.removeValue(forKey: scopedKey)
            entries[scopedKey] = Entry(
                data: entry.data,
                freshUntil: now.addingTimeInterval(item.policy.freshFor),
                retainUntil: now.addingTimeInterval(item.policy.retainFor),
                generation: generations[scopedKey, default: 0],
                policy: item.policy,
                scope: item.scope,
                apiBase: apiBase
            )
            if item.policy.persistence != .memoryOnly {
                persistentWrites.append(
                    PersistentServerStateWrite(
                        data: entry.data,
                        key: item.key,
                        policy: item.policy,
                        scope: item.scope
                    )
                )
            }
        }
        if let apiBase, !persistentWrites.isEmpty {
            try await persistentStore.storeMany(
                persistentWrites,
                ownerScope: ownerScope,
                apiBase: apiBase
            )
        }
    }

    private func cachedData(
        key: String,
        ownerScope: String,
        allowExpired: Bool
    ) -> Data? {
        let scopedKey = ScopedKey(ownerScope: ownerScope, key: key)
        guard let entry = entries[scopedKey], entry.retainUntil > Date() else {
            return nil
        }
        guard allowExpired || entry.freshUntil > Date() else {
            return nil
        }
        return entry.data
    }

    func mutate<Value: Codable & Sendable>(
        _ type: Value.Type,
        key: String,
        ownerScope: String,
        apiBase: URL,
        policy: ServerStateCachePolicy,
        scope: AthenaTaskScope,
        mutation: (inout Value) -> Void
    ) async throws -> Value? {
        guard var value = await cachedValue(
            type,
            key: key,
            ownerScope: ownerScope,
            apiBase: apiBase,
            allowExpired: true
        ) else {
            return nil
        }
        mutation(&value)
        return try await set(
            value,
            key: key,
            ownerScope: ownerScope,
            apiBase: apiBase,
            policy: policy,
            scope: scope
        )
    }

    func markScopeStale(
        _ scope: AthenaTaskScope,
        ownerScope: String,
        apiBase: URL
    ) async {
        let keys = entries.keys.filter { scopedKey in
            scopedKey.ownerScope == ownerScope && entries[scopedKey]?.scope.matches(scope) == true
        }
        for key in keys {
            generations[key, default: 0] &+= 1
            if var entry = entries[key] {
                entry.freshUntil = .distantPast
                entries[key] = entry
            }
            inFlight[key]?.task.cancel()
            inFlight.removeValue(forKey: key)
        }
        try? await persistentStore.markScopeStale(
            scope,
            ownerScope: ownerScope,
            apiBase: apiBase
        )
        await scheduler.markScopeStale(scope)
    }

    func invalidatePrefix(
        _ prefix: String,
        ownerScope: String,
        apiBase: URL
    ) async {
        let keys = entries.keys.filter { $0.ownerScope == ownerScope && $0.key.hasPrefix(prefix) }
        remove(keys: keys)
        try? await persistentStore.invalidate(
            ownerScope: ownerScope,
            apiBase: apiBase
        ) { key, _ in
            key.hasPrefix(prefix)
        }
    }

    func invalidateKeys(
        _ rawKeys: Set<String>,
        ownerScope: String,
        apiBase: URL
    ) async {
        guard !rawKeys.isEmpty else { return }
        let keys = entries.keys.filter {
            $0.ownerScope == ownerScope && rawKeys.contains($0.key)
        }
        remove(keys: keys)
        try? await persistentStore.invalidate(
            ownerScope: ownerScope,
            apiBase: apiBase
        ) { key, _ in
            rawKeys.contains(key)
        }
    }

    func invalidateScope(
        _ scope: AthenaTaskScope,
        ownerScope: String,
        apiBase: URL
    ) async {
        let keys = entries.keys.filter { scopedKey in
            scopedKey.ownerScope == ownerScope && entries[scopedKey]?.scope.matches(scope) == true
        }
        remove(keys: keys)
        try? await persistentStore.invalidate(
            ownerScope: ownerScope,
            apiBase: apiBase
        ) { _, entryScope in
            entryScope.matches(scope)
        }
        await scheduler.cancelScope(scope, reason: "server-state-invalidated")
    }

    func clear(ownerScope: String, apiBase: URL) async {
        let keys = entries.keys.filter { $0.ownerScope == ownerScope }
        remove(keys: keys)
        try? await persistentStore.clear(ownerScope: ownerScope, apiBase: apiBase)
    }

    func snapshot(ownerScope: String, apiBase: URL) async -> ServerStateCacheSnapshot {
        let ownerEntries = entries.filter { $0.key.ownerScope == ownerScope }.map(\.value)
        let now = Date()
        let persistent = (try? await persistentStore.metrics(
            ownerScope: ownerScope,
            apiBase: apiBase
        )) ?? PersistentServerStateMetrics(
            entryCount: 0,
            byteCount: 0,
            archiveWriteCount: 0
        )
        return ServerStateCacheSnapshot(
            memoryEntryCount: ownerEntries.count,
            freshEntryCount: ownerEntries.filter { $0.freshUntil > now }.count,
            staleEntryCount: ownerEntries.filter { $0.freshUntil <= now }.count,
            inFlightCount: inFlight.keys.filter { $0.ownerScope == ownerScope }.count,
            persistentEntryCount: persistent.entryCount,
            persistentByteCount: persistent.byteCount,
            archiveWriteCount: persistent.archiveWriteCount
        )
    }

    private func remove(keys: [ScopedKey]) {
        for key in keys {
            entries.removeValue(forKey: key)
            generations[key, default: 0] &+= 1
            inFlight[key]?.task.cancel()
            inFlight.removeValue(forKey: key)
        }
    }
}
