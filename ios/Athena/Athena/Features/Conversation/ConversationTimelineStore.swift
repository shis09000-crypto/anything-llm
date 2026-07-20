import Observation
import SwiftUI

@MainActor
@Observable
final class ConversationTimelineStore<Content: View> {
    private(set) var content: Content
    private(set) var revision: UInt64 = 0

    init(content: Content) {
        self.content = content
    }

    func update(content: Content) {
        self.content = content
        revision &+= 1
    }
}

struct ConversationTimelineHostingRoot<Content: View>: View {
    @State private var store: ConversationTimelineStore<Content>

    init(store: ConversationTimelineStore<Content>) {
        _store = State(initialValue: store)
    }

    var body: some View {
        store.content
    }
}
