import Foundation

struct MarkdownRenderCacheStatistics: Equatable, Sendable {
    let entryCount: Int
    let hitCount: Int
    let missCount: Int
    let parseCount: Int
}

final class MarkdownRenderCache: @unchecked Sendable {
    static let shared = MarkdownRenderCache()

    private struct Entry {
        let source: String
        let blocks: [AthenaMarkdownBlock]
        var accessOrder: UInt64
    }

    private struct Pending {
        let source: String
        let task: Task<[AthenaMarkdownBlock], Never>
    }

    private let lock = NSLock()
    private let capacity: Int
    private var entries: [String: Entry] = [:]
    private var pending: [String: Pending] = [:]
    private var accessOrder: UInt64 = 0
    private var hitCount = 0
    private var missCount = 0
    private var parseCount = 0

    init(capacity: Int = 80) {
        self.capacity = max(capacity, 1)
    }

    func cachedBlocks(
        for key: String,
        source: String
    ) -> [AthenaMarkdownBlock]? {
        lock.lock()
        defer { lock.unlock() }
        guard var entry = entries[key], entry.source == source else {
            missCount += 1
            return nil
        }
        accessOrder &+= 1
        entry.accessOrder = accessOrder
        entries[key] = entry
        hitCount += 1
        return entry.blocks
    }

    func blocks(
        for key: String,
        source: String
    ) async -> [AthenaMarkdownBlock] {
        if let cached = cachedBlocks(for: key, source: source) {
            return cached
        }

        let task = parsingTask(for: key, source: source)
        let rendered = await task.value
        store(rendered, for: key, source: source)
        return rendered
    }

    private func parsingTask(
        for key: String,
        source: String
    ) -> Task<[AthenaMarkdownBlock], Never> {
        lock.lock()
        defer { lock.unlock() }
        if let existing = pending[key], existing.source == source {
            return existing.task
        }
        parseCount += 1
        let task = Task.detached(priority: .userInitiated) {
            AthenaMarkdownDocumentParser.parse(source)
        }
        pending[key] = Pending(source: source, task: task)
        return task
    }

    private func store(
        _ rendered: [AthenaMarkdownBlock],
        for key: String,
        source: String
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard pending[key]?.source == source else { return }
        pending[key] = nil
        accessOrder &+= 1
        entries[key] = Entry(
            source: source,
            blocks: rendered,
            accessOrder: accessOrder
        )
        trimIfNeeded()
    }

    func prewarm(_ messages: some Sequence<AthenaChatMessage>) async {
        await withTaskGroup(of: Void.self) { group in
            var activeTasks = 0
            for message in messages where message.deliveryState != .streaming {
                if activeTasks >= 4 {
                    await group.next()
                    activeTasks -= 1
                }
                activeTasks += 1
                group.addTask { [self] in
                    _ = await blocks(for: message.id, source: message.text)
                }
            }
            while activeTasks > 0 {
                await group.next()
                activeTasks -= 1
            }
        }
    }

    func clear() {
        lock.lock()
        entries.removeAll(keepingCapacity: false)
        pending.values.forEach { $0.task.cancel() }
        pending.removeAll(keepingCapacity: false)
        accessOrder = 0
        hitCount = 0
        missCount = 0
        parseCount = 0
        lock.unlock()
    }

    func statistics() -> MarkdownRenderCacheStatistics {
        lock.lock()
        defer { lock.unlock() }
        return MarkdownRenderCacheStatistics(
            entryCount: entries.count,
            hitCount: hitCount,
            missCount: missCount,
            parseCount: parseCount
        )
    }

    private func trimIfNeeded() {
        while entries.count > capacity,
              let oldestKey = entries.min(by: {
                  $0.value.accessOrder < $1.value.accessOrder
              })?.key {
            entries.removeValue(forKey: oldestKey)
        }
    }
}
