import Foundation

@MainActor
final class ChatStreamDisplayBuffer {
    private struct PendingText {
        let id: String
        var text: String
        var replaces: Bool
        var closes: Bool
    }

    private let normalInterval: Duration
    private let interactionInterval: Duration
    private let sink: @MainActor (ChatStreamEvent) -> Void
    private var pendingByID: [String: PendingText] = [:]
    private var pendingOrder: [String] = []
    private var flushTask: Task<Void, Never>?
    private var interactionActive = false

    init(
        interval: Duration = .milliseconds(33),
        interactionInterval: Duration = .milliseconds(66),
        sink: @escaping @MainActor (ChatStreamEvent) -> Void
    ) {
        self.normalInterval = interval
        self.interactionInterval = interactionInterval
        self.sink = sink
    }

    func setInteractionActive(_ active: Bool) {
        guard interactionActive != active else { return }
        interactionActive = active
        guard !pendingOrder.isEmpty else { return }
        flushTask?.cancel()
        flushTask = nil
        scheduleFlushIfNeeded()
    }

    func submit(_ event: ChatStreamEvent) {
        guard case let .assistantText(id, text, replaces, closes) = event else {
            flush()
            sink(event)
            return
        }

        if var pending = pendingByID[id] {
            if replaces {
                pending.text = text
                pending.replaces = true
            } else {
                pending.text += text
            }
            pending.closes = pending.closes || closes
            pendingByID[id] = pending
        } else {
            pendingByID[id] = PendingText(
                id: id,
                text: text,
                replaces: replaces,
                closes: closes
            )
            pendingOrder.append(id)
        }

        if closes {
            flush()
        } else {
            scheduleFlushIfNeeded()
        }
    }

    func finish() {
        flush()
    }

    private func scheduleFlushIfNeeded() {
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            guard let self else { return }
            let interval = interactionActive ? interactionInterval : normalInterval
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            flush()
        }
    }

    private func flush() {
        flushTask?.cancel()
        flushTask = nil
        let order = pendingOrder
        let pending = pendingByID
        pendingOrder.removeAll(keepingCapacity: true)
        pendingByID.removeAll(keepingCapacity: true)
        for id in order {
            guard let item = pending[id], !item.text.isEmpty else { continue }
            sink(
                .assistantText(
                    id: item.id,
                    text: item.text,
                    replaces: item.replaces,
                    closes: item.closes
                )
            )
        }
    }
}
