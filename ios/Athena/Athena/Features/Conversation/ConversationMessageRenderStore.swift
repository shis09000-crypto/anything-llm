import Observation

@MainActor
@Observable
final class ConversationMessageRenderStore: Identifiable {
    let id: String
    let role: AthenaChatMessage.Role
    private(set) var message: AthenaChatMessage
    private(set) var chatID: Int?
    private(set) var deliveryState: AthenaChatMessage.DeliveryState?
    private(set) var isLastConfirmedAssistant: Bool

    init(
        message: AthenaChatMessage,
        isLastConfirmedAssistant: Bool
    ) {
        id = message.id
        role = message.role
        self.message = message
        chatID = message.chatID
        deliveryState = message.deliveryState
        self.isLastConfirmedAssistant = isLastConfirmedAssistant
    }

    func update(
        message: AthenaChatMessage,
        isLastConfirmedAssistant: Bool
    ) {
        if self.message != message {
            self.message = message
        }
        if chatID != message.chatID {
            chatID = message.chatID
        }
        if deliveryState != message.deliveryState {
            deliveryState = message.deliveryState
        }
        if self.isLastConfirmedAssistant != isLastConfirmedAssistant {
            self.isLastConfirmedAssistant = isLastConfirmedAssistant
        }
    }
}
