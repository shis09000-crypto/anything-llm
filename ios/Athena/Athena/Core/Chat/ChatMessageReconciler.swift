import Foundation

enum ChatMessageReconciler {
    static func prepend(
        older: [AthenaChatMessage],
        current: [AthenaChatMessage]
    ) -> [AthenaChatMessage] {
        canonical(deduplicating: older + current)
    }

    static func mergeAuthoritative(
        _ authoritative: [AthenaChatMessage],
        current: [AthenaChatMessage]
    ) -> [AthenaChatMessage] {
        let confirmedTurns = Set(authoritative.compactMap(\.clientTurnID))
        let pendingOverlay = current.filter { message in
            guard message.deliveryState != .confirmed else { return false }
            guard let clientTurnID = message.clientTurnID else { return true }
            return !confirmedTurns.contains(clientTurnID)
        }
        return canonical(deduplicating: authoritative + pendingOverlay)
    }

    static func canonical(
        deduplicating messages: [AthenaChatMessage]
    ) -> [AthenaChatMessage] {
        var seen: Set<String> = []
        return messages
            .filter { seen.insert(identityKey($0)).inserted }
            .sorted(by: isOrderedBefore)
    }

    private static func isOrderedBefore(
        _ lhs: AthenaChatMessage,
        _ rhs: AthenaChatMessage
    ) -> Bool {
        if let left = lhs.chatID, let right = rhs.chatID {
            if left != right { return left < right }
            if lhs.role != rhs.role { return lhs.role == .user }
        } else if lhs.chatID != nil {
            return true
        } else if rhs.chatID != nil {
            return false
        }

        let leftTime = lhs.sentAt ?? 0
        let rightTime = rhs.sentAt ?? 0
        if leftTime != rightTime { return leftTime < rightTime }
        if lhs.role != rhs.role { return lhs.role == .user }
        return lhs.id < rhs.id
    }

    private static func identityKey(_ message: AthenaChatMessage) -> String {
        if let chatID = message.chatID {
            return "chat:\(chatID):\(message.role.rawValue)"
        }
        if let publicChatID = message.publicChatID {
            return "public:\(publicChatID):\(message.role.rawValue)"
        }
        if let clientTurnID = message.clientTurnID {
            return "client:\(clientTurnID):\(message.role.rawValue)"
        }
        return message.id
    }
}
