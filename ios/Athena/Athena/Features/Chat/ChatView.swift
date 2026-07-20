import SwiftUI

struct ChatMessage: Identifiable, Hashable {
    enum Role {
        case user
        case assistant
    }

    let id: String
    let role: Role
    let text: String
}

struct ChatView: View {
    let workspaceID: String?
    let threadID: String?
    @State private var draft = ""
    @Environment(AppDependencies.self) private var dependencies

    init(workspaceID: String? = nil, threadID: String? = nil) {
        self.workspaceID = workspaceID
        self.threadID = threadID
    }

    var body: some View {
        ZStack {
            AthenaScreenBackground()
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: AthenaSpacing.md) {
                        ChatContextHeader(workspaceID: workspaceID, threadID: threadID)
                        ForEach(PreviewData.messages) { message in
                            ChatBubble(message: message)
                        }
                        TransportStateStrip()
                    }
                    .padding(AthenaSpacing.md)
                    .padding(.bottom, AthenaSpacing.sm)
                }
                .scrollIndicators(.hidden)

                ChatComposer(draft: $draft)
            }
        }
        .navigationTitle(threadID ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ChatContextHeader: View {
    let workspaceID: String?
    let threadID: String?

    var body: some View {
        AthenaPanel {
            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(workspaceID ?? "Athena")
                            .font(.headline)
                        Text(threadID ?? "Current thread")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(title: "Native", systemImage: "iphone", tint: .green)
                }

                HStack(spacing: AthenaSpacing.sm) {
                    StatusPill(title: "SSE adapter", systemImage: "wave.3.right", tint: .orange)
                    StatusPill(title: "Composer local", systemImage: "keyboard", tint: .blue)
                }
            }
        }
    }
}

private struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user {
                Spacer(minLength: 42)
            }

            bubble

            if message.role == .assistant {
                Spacer(minLength: 42)
            }
        }
    }

    @ViewBuilder
    private var bubble: some View {
        let shape = RoundedRectangle(cornerRadius: AthenaRadius.lg, style: .continuous)
        if message.role == .user {
            Text(message.text)
                .font(.body)
                .padding(.horizontal, AthenaSpacing.md)
                .padding(.vertical, AthenaSpacing.sm)
                .foregroundStyle(Color.white)
                .background(Color.accentColor, in: shape)
        } else {
            Text(message.text)
                .font(.body)
                .padding(.horizontal, AthenaSpacing.md)
                .padding(.vertical, AthenaSpacing.sm)
                .foregroundStyle(Color.primary)
                .athenaGlass(in: shape, interactive: false)
        }
    }
}

private struct TransportStateStrip: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaPanel {
            HStack(spacing: AthenaSpacing.sm) {
                AthenaIconTile(systemImage: "antenna.radiowaves.left.and.right", tint: .blue)
                VStack(alignment: .leading, spacing: AthenaSpacing.xs) {
                    Text("Realtime")
                        .font(.subheadline.weight(.semibold))
                    Text("SSE, Agent WS, and Broadcast WS adapters are staged behind native clients.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: AthenaSpacing.sm) {
                StatusPill(title: "SSE staged", systemImage: "wave.3.right", tint: .orange)
                StatusPill(
                    title: dependencies.realtimeBroadcastClient.durableReplayAvailable ? "Durable broadcast" : "Memory broadcast",
                    systemImage: "antenna.radiowaves.left.and.right",
                    tint: .blue
                )
            }
            .padding(.top, AthenaSpacing.sm)
        }
    }
}

private struct ChatComposer: View {
    @Binding var draft: String

    var body: some View {
        HStack(spacing: AthenaSpacing.sm) {
            TextField("Message", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(.horizontal, AthenaSpacing.md)
                .padding(.vertical, AthenaSpacing.sm)
                .athenaGlass(in: RoundedRectangle(cornerRadius: AthenaRadius.lg, style: .continuous), interactive: true)

            Button {
                draft = ""
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
            .athenaGlassButton(prominent: true)
        }
        .padding(AthenaSpacing.md)
        .background(.bar)
    }
}

struct ChatView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            ChatView(workspaceID: "athena", threadID: "mobile-scaffold")
        }
        .environment(AppDependencies.preview())
    }
}
