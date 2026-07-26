import CryptoKit
import Foundation

enum SyncJSONValue: Codable, Equatable, Sendable {
    case object([String: SyncJSONValue])
    case array([SyncJSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([SyncJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: SyncJSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

extension SyncJSONValue {
    var objectValue: [String: SyncJSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var intValue: Int? {
        guard case .number(let value) = self else { return nil }
        return Int(value)
    }

    var arrayValue: [SyncJSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }
}

struct NativeSyncV2ProfileProjection: Equatable, Sendable {
    let id: Int
    let username: String?
    let displayName: String?
    let email: String?
    let phone: String?
    let bio: String?
    let pfpFilename: String?
}

enum NativeSyncV2ProjectionDecoder {
    static func profile(_ payload: SyncJSONValue?) -> NativeSyncV2ProfileProjection? {
        guard let value = payload?.objectValue,
              let id = value["id"]?.intValue else { return nil }
        return NativeSyncV2ProfileProjection(
            id: id,
            username: value["username"]?.stringValue,
            displayName: value["displayName"]?.stringValue,
            email: value["email"]?.stringValue,
            phone: value["phone"]?.stringValue,
            bio: value["bio"]?.stringValue,
            pfpFilename: value["pfpFilename"]?.stringValue
        )
    }

    static func workspaces(_ payload: SyncJSONValue?) -> [AthenaWorkspace]? {
        guard let values = payload?.arrayValue else { return nil }
        let projected = values.compactMap { item -> AthenaWorkspace? in
            guard let value = item.objectValue,
                  let id = value["id"]?.intValue,
                  let slug = value["slug"]?.stringValue,
                  let name = value["name"]?.stringValue else { return nil }
            return AthenaWorkspace(
                id: slug,
                serverID: id,
                title: name,
                chatModel: value["chatModel"]?.stringValue.flatMap(
                    ThreadChatModel.init(rawValue:)
                ),
                lastUpdatedAt: value["lastUpdatedAt"]?.stringValue
            )
        }
        return projected.count == values.count ? projected : nil
    }

    static func threads(
        _ payload: SyncJSONValue?,
        workspaceID: String
    ) -> [AthenaThread]? {
        guard let values = payload?.arrayValue else { return nil }
        let projected = values.compactMap { item -> AthenaThread? in
            guard let value = item.objectValue,
                  let id = value["id"]?.intValue,
                  let slug = value["slug"]?.stringValue else { return nil }
            let title = value["title"]?.stringValue
                ?? value["name"]?.stringValue
                ?? "New thread"
            return AthenaThread(
                id: slug,
                serverID: id,
                workspaceID: workspaceID,
                title: title,
                chatModel: value["chatModel"]?.stringValue.flatMap(
                    ThreadChatModel.init(rawValue:)
                ),
                threadType: value["thread_type"]?.stringValue,
                lastUpdatedAt: value["lastUpdatedAt"]?.stringValue,
                historyRevision: value["historyRevision"]?.intValue ?? 0
            )
        }
        return projected.count == values.count ? projected : nil
    }

    static func drawerPins(_ payload: SyncJSONValue?) -> IOSDrawerPinsState? {
        guard let wrapper = payload?.objectValue,
              let value = wrapper["value"]?.objectValue,
              let pins = value["pins"]?.arrayValue else { return nil }
        let projected = pins.compactMap { item -> IOSDrawerPin? in
            guard let pin = item.objectValue,
                  let rawKind = pin["kind"]?.stringValue,
                  let kind = IOSDrawerPin.Kind(rawValue: rawKind),
                  let workspaceID = pin["workspaceID"]?.stringValue,
                  let pinnedAt = pin["pinnedAt"]?.stringValue else { return nil }
            return IOSDrawerPin(
                kind: kind,
                workspaceID: workspaceID,
                threadID: pin["threadID"]?.stringValue,
                pinnedAt: pinnedAt
            )
        }
        return projected.count == pins.count ? IOSDrawerPinsState(pins: projected) : nil
    }
}

struct NativeSyncV2NodeDescriptor: Codable, Equatable, Sendable {
    let nodeKey: String
    let parentKey: String?
    let ownerType: String?
    let ownerId: Int?
    let visibility: String?
    let schemaVersion: Int
    let stateVersion: Int
    let hydration: String?
    let hash: String?
    let hashAlgorithm: String?
    let updatedAt: String
    let deletedAt: String?
    let eventCursor: Int?
}

struct NativeSyncV2Manifest: Codable, Sendable {
    let success: Bool
    let protocolVersion: Int
    let checkpointSeq: Int
    let manifestHash: String?
    let unchanged: Bool?
    let nodes: [NativeSyncV2NodeDescriptor]
}

struct NativeSyncV2NodeRequest: Codable, Sendable {
    let nodeKey: String
    let knownVersion: Int
    let knownHash: String?
}

private struct NativeSyncV2BatchRequest: Encodable {
    let nodes: [NativeSyncV2NodeRequest]
}

struct NativeSyncV2NodeResult: Codable, Sendable {
    let descriptor: NativeSyncV2NodeDescriptor
    let unchanged: Bool
    let payload: SyncJSONValue?
    let repaired: Bool?
}

private struct NativeSyncV2BatchResponse: Decodable {
    let success: Bool
    let nodes: [NativeSyncV2NodeResult]
}

struct NativeSyncV2Event: Codable, Equatable, Sendable {
    let seq: Int
    let eventId: String
    let nodeKey: String
    let stateVersion: Int
    let hash: String?
    let eventType: String?
    let operation: String?
    let changedPaths: [String]?
    let updatedAt: String?
}

private struct NativeSyncV2EventsResponse: Decodable {
    let success: Bool
    let events: [NativeSyncV2Event]
    let checkpointSeq: Int
    let nextSeq: Int?
    let hasMore: Bool
    let requiresFullSync: Bool
}

private struct NativeSyncV2CursorRequest: Encodable { let lastAppliedSeq: Int }
private struct NativeSyncV2SuccessResponse: Decodable { let success: Bool }

struct NativeSyncV2Mutation: Codable, Equatable, Sendable {
    let mutationId: String
    let nodeKey: String
    let baseVersion: Int
    let operation: String
    let changedPaths: [String]
    let payload: SyncJSONValue
    var dirty: Bool
    var attempts: Int
    var conflict: Bool?
    var failed: Bool?
    var lastError: String?
}

private struct NativeSyncV2MutationBatchRequest: Encodable {
    let mutations: [NativeSyncV2Mutation]
}

private struct NativeSyncV2MutationResult: Decodable {
    let mutationId: String?
    let nodeKey: String?
    let success: Bool
    let status: Int?
    let error: String?
    let descriptor: NativeSyncV2NodeDescriptor?
}

private struct NativeSyncV2MutationBatchResponse: Decodable {
    let success: Bool
    let results: [NativeSyncV2MutationResult]
}

struct NativeSyncV2CachedNode: Codable, Sendable {
    let descriptor: NativeSyncV2NodeDescriptor
    let payload: SyncJSONValue?
}

struct NativeSyncV2Diagnostics: Equatable, Sendable {
    let enabled: Bool
    let descriptorCount: Int
    let lastAppliedSeq: Int
    let queuedMutations: Int
    let pendingMutations: Int
    let conflictMutations: Int
    let failedMutations: Int
    let totalAttempts: Int
    let syncEventsReceived: Int
    let syncNodesDeduplicated: Int
    let syncBatchGetRequests: Int
    let syncCursorAcks: Int
    let iosCacheArchiveWrites: Int
    let hashVerificationRuns: Int
    let directPayloadApplications: Int
    let suppressedLegacyDomainReads: Int
}

@MainActor
final class NativeSyncV2Coordinator {
    typealias NodeHandler = @MainActor (NativeSyncV2NodeResult) async throws -> Void

    private struct PendingLiveEvent {
        let event: NativeSyncV2Event
        let continuation: CheckedContinuation<Bool, Error>
    }

    private let apiClient: APIClient
    private let serverStateCache: ServerStateCache
    private let secureStore: SecureValueStore
    private let clientIdentityCenter: ClientIdentityCenter
    private var ownerScope: String?
    private var descriptors: [String: NativeSyncV2NodeDescriptor] = [:]
    private var nodeHandler: NodeHandler?
    private var pendingLiveEvents: [PendingLiveEvent] = []
    private var liveEventFlushTask: Task<Void, Never>?
    private var hashVerificationTask: Task<Void, Never>?
    private var syncEventsReceived = 0
    private var syncNodesDeduplicated = 0
    private var syncBatchGetRequests = 0
    private var syncCursorAcks = 0
    private var iosCacheArchiveWrites = 0
    private var hashVerificationRuns = 0
    private var directPayloadApplications = 0
    private var suppressedLegacyDomainReads = 0
    private var payloadAvailableNodeKeys: Set<String> = []
    private var backgrounded = false
    private(set) var isEnabled = false

    init(
        apiClient: APIClient,
        serverStateCache: ServerStateCache,
        secureStore: SecureValueStore,
        clientIdentityCenter: ClientIdentityCenter
    ) {
        self.apiClient = apiClient
        self.serverStateCache = serverStateCache
        self.secureStore = secureStore
        self.clientIdentityCenter = clientIdentityCenter
    }

    func setNodeHandler(_ handler: @escaping NodeHandler) {
        nodeHandler = handler
    }

    func diagnostics() -> NativeSyncV2Diagnostics {
        let queue = loadMutationQueue()
        let lastAppliedSeq = ownerScope.map { loadCursor(ownerScope: $0) } ?? 0
        return NativeSyncV2Diagnostics(
            enabled: isEnabled,
            descriptorCount: descriptors.count,
            lastAppliedSeq: lastAppliedSeq,
            queuedMutations: queue.count,
            pendingMutations: queue.filter {
                $0.conflict != true && $0.failed != true
            }.count,
            conflictMutations: queue.filter { $0.conflict == true }.count,
            failedMutations: queue.filter { $0.failed == true }.count,
            totalAttempts: queue.reduce(0) { $0 + $1.attempts },
            syncEventsReceived: syncEventsReceived,
            syncNodesDeduplicated: syncNodesDeduplicated,
            syncBatchGetRequests: syncBatchGetRequests,
            syncCursorAcks: syncCursorAcks,
            iosCacheArchiveWrites: iosCacheArchiveWrites,
            hashVerificationRuns: hashVerificationRuns,
            directPayloadApplications: directPayloadApplications,
            suppressedLegacyDomainReads: suppressedLegacyDomainReads
        )
    }

    func recordDirectPayloadApplication() {
        directPayloadApplications += 1
    }

    func recordSuppressedLegacyDomainRead() {
        suppressedLegacyDomainReads += 1
    }

    func setBackgrounded(_ backgrounded: Bool) {
        self.backgrounded = backgrounded
        if backgrounded {
            hashVerificationTask?.cancel()
            hashVerificationTask = nil
        } else if isEnabled {
            startHashVerification()
        }
    }

    func start(ownerScope: String) async -> Bool {
        hashVerificationTask?.cancel()
        hashVerificationTask = nil
        self.ownerScope = ownerScope
        payloadAvailableNodeKeys = []
        do {
            var cachedManifestHash: String?
            if let cached = await serverStateCache.cachedValue(
                NativeSyncV2Manifest.self,
                key: "sync.v2.manifest",
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                allowExpired: true
            ) {
                descriptors = Dictionary(uniqueKeysWithValues: cached.nodes.map { ($0.nodeKey, $0) })
                cachedManifestHash = cached.manifestHash
                for descriptor in cached.nodes where descriptor.hydration != "lazy" {
                    guard let cachedNode = await serverStateCache.cachedValue(
                        NativeSyncV2CachedNode.self,
                        key: cacheKey(descriptor.nodeKey),
                        ownerScope: ownerScope,
                        apiBase: apiClient.configuration.normalizedBaseURL,
                        allowExpired: true
                    ),
                    cachedNode.descriptor.stateVersion == descriptor.stateVersion,
                    cachedNode.descriptor.hash == descriptor.hash,
                    cachedNode.payload != nil else {
                        continue
                    }
                    try await nodeHandler?(
                        NativeSyncV2NodeResult(
                            descriptor: cachedNode.descriptor,
                            unchanged: false,
                            payload: cachedNode.payload,
                            repaired: false
                        )
                    )
                    payloadAvailableNodeKeys.insert(descriptor.nodeKey)
                }
            }
            let manifestPath: String
            if let hash = cachedManifestHash,
               let encoded = hash.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
            {
                manifestPath = "/api/sync/v2/manifest?manifestHash=\(encoded)"
            } else {
                manifestPath = "/api/sync/v2/manifest"
            }
            let manifest = try await apiClient.getJSON(
                NativeSyncV2Manifest.self,
                path: manifestPath,
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            let manifestNodes = manifest.unchanged == true
                ? Array(descriptors.values)
                : manifest.nodes
            let changed = manifestNodes.filter { remote in
                guard remote.hydration != "lazy" else { return false }
                guard let local = descriptors[remote.nodeKey] else { return true }
                return !payloadAvailableNodeKeys.contains(remote.nodeKey) ||
                    local.stateVersion != remote.stateVersion ||
                    (local.hash != nil && remote.hash != nil && local.hash != remote.hash)
            }
            let changedRequests = changed.map {
                NativeSyncV2NodeRequest(
                    nodeKey: $0.nodeKey,
                    knownVersion: payloadAvailableNodeKeys.contains($0.nodeKey)
                        ? descriptors[$0.nodeKey]?.stateVersion ?? 0
                        : 0,
                    knownHash: payloadAvailableNodeKeys.contains($0.nodeKey)
                        ? descriptors[$0.nodeKey]?.hash
                        : nil
                )
            }
            _ = try await applyRequests(changedRequests)
            if manifest.unchanged != true {
                let visibleKeys = Set(manifest.nodes.map(\.nodeKey))
                let removedKeys = Set(descriptors.keys).subtracting(visibleKeys)
                await serverStateCache.invalidateKeys(
                    Set(removedKeys.map(cacheKey)),
                    ownerScope: ownerScope,
                    apiBase: apiClient.configuration.normalizedBaseURL
                )
                payloadAvailableNodeKeys.subtract(removedKeys)
                descriptors = Dictionary(uniqueKeysWithValues: manifest.nodes.map { remote in
                    let applied = descriptors[remote.nodeKey]
                    return (
                        remote.nodeKey,
                        (applied?.stateVersion ?? 0) > remote.stateVersion
                            ? applied!
                            : remote
                    )
                })
            }
            let effectiveManifest = NativeSyncV2Manifest(
                success: manifest.success,
                protocolVersion: manifest.protocolVersion,
                checkpointSeq: manifest.checkpointSeq,
                manifestHash: manifest.manifestHash ?? cachedManifestHash,
                unchanged: false,
                nodes: descriptors.values.sorted { $0.nodeKey < $1.nodeKey }
            )
            _ = try await serverStateCache.set(
                effectiveManifest,
                key: "sync.v2.manifest",
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .recentNavigation,
                scope: AthenaTaskScope(owner: ownerScope, route: "sync-v2", surface: "manifest")
            )
            try await replay(after: loadCursor(ownerScope: ownerScope))
            try await flushMutationQueue()
            isEnabled = true
            startHashVerification()
            return true
        } catch APIClientError.httpStatus(let status, _, _) where status == 404 || status == 503 {
            isEnabled = false
            return false
        } catch is URLError {
            isEnabled = !descriptors.isEmpty
            if isEnabled { startHashVerification() }
            return isEnabled
        } catch {
            isEnabled = false
            return false
        }
    }

    func apply(_ event: NativeSyncV2Event) async throws -> Bool {
        guard ownerScope != nil else { return false }
        return try await withCheckedThrowingContinuation { continuation in
            pendingLiveEvents.append(
                PendingLiveEvent(event: event, continuation: continuation)
            )
            scheduleLiveEventFlush()
        }
    }

    func enqueue(_ mutation: NativeSyncV2Mutation) throws {
        guard replayable(mutation.nodeKey) else {
            throw APIClientError.httpStatus(
                status: 400,
                code: "sync_v2_offline_replay_forbidden",
                message: nil
            )
        }
        var queue = loadMutationQueue()
        guard !queue.contains(where: { $0.mutationId == mutation.mutationId }) else { return }
        queue.append(mutation)
        try persistMutationQueue(queue)
    }

    func submitMutation(
        nodeKey: String,
        mutationId: String,
        changedPaths: [String],
        payload: SyncJSONValue
    ) async throws -> Bool {
        guard isEnabled, let descriptor = descriptors[nodeKey] else { return false }
        let mutation = NativeSyncV2Mutation(
            mutationId: mutationId,
            nodeKey: nodeKey,
            baseVersion: descriptor.stateVersion,
            operation: "merge",
            changedPaths: changedPaths,
            payload: payload,
            dirty: true,
            attempts: 0,
            conflict: nil,
            failed: nil,
            lastError: nil
        )
        try enqueue(mutation)
        do {
            try await flushMutationQueue()
        } catch APIClientError.httpStatus(let status, _, _) where
            status == 408 || status == 425 || status == 429 || status >= 500
        {
            return true
        } catch is URLError {
            return true
        } catch {
            throw error
        }
        guard let retained = loadMutationQueue().first(where: {
            $0.mutationId == mutationId
        }) else { return true }
        if retained.conflict == true {
            throw APIClientError.httpStatus(
                status: 409,
                code: "state_version_conflict",
                message: retained.lastError
            )
        }
        if retained.failed == true {
            throw APIClientError.httpStatus(
                status: 422,
                code: retained.lastError ?? "sync_v2_mutation_failed",
                message: retained.lastError
            )
        }
        return true
    }

    func flushMutationQueue() async throws {
        var queue = loadMutationQueue()
        let pending = queue.filter { $0.conflict != true && $0.failed != true }
        guard !pending.isEmpty else { return }
        for start in stride(from: 0, to: pending.count, by: 50) {
            let batch = Array(pending[start ..< min(start + 50, pending.count)])
            let response: NativeSyncV2MutationBatchResponse
            do {
                response = try await apiClient.requestJSON(
                    NativeSyncV2MutationBatchResponse.self,
                    method: .post,
                    path: "/api/sync/v2/mutations:batch",
                    body: NativeSyncV2MutationBatchRequest(mutations: batch),
                    authorization: .required,
                    signing: .required,
                    retryOnConnectionLoss: true
                )
            } catch APIClientError.httpStatus(let status, let code, let message) where
                (400 ... 499).contains(status) && ![408, 425, 429].contains(status)
            {
                let ids = Set(batch.map(\.mutationId))
                queue = queue.map { mutation in
                    guard ids.contains(mutation.mutationId) else { return mutation }
                    var retained = mutation
                    retained.failed = true
                    retained.attempts += 1
                    retained.lastError = code ?? message ?? "sync_failed"
                    return retained
                }
                try persistMutationQueue(queue)
                throw APIClientError.httpStatus(status: status, code: code, message: message)
            }
            for result in response.results where result.success {
                guard let descriptor = result.descriptor else { continue }
                let knownVersion = descriptors[descriptor.nodeKey]?.stateVersion ?? 0
                if descriptor.stateVersion >= knownVersion {
                    descriptors[descriptor.nodeKey] = descriptor
                    if descriptor.stateVersion > knownVersion {
                        // Mutation receipts contain metadata, not the new
                        // projection. Force the next event/reconcile to fetch it.
                        payloadAvailableNodeKeys.remove(descriptor.nodeKey)
                    }
                }
            }
            let applied = Set(response.results.filter(\.success).compactMap(\.mutationId))
            let conflicts = Set(
                response.results
                    .filter { !$0.success && $0.error == "state_version_conflict" }
                    .compactMap(\.mutationId)
            )
            let terminalFailures = Set(
                response.results
                    .filter { result in
                        guard !result.success, let status = result.status else { return false }
                        if result.error == "state_version_conflict" { return false }
                        return (400 ... 499).contains(status) && ![408, 425, 429].contains(status)
                    }
                    .compactMap(\.mutationId)
            )
            queue = queue.compactMap { mutation in
                if applied.contains(mutation.mutationId) { return nil }
                var retained = mutation
                retained.dirty = true
                if conflicts.contains(mutation.mutationId) {
                    retained.conflict = true
                    retained.lastError = "state_version_conflict"
                } else if terminalFailures.contains(mutation.mutationId) {
                    retained.failed = true
                    retained.attempts += 1
                    retained.lastError = response.results.first {
                        $0.mutationId == mutation.mutationId
                    }?.error ?? "sync_failed"
                } else if batch.contains(where: { $0.mutationId == mutation.mutationId }) {
                    retained.attempts += 1
                    retained.lastError = response.results.first {
                        $0.mutationId == mutation.mutationId
                    }?.error ?? "sync_failed"
                }
                return retained
            }
            try persistMutationQueue(queue)
        }
    }

    func stop(clear: Bool) {
        hashVerificationTask?.cancel()
        hashVerificationTask = nil
        liveEventFlushTask?.cancel()
        liveEventFlushTask = nil
        let pending = pendingLiveEvents
        pendingLiveEvents.removeAll()
        pending.forEach { $0.continuation.resume(throwing: CancellationError()) }
        if clear, let ownerScope {
            try? secureStore.removeData(forKey: cursorKey(ownerScope: ownerScope))
            try? secureStore.removeData(forKey: mutationQueueKey(ownerScope: ownerScope))
        }
        ownerScope = nil
        descriptors = [:]
        payloadAvailableNodeKeys = []
        isEnabled = false
    }

    private func replay(after initialCursor: Int) async throws {
        var cursor = initialCursor
        while true {
            let page = try await apiClient.getJSON(
                NativeSyncV2EventsResponse.self,
                path: "/api/sync/v2/events",
                queryItems: [
                    URLQueryItem(name: "after", value: String(cursor)),
                    URLQueryItem(name: "limit", value: "200"),
                ],
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            if page.requiresFullSync {
                let manifest = try await apiClient.getJSON(
                    NativeSyncV2Manifest.self,
                    path: "/api/sync/v2/manifest",
                    authorization: .required,
                    signing: .required
                )
                _ = try await applyRequests(manifest.nodes.filter {
                    $0.hydration != "lazy"
                }.map {
                    NativeSyncV2NodeRequest(nodeKey: $0.nodeKey, knownVersion: 0, knownHash: nil)
                })
                cursor = manifest.checkpointSeq
                try await persistAndAcknowledgeCursor(cursor)
                break
            }
            cursor = max(
                page.nextSeq ?? cursor,
                page.events.map(\.seq).max() ?? cursor
            )
            _ = try await applyEventsImmediately(
                page.events,
                checkpointSeq: cursor
            )
            guard page.hasMore else { break }
        }
    }

    private func applyRequests(
        _ requests: [NativeSyncV2NodeRequest]
    ) async throws -> Set<String> {
        guard let ownerScope, !requests.isEmpty else { return [] }
        var nodes: [NativeSyncV2NodeResult] = []
        for start in stride(from: 0, to: requests.count, by: 100) {
            let batch = Array(requests[start ..< min(start + 100, requests.count)])
            syncBatchGetRequests += 1
            let response = try await apiClient.requestJSON(
                NativeSyncV2BatchResponse.self,
                method: .post,
                path: "/api/sync/v2/nodes:batchGet",
                body: NativeSyncV2BatchRequest(nodes: batch),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            nodes.append(contentsOf: response.nodes)
        }
        let cacheableNodes = nodes.filter { $0.payload != nil }
        try await serverStateCache.setMany(
            cacheableNodes.map { node in
                ServerStateCacheBatchItem(
                    value: NativeSyncV2CachedNode(
                        descriptor: node.descriptor,
                        payload: node.payload
                    ),
                    key: cacheKey(node.descriptor.nodeKey),
                    policy: .recentNavigation,
                    scope: AthenaTaskScope(
                        owner: ownerScope,
                        route: "sync-v2",
                        surface: "node",
                        workspaceID: node.descriptor.ownerType == "workspace"
                            ? String(node.descriptor.ownerId ?? 0)
                            : nil,
                        threadID: node.descriptor.ownerType == "thread"
                            ? String(node.descriptor.ownerId ?? 0)
                            : nil
                    )
                )
            },
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        if !cacheableNodes.isEmpty { iosCacheArchiveWrites += 1 }
        for node in nodes {
            try await nodeHandler?(node)
        }
        for node in nodes {
            descriptors[node.descriptor.nodeKey] = node.descriptor
            if node.payload != nil {
                payloadAvailableNodeKeys.insert(node.descriptor.nodeKey)
            }
        }
        return Set(nodes.map { $0.descriptor.nodeKey })
    }

    private func requests(for events: [NativeSyncV2Event]) -> [NativeSyncV2NodeRequest] {
        var latestByNode: [String: NativeSyncV2Event] = [:]
        for event in events {
            guard let existing = latestByNode[event.nodeKey] else {
                latestByNode[event.nodeKey] = event
                continue
            }
            if event.stateVersion > existing.stateVersion ||
                (event.stateVersion == existing.stateVersion && event.seq > existing.seq)
            {
                latestByNode[event.nodeKey] = event
            }
        }
        syncNodesDeduplicated += max(0, events.count - latestByNode.count)
        return latestByNode.values.compactMap { event in
            let known = descriptors[event.nodeKey]
            let hasPayload = payloadAvailableNodeKeys.contains(event.nodeKey)
            let hashMismatch = known?.hash != nil && event.hash != nil && known?.hash != event.hash
            guard !hasPayload || (known?.stateVersion ?? 0) < event.stateVersion || hashMismatch else {
                return nil
            }
            return NativeSyncV2NodeRequest(
                nodeKey: event.nodeKey,
                knownVersion: hasPayload ? known?.stateVersion ?? 0 : 0,
                knownHash: hasPayload ? known?.hash : nil
            )
        }
    }

    private func applyEventsImmediately(
        _ events: [NativeSyncV2Event],
        checkpointSeq: Int? = nil
    ) async throws -> Set<String> {
        guard !events.isEmpty || checkpointSeq != nil else { return [] }
        syncEventsReceived += events.count
        let appliedNodeKeys = try await applyRequests(requests(for: events))
        let cursor = max(checkpointSeq ?? 0, events.map(\.seq).max() ?? 0)
        try await persistAndAcknowledgeCursor(cursor)
        return appliedNodeKeys
    }

    private func persistAndAcknowledgeCursor(_ cursor: Int) async throws {
        guard cursor > 0, let ownerScope else { return }
        try persistCursor(cursor, ownerScope: ownerScope)
        _ = try await apiClient.requestJSON(
            NativeSyncV2SuccessResponse.self,
            method: .post,
            path: "/api/sync/v2/cursor",
            body: NativeSyncV2CursorRequest(lastAppliedSeq: cursor),
            authorization: .required,
            signing: .required
        )
        syncCursorAcks += 1
    }

    private func scheduleLiveEventFlush() {
        if pendingLiveEvents.count >= 100 {
            liveEventFlushTask?.cancel()
            liveEventFlushTask = Task { [weak self] in
                await self?.flushLiveEvents()
            }
            return
        }
        guard liveEventFlushTask == nil else { return }
        liveEventFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(25))
            guard !Task.isCancelled else { return }
            await self?.flushLiveEvents()
        }
    }

    private func startHashVerification() {
        guard !backgrounded, hashVerificationTask == nil else { return }
        hashVerificationTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15 * 60))
                guard !Task.isCancelled, let self, self.isEnabled else { break }
                await self.verifyHashSample()
            }
        }
    }

    private func verifyHashSample() async {
        let values = descriptors.values.sorted { $0.nodeKey < $1.nodeKey }
        guard !values.isEmpty else { return }
        let offset = Int(Date().timeIntervalSince1970 / 900) % values.count
        let count = min(5, values.count)
        let sample = (0 ..< count).map { values[(offset + $0) % values.count] }
        let requests = sample.map { descriptor in
            let hasPayload = payloadAvailableNodeKeys.contains(descriptor.nodeKey)
            return NativeSyncV2NodeRequest(
                nodeKey: descriptor.nodeKey,
                knownVersion: hasPayload ? descriptor.stateVersion : 0,
                knownHash: hasPayload ? descriptor.hash : nil
            )
        }
        do {
            _ = try await applyRequests(requests)
            hashVerificationRuns += 1
        } catch {
            // Notification, replay and the next scheduled sample remain
            // independent recovery paths; a sample never advances the cursor.
        }
    }

    private func flushLiveEvents() async {
        liveEventFlushTask = nil
        guard !pendingLiveEvents.isEmpty else { return }
        let count = min(100, pendingLiveEvents.count)
        let batch = Array(pendingLiveEvents.prefix(count))
        pendingLiveEvents.removeFirst(count)
        do {
            let appliedNodeKeys = try await applyEventsImmediately(batch.map(\.event))
            batch.forEach {
                $0.continuation.resume(
                    returning: appliedNodeKeys.contains($0.event.nodeKey)
                )
            }
        } catch {
            batch.forEach { $0.continuation.resume(throwing: error) }
        }
        if !pendingLiveEvents.isEmpty {
            scheduleLiveEventFlush()
        }
    }

    private func replayable(_ nodeKey: String) -> Bool {
        nodeKey.range(of: #"^(users/\d+/(profile|preferences/[^/]+/[^/]+)|workspaces/\d+/metadata|threads/\d+/metadata)$"#, options: .regularExpression) != nil
    }

    private func cacheKey(_ nodeKey: String) -> String {
        let digest = SHA256.hash(data: Data(nodeKey.utf8)).map { String(format: "%02x", $0) }.joined()
        return "sync.v2.node.\(digest)"
    }

    private func cursorKey(ownerScope: String) -> String {
        let identity = "\(apiClient.configuration.normalizedBaseURL)|\(ownerScope)|\(clientIdentityCenter.clientID ?? "unknown")"
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return "native-sync.cursor.v2.\(digest)"
    }

    private func mutationQueueKey(ownerScope: String) -> String {
        "native-sync.mutations.v2.\(ownerScope.data(using: .utf8)!.base64EncodedString())"
    }

    private func loadCursor(ownerScope: String) -> Int {
        guard let data = try? secureStore.data(forKey: cursorKey(ownerScope: ownerScope)),
              let value = String(data: data, encoding: .utf8) else { return 0 }
        return Int(value) ?? 0
    }

    private func persistCursor(_ cursor: Int, ownerScope: String) throws {
        try secureStore.setData(Data(String(cursor).utf8), forKey: cursorKey(ownerScope: ownerScope))
    }

    private func loadMutationQueue() -> [NativeSyncV2Mutation] {
        guard let ownerScope,
              let data = try? secureStore.data(forKey: mutationQueueKey(ownerScope: ownerScope)) else { return [] }
        return (try? JSONDecoder().decode([NativeSyncV2Mutation].self, from: data)) ?? []
    }

    private func persistMutationQueue(_ queue: [NativeSyncV2Mutation]) throws {
        guard let ownerScope else { return }
        try secureStore.setData(
            JSONEncoder().encode(queue),
            forKey: mutationQueueKey(ownerScope: ownerScope)
        )
    }
}
