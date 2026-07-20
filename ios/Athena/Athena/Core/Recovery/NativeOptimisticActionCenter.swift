import Foundation
import Observation

enum NativeOptimisticActionType: String, Codable, Sendable {
    case createWorkspace
    case createThread
    case renameWorkspace
    case renameThread
    case deleteWorkspace
    case deleteThread
    case updateThreadModel
    case updateProviderSettings
    case sendChat
    case editChat
    case regenerateChat
    case forkChat
    case deleteChat
}

enum NativeOptimisticActionStatus: String, Codable, Sendable {
    case pending
    case confirming
    case reconciling
    case confirmed
    case rolledBack
    case failed
}

struct NativeOptimisticActionSnapshot: Identifiable, Codable, Equatable, Sendable {
    let id: String
    let type: NativeOptimisticActionType
    let scope: AthenaTaskScope
    var status: NativeOptimisticActionStatus
    var taskID: String?
    let createdAt: Date
    var updatedAt: Date
}

@MainActor
@Observable
final class NativeOptimisticActionCenter {
    private(set) var actions: [String: NativeOptimisticActionSnapshot] = [:]

    @discardableResult
    func begin(
        id: String,
        type: NativeOptimisticActionType,
        scope: AthenaTaskScope,
        taskID: String? = nil
    ) -> NativeOptimisticActionSnapshot {
        if let existing = actions[id] { return existing }
        let now = Date()
        let action = NativeOptimisticActionSnapshot(
            id: id,
            type: type,
            scope: scope,
            status: .pending,
            taskID: taskID,
            createdAt: now,
            updatedAt: now
        )
        actions[id] = action
        return action
    }

    func update(_ id: String, status: NativeOptimisticActionStatus, taskID: String? = nil) {
        guard var action = actions[id], !action.status.isTerminal else { return }
        action.status = status
        if let taskID { action.taskID = taskID }
        action.updatedAt = Date()
        actions[id] = action
    }

    func confirm(_ id: String) {
        update(id, status: .confirmed)
    }

    func rollBack(_ id: String) {
        update(id, status: .rolledBack)
    }

    func fail(_ id: String) {
        update(id, status: .failed)
    }

    func action(for id: String) -> NativeOptimisticActionSnapshot? {
        actions[id]
    }

    func isActive(_ id: String?) -> Bool {
        guard let id, let action = actions[id] else { return false }
        switch action.status {
        case .pending, .confirming, .reconciling:
            return true
        case .confirmed, .rolledBack, .failed:
            return false
        }
    }

    func requiresReconciliation(_ id: String?) -> Bool {
        guard let id, let action = actions[id] else { return false }
        return action.status == .reconciling
    }

    func clear(ownerScope: String) {
        actions = actions.filter { $0.value.scope.owner != ownerScope }
    }

    func clearAll() {
        actions.removeAll()
    }
}

private extension NativeOptimisticActionStatus {
    var isTerminal: Bool {
        switch self {
        case .confirmed, .rolledBack, .failed:
            true
        case .pending, .confirming, .reconciling:
            false
        }
    }
}
