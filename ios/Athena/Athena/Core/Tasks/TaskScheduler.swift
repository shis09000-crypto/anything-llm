import Foundation

enum AthenaTaskPriority: Int, Codable, CaseIterable, Comparable, Sendable {
    case p0 = 0
    case p1 = 1
    case p2 = 2
    case p3 = 3
    case p4 = 4

    static func < (lhs: AthenaTaskPriority, rhs: AthenaTaskPriority) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

enum AthenaTaskPolicy: String, Codable, Sendable {
    case foreground
    case visible
    case background
    case prefetch
    case maintenance
    case realtime
}

enum AthenaTaskResource: String, Codable, Sendable {
    case network
    case realtime
    case upload
    case render
    case cpu
    case idle
}

enum AthenaTaskExecutionClass: String, Codable, Sendable {
    case security
    case interactiveMutation
    case currentContent
    case synchronization
    case navigation
    case standard

    fileprivate var queueRank: Int {
        switch self {
        case .security:
            0
        case .interactiveMutation:
            1
        case .currentContent:
            2
        case .synchronization:
            3
        case .navigation:
            4
        case .standard:
            5
        }
    }
}

struct AthenaTaskScope: Codable, Equatable, Hashable, Sendable {
    var owner: String?
    var route: String?
    var surface: String?
    var workspaceID: String?
    var threadID: String?
    var transport: String?

    init(
        owner: String? = nil,
        route: String? = nil,
        surface: String? = nil,
        workspaceID: String? = nil,
        threadID: String? = nil,
        transport: String? = nil
    ) {
        self.owner = owner
        self.route = route
        self.surface = surface
        self.workspaceID = workspaceID
        self.threadID = threadID
        self.transport = transport
    }

    func matches(_ query: AthenaTaskScope) -> Bool {
        Self.fields.allSatisfy { keyPath in
            guard let expected = query[keyPath: keyPath] else {
                return true
            }
            return self[keyPath: keyPath] == expected
        }
    }

    private static let fields: [KeyPath<AthenaTaskScope, String?>] = [
        \.owner,
        \.route,
        \.surface,
        \.workspaceID,
        \.threadID,
        \.transport,
    ]
}

struct AthenaTaskDescriptor: Sendable {
    var id: String?
    var label: String
    var kind: String
    var priority: AthenaTaskPriority
    var intentRank: Int
    var executionClass: AthenaTaskExecutionClass
    var policy: AthenaTaskPolicy
    var resource: AthenaTaskResource
    var scope: AthenaTaskScope
    var dedupeKey: String?
    var isProtected: Bool
    var isAbortable: Bool

    init(
        id: String? = nil,
        label: String,
        kind: String = "request",
        priority: AthenaTaskPriority = .p2,
        intentRank: Int = 50,
        executionClass: AthenaTaskExecutionClass = .standard,
        policy: AthenaTaskPolicy? = nil,
        resource: AthenaTaskResource = .network,
        scope: AthenaTaskScope = AthenaTaskScope(),
        dedupeKey: String? = nil,
        isProtected: Bool = false,
        isAbortable: Bool = true
    ) {
        self.id = id
        self.label = label
        self.kind = kind
        self.priority = priority
        self.intentRank = min(max(intentRank, 0), 999)
        self.executionClass = executionClass
        self.policy = policy ?? Self.defaultPolicy(for: priority)
        self.resource = resource
        self.scope = scope
        self.dedupeKey = dedupeKey
        self.isProtected = isProtected
        self.isAbortable = isAbortable
    }

    private static func defaultPolicy(for priority: AthenaTaskPriority) -> AthenaTaskPolicy {
        switch priority {
        case .p0:
            .foreground
        case .p1:
            .visible
        case .p2:
            .background
        case .p3:
            .prefetch
        case .p4:
            .maintenance
        }
    }
}

enum AthenaTaskStatus: String, Codable, Sendable {
    case pending
    case running
    case completed
    case failed
    case aborted
    case stale
}

struct AthenaTaskSnapshotEntry: Codable, Equatable, Sendable {
    let id: String
    let label: String
    let kind: String
    let priority: AthenaTaskPriority
    let intentRank: Int
    let executionClass: AthenaTaskExecutionClass
    let policy: AthenaTaskPolicy
    let resource: AthenaTaskResource
    let scope: AthenaTaskScope
    let status: AthenaTaskStatus
    let isProtected: Bool
    let isAbortable: Bool
    let ageMilliseconds: Int
}

struct AthenaTaskSchedulerSnapshot: Codable, Equatable, Sendable {
    let pending: [AthenaTaskSnapshotEntry]
    let running: [AthenaTaskSnapshotEntry]
    let recent: [AthenaTaskSnapshotEntry]
    let pausedPriorities: [AthenaTaskPriority]
}

enum AthenaTaskSchedulerError: LocalizedError, Equatable {
    case cancelled
    case stale
    case pendingBudgetExceeded
    case dedupeTypeMismatch(String)

