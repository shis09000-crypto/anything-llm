import CoreGraphics

enum MessageActionKind: String, CaseIterable, Hashable {
    case copy
    case edit
    case speech
    case regenerate
    case fork
    case delete
}

struct MessageActionCapabilities: Equatable {
    let visibleActions: [MessageActionKind]
    let enabledActions: Set<MessageActionKind>

    func isEnabled(_ action: MessageActionKind) -> Bool {
        enabledActions.contains(action)
    }

    static func user(isConfirmed: Bool, canEdit: Bool) -> Self {
        Self(
            visibleActions: [.copy, .edit],
            enabledActions: isConfirmed && canEdit ? [.copy, .edit] : [.copy]
        )
    }

    static func assistant(
        isConfirmed: Bool,
        isLastConfirmedAssistant: Bool,
        hasStableServerIdentity: Bool,
        canRegenerate: Bool,
        canFork: Bool,
        canDelete: Bool
    ) -> Self {
        guard isConfirmed else {
            return Self(visibleActions: [], enabledActions: [])
        }
        var enabledActions: Set<MessageActionKind> = [.copy, .speech]
        if isLastConfirmedAssistant && canRegenerate {
            enabledActions.insert(.regenerate)
        }
        if hasStableServerIdentity && canFork {
            enabledActions.insert(.fork)
        }
        if hasStableServerIdentity && canDelete {
            enabledActions.insert(.delete)
        }
        return Self(
            visibleActions: [.copy, .speech, .regenerate, .fork, .delete],
            enabledActions: enabledActions
        )
    }
}

struct ComposerLayoutPolicy {
    static let bottomContentSpacing: CGFloat = 12
    static let defaultBottomContentClearance: CGFloat = 52 + bottomContentSpacing

    static func bottomContentClearance(
        composerHeight: CGFloat,
        bottomGap: CGFloat
    ) -> CGFloat {
        max(
            defaultBottomContentClearance,
            composerHeight + max(bottomGap, 0) + bottomContentSpacing
        )
    }

    static func shouldExpand(
        hasText: Bool,
        containsExplicitLineBreak: Bool,
        hasMarkedText: Bool,
        compactMeasuredHeight: CGFloat,
        compactTextHeight: CGFloat,
        editingMessage: Bool,
        wasExpanded: Bool
    ) -> Bool {
        if editingMessage {
            return true
        }
        guard hasText else { return false }
        if containsExplicitLineBreak {
            return true
        }
        if hasMarkedText, wasExpanded {
            return true
        }
        return ceil(compactMeasuredHeight) > ceil(compactTextHeight)
    }
}

struct ConversationKeyboardLayoutPolicy {
    static func keyboardIsFullyDismissed(
        keyboardTop: CGFloat,
        viewportBottom: CGFloat
    ) -> Bool {
        keyboardTop >= viewportBottom - 1
    }
}

struct UserMessageBubbleWidthPolicy {
    static func maximumWidth(
        rowWidth: CGFloat,
        maximumContentFraction: CGFloat
    ) -> CGFloat {
        min(max(rowWidth, 0), max(rowWidth, 0) * maximumContentFraction)
    }

    static func fittedWidth(idealWidth: CGFloat, maximumWidth: CGFloat) -> CGFloat {
        guard idealWidth.isFinite, idealWidth > 0 else {
            return maximumWidth
        }
        return min(idealWidth, maximumWidth)
    }
}