    var errorDescription: String? {
        switch self {
        case .cancelled:
            "The task was cancelled."
        case .stale:
            "The task was superseded by newer state."
        case .pendingBudgetExceeded:
            "The task queue is full."
        case .dedupeTypeMismatch(let key):
            "The deduplicated task output type does not match for \(key)."
        }
    }
}

struct AthenaTaskExecutionContext: Sendable {
    let id: String
    let descriptor: AthenaTaskDescriptor

    func checkCancellation() throws {
        try Task.checkCancellation()
    }
}

final class ScheduledTaskHandle<Value: Sendable>: @unchecked Sendable {
    let id: String
    private let task: Task<Value, Error>
    private let scheduler: TaskScheduler

    fileprivate init(id: String, task: Task<Value, Error>, scheduler: TaskScheduler) {
        self.id = id
        self.task = task
        self.scheduler = scheduler
    }

    var value: Value {
        get async throws {
            try await task.value
        }
    }

    func cancel() {
        task.cancel()
        Task {
            await scheduler.cancelTask(id: id, reason: "handle-cancel")
        }
    }

    func markStale(reason: String = "manual-stale") {
        Task {
            await scheduler.markTaskStale(id: id, reason: reason)
        }
    }

    func isCurrent() async -> Bool {
        await scheduler.isCurrent(id: id)
    }
}

actor TaskScheduler {
    struct Configuration: Sendable {
        var foregroundLimit = 3
        var interactiveMutationLimit = 1
        var backgroundLimit = 1
        var prefetchLimit = 1
        var networkLimit = 4
        var uploadLimit = 1
        var renderLimit = 2
        var cpuLimit = 2
        var idleLimit = 1
        var maxPending = 64
        var staleInterval: TimeInterval = 45
    }

    private enum Lane {
        case interactiveMutation
        case foreground
        case background
        case prefetch
    }

    private final class Record {
        let id: String
        let descriptor: AthenaTaskDescriptor
        let createdAt: Date
        let gate: TaskStartGate
        let outputTypeName: String
        let handle: Any
        let cancelOperation: @Sendable () -> Void
        var status: AthenaTaskStatus = .pending
        var startedAt: Date?

        init(
            id: String,
            descriptor: AthenaTaskDescriptor,
            gate: TaskStartGate,
            outputTypeName: String,
            handle: Any,
            cancelOperation: @escaping @Sendable () -> Void
        ) {
            self.id = id
            self.descriptor = descriptor
            self.createdAt = Date()
            self.gate = gate
            self.outputTypeName = outputTypeName
            self.handle = handle
            self.cancelOperation = cancelOperation
        }
    }

    private let configuration: Configuration
    private var records: [String: Record] = [:]
    private var pendingIDs: [String] = []
    private var runningIDs: Set<String> = []
    private var dedupeIDs: [String: String] = [:]
    private var recent: [AthenaTaskSnapshotEntry] = []
    private var pausedPriorities: Set<AthenaTaskPriority> = []
    private var pauseReasons: [AthenaTaskPriority: Set<String>] = [:]

    init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    func schedule<Value: Sendable>(
        _ descriptor: AthenaTaskDescriptor,
        operation: @escaping @Sendable (AthenaTaskExecutionContext) async throws -> Value
    ) throws -> ScheduledTaskHandle<Value> {
        pruneStalePending()

        if let dedupeKey = descriptor.dedupeKey,
           let existingID = dedupeIDs[dedupeKey],
           let existing = records[existingID]
        {
            guard let handle = existing.handle as? ScheduledTaskHandle<Value> else {
                throw AthenaTaskSchedulerError.dedupeTypeMismatch(dedupeKey)
            }
            return handle
        }

        guard pendingIDs.count < configuration.maxPending else {
            throw AthenaTaskSchedulerError.pendingBudgetExceeded
        }

        let id = descriptor.id ?? "\(descriptor.kind):\(UUID().uuidString.lowercased())"
        let gate = TaskStartGate()
        let scheduler = self
        let task = Task.detached(priority: descriptor.priority.swiftPriority) {
            do {
                try await gate.wait()
                try Task.checkCancellation()
                let context = AthenaTaskExecutionContext(id: id, descriptor: descriptor)
                let value = try await operation(context)
                guard await scheduler.completeIfCurrent(id: id) else {
                    throw AthenaTaskSchedulerError.stale
                }
                return value
            } catch {
                await scheduler.finishFailure(id: id, error: error)
                throw error
            }
        }
        let handle = ScheduledTaskHandle(id: id, task: task, scheduler: self)
        let record = Record(
            id: id,
            descriptor: descriptor,
            gate: gate,
            outputTypeName: String(reflecting: Value.self),
            handle: handle,
            cancelOperation: { task.cancel() }
        )
        records[id] = record
        pendingIDs.append(id)
#if DEBUG
        debugTask("scheduled", record: record)
#endif
        if let dedupeKey = descriptor.dedupeKey {
            dedupeIDs[dedupeKey] = id
        }
        sortPending()
        if descriptor.priority == .p0 || descriptor.executionClass == .interactiveMutation {
            preemptLowerPriorityIfNeeded(for: record)
        }
        flush()
        return handle
    }

    func run<Value: Sendable>(
        _ descriptor: AthenaTaskDescriptor,
        operation: @escaping @Sendable (AthenaTaskExecutionContext) async throws -> Value
    ) async throws -> Value {
        let handle = try schedule(descriptor, operation: operation)
        return try await withTaskCancellationHandler {
            try await handle.value
        } onCancel: {
            handle.cancel()
        }
    }

    @discardableResult
    func cancelScope(
        _ scope: AthenaTaskScope,
        includeProtected: Bool = false,
        reason: String = "scope-cancel"
    ) -> Int {
        let ids = records.values
            .filter { $0.descriptor.scope.matches(scope) }
            .filter { includeProtected || !$0.descriptor.isProtected }
            .map(\.id)
        for id in ids {
            cancelRecord(id: id, status: .aborted, error: .cancelled)
        }
        flush()
        return ids.count
    }

    @discardableResult
    func markScopeStale(
        _ scope: AthenaTaskScope,
        reason: String = "scope-stale"
    ) -> Int {
        let ids = records.values
            .filter { $0.descriptor.scope.matches(scope) }
            .map(\.id)
        for id in ids {
            cancelRecord(id: id, status: .stale, error: .stale)
        }
        flush()
        return ids.count
    }

    func cancelAll(reason: String = "cancel-all") {
        let ids = Array(records.keys)
        for id in ids {
            cancelRecord(id: id, status: .aborted, error: .cancelled)
        }
        flush()
    }

    func setPaused(
        _ priority: AthenaTaskPriority,
        paused: Bool,
        reason: String = "default"
    ) {
        if paused {
            pauseReasons[priority, default: []].insert(reason)
        } else {
            pauseReasons[priority]?.remove(reason)
            if pauseReasons[priority]?.isEmpty == true {
                pauseReasons[priority] = nil
            }
        }
        pausedPriorities = Set(pauseReasons.keys)
        flush()
    }

    func snapshot() -> AthenaTaskSchedulerSnapshot {
        AthenaTaskSchedulerSnapshot(
            pending: pendingIDs.compactMap { records[$0].map(snapshotEntry) },
            running: runningIDs.compactMap { records[$0].map(snapshotEntry) },
            recent: recent,
            pausedPriorities: pausedPriorities.sorted()
        )
    }

    fileprivate func cancelTask(id: String, reason: String) {
        cancelRecord(id: id, status: .aborted, error: .cancelled)
        flush()
    }

    fileprivate func markTaskStale(id: String, reason: String) {
        cancelRecord(id: id, status: .stale, error: .stale)
        flush()
    }

    fileprivate func isCurrent(id: String) -> Bool {
        guard let record = records[id] else {
            return false
        }
        return record.status == .pending || record.status == .running
    }

    private func completeIfCurrent(id: String) -> Bool {
        guard let record = records[id], record.status == .running else {
            return false
        }
        finish(record: record, status: .completed)
        flush()
        return true
    }

    private func finishFailure(id: String, error: Error) {
        guard let record = records[id] else {
            return
        }
        let status: AthenaTaskStatus
        if error is CancellationError || error as? AthenaTaskSchedulerError == .cancelled {
            status = .aborted
        } else if error as? AthenaTaskSchedulerError == .stale {
            status = .stale
        } else {
            status = .failed
        }
        finish(record: record, status: status)
        flush()
    }

    private func flush() {
        pruneStalePending()
        sortPending()
        var started = true
        while started {
            started = false
            guard let index = pendingIDs.firstIndex(where: { id in
                records[id].map(canStart) == true
            }) else {
                break
            }
            let id = pendingIDs.remove(at: index)
            guard let record = records[id] else {
                continue
            }
            record.status = .running
            record.startedAt = Date()
            runningIDs.insert(id)
#if DEBUG
            debugTask("started", record: record)
#endif
            Task {
                await record.gate.start()
            }
            started = true
        }
    }

    private func canStart(_ record: Record) -> Bool {
        let descriptor = record.descriptor
        guard !pausedPriorities.contains(descriptor.priority) else {
            return false
        }
        guard resourceCount(descriptor.resource) < resourceLimit(descriptor.resource) else {
            return false
        }
        guard descriptor.resource == .network else {
            return true
        }
        if descriptor.executionClass == .interactiveMutation {
            guard interactiveMutationLimit > 0 else {
                return standardNetworkCount() < standardNetworkLimit
            }
            return laneCount(.interactiveMutation) < interactiveMutationLimit
        }
        guard standardNetworkCount() < standardNetworkLimit else {
            return false
        }
        switch lane(for: descriptor) {
        case .interactiveMutation:
            return false
        case .foreground:
            return laneCount(.foreground) < configuration.foregroundLimit
        case .background:
            return laneCount(.background) < configuration.backgroundLimit
        case .prefetch:
            return laneCount(.prefetch) < configuration.prefetchLimit
        }
    }

    private func preemptLowerPriorityIfNeeded(for next: Record) {
        while !canStart(next) {
            let candidate = runningIDs
                .compactMap { records[$0] }
                .filter { record in
                    shouldPreempt(record, for: next)
                        && record.descriptor.isAbortable
                        && !record.descriptor.isProtected
                        && (record.descriptor.resource == next.descriptor.resource
                            || next.descriptor.resource == .network)
                }
                .sorted { lhs, rhs in
                    if lhs.descriptor.priority != rhs.descriptor.priority {
                        return lhs.descriptor.priority > rhs.descriptor.priority
                    }
                    return lhs.createdAt < rhs.createdAt
                }
                .first
            guard let candidate else {
                return
            }
            cancelRecord(id: candidate.id, status: .aborted, error: .cancelled)
        }
    }

    private func cancelRecord(
        id: String,
        status: AthenaTaskStatus,
        error: AthenaTaskSchedulerError
    ) {
        guard let record = records[id] else {
            return
        }
        record.status = status
        pendingIDs.removeAll { $0 == id }
        runningIDs.remove(id)
        removeDedupe(for: record)
        records.removeValue(forKey: id)
#if DEBUG
        debugTask("cancelled", record: record)
#endif
        record.cancelOperation()
        Task {
            await record.gate.fail(error)
        }
        appendRecent(snapshotEntry(record))
    }

    private func finish(record: Record, status: AthenaTaskStatus) {
        record.status = status
        pendingIDs.removeAll { $0 == record.id }
        runningIDs.remove(record.id)
        removeDedupe(for: record)
        records.removeValue(forKey: record.id)
#if DEBUG
        debugTask("\(status.rawValue)", record: record)
#endif
        appendRecent(snapshotEntry(record))
    }

    private func removeDedupe(for record: Record) {
        guard let key = record.descriptor.dedupeKey,
              dedupeIDs[key] == record.id else {
            return
        }
        dedupeIDs.removeValue(forKey: key)
    }

    private func sortPending() {
        pendingIDs.sort { lhsID, rhsID in
            guard let lhs = records[lhsID], let rhs = records[rhsID] else {
                return lhsID < rhsID
            }
            if lhs.descriptor.priority != rhs.descriptor.priority {
                return lhs.descriptor.priority < rhs.descriptor.priority
            }
            if lhs.descriptor.executionClass != rhs.descriptor.executionClass {
                return lhs.descriptor.executionClass.queueRank
                    < rhs.descriptor.executionClass.queueRank
            }
            if lhs.descriptor.intentRank != rhs.descriptor.intentRank {
                return lhs.descriptor.intentRank < rhs.descriptor.intentRank
            }
            return lhs.createdAt < rhs.createdAt
        }
    }

    private func pruneStalePending() {
        let cutoff = Date().addingTimeInterval(-configuration.staleInterval)
        let ids = pendingIDs.filter { id in
            guard let record = records[id] else {
                return false
            }
            return record.descriptor.priority >= .p3 && record.createdAt < cutoff
        }
        for id in ids {
            cancelRecord(id: id, status: .stale, error: .stale)
        }
    }

    private func lane(for descriptor: AthenaTaskDescriptor) -> Lane {
        if descriptor.executionClass == .interactiveMutation {
            return .interactiveMutation
        }
        switch descriptor.priority {
        case .p0, .p1:
            return .foreground
        case .p2, .p4:
            return .background
        case .p3:
            return .prefetch
        }
    }

    private func laneCount(_ lane: Lane) -> Int {
        runningIDs.compactMap { records[$0] }.filter {
            $0.descriptor.resource == .network
                && self.lane(for: $0.descriptor) == lane
        }.count
    }

    private var interactiveMutationLimit: Int {
        guard configuration.networkLimit > 1 else { return 0 }
        return min(max(configuration.interactiveMutationLimit, 0), configuration.networkLimit - 1)
    }

    private var standardNetworkLimit: Int {
        max(1, configuration.networkLimit - interactiveMutationLimit)
    }

    private func standardNetworkCount() -> Int {
        runningIDs.compactMap { records[$0] }.filter {
            $0.descriptor.resource == .network
                && $0.descriptor.executionClass != .interactiveMutation
        }.count
    }

    private func shouldPreempt(_ candidate: Record, for next: Record) -> Bool {
        if candidate.descriptor.priority > next.descriptor.priority {
            return true
        }
        return next.descriptor.executionClass == .interactiveMutation
            && candidate.descriptor.priority == next.descriptor.priority
            && candidate.descriptor.executionClass != .security
            && candidate.descriptor.executionClass != .interactiveMutation
    }

    private func resourceCount(_ resource: AthenaTaskResource) -> Int {
        runningIDs.compactMap { records[$0] }.filter {
            $0.descriptor.resource == resource
        }.count
    }

    private func resourceLimit(_ resource: AthenaTaskResource) -> Int {
        switch resource {
        case .network:
            configuration.networkLimit
        case .realtime:
            .max
        case .upload:
            configuration.uploadLimit
        case .render:
            configuration.renderLimit
        case .cpu:
            configuration.cpuLimit
        case .idle:
            configuration.idleLimit
        }
    }

    private func snapshotEntry(_ record: Record) -> AthenaTaskSnapshotEntry {
        AthenaTaskSnapshotEntry(
            id: record.id,
            label: redactedSnapshotText(record.descriptor.label),
            kind: redactedSnapshotText(record.descriptor.kind),
            priority: record.descriptor.priority,
            intentRank: record.descriptor.intentRank,
            executionClass: record.descriptor.executionClass,
            policy: record.descriptor.policy,
            resource: record.descriptor.resource,
            scope: record.descriptor.scope,
            status: record.status,
            isProtected: record.descriptor.isProtected,
            isAbortable: record.descriptor.isAbortable,
            ageMilliseconds: max(0, Int(Date().timeIntervalSince(record.createdAt) * 1_000))
        )
    }

    private func appendRecent(_ entry: AthenaTaskSnapshotEntry) {
        recent.append(entry)
        if recent.count > 80 {
            recent.removeFirst(recent.count - 80)
        }
    }

    private func redactedSnapshotText(_ value: String) -> String {
        var result = value.replacingOccurrences(
            of: #"(?i)bearer\s+[a-z0-9._~+\-/]+=*"#,
            with: "Bearer [REDACTED]",
            options: .regularExpression
        )
        result = result.replacingOccurrences(
            of: #"(?i)(token|secret|signature|authorization|password)=([^&\s]+)"#,
            with: "$1=[REDACTED]",
            options: .regularExpression
        )
        return result
    }

#if DEBUG
    private func debugTask(_ event: String, record: Record) {
        let elapsed = Int(Date().timeIntervalSince(record.createdAt) * 1_000)
        print(
            "[AthenaScheduler] event=\(event) id=\(record.id) kind=\(redactedSnapshotText(record.descriptor.kind)) priority=\(record.descriptor.priority.rawValue) class=\(record.descriptor.executionClass.rawValue) elapsedMs=\(max(0, elapsed))"
        )
    }
#endif
}

private actor TaskStartGate {
    private enum State {
        case waiting
        case started
        case failed(Error)
    }

    private var state: State = .waiting
    private var continuation: CheckedContinuation<Void, Error>?

    func wait() async throws {
        switch state {
        case .started:
            return
        case .failed(let error):
            throw error
        case .waiting:
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
            }
        }
    }

    func start() {
        guard case .waiting = state else {
            return
        }
        state = .started
        continuation?.resume()
        continuation = nil
    }

    func fail(_ error: Error) {
        guard case .waiting = state else {
            return
        }
        state = .failed(error)
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private extension AthenaTaskPriority {
    var swiftPriority: TaskPriority {
        switch self {
        case .p0:
            .high
        case .p1:
            .userInitiated
        case .p2:
            .medium
        case .p3:
            .utility
        case .p4:
            .background
        }
    }
}
