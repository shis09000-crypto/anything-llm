import SwiftUI

struct WorkspaceSummary: Identifiable, Hashable {
    let id: String
    let name: String
    let subtitle: String
    let threads: [ThreadSummary]
}

struct ThreadSummary: Identifiable, Hashable {
    let id: String
    let title: String
    let lastMessage: String
}

struct WorkspaceView: View {
    @Environment(RouterPath.self) private var router
    @Environment(AppDependencies.self) private var dependencies
    private let workspaces = PreviewData.workspaces

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            WorkspaceStatusHeader()

            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                SectionHeader("Recent Workspaces", subtitle: "Threads staged for native chat, Reader, and Agent handoff")
                ForEach(workspaces) { workspace in
                    WorkspaceCard(workspace: workspace)
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    router.present(.apiBase)
                } label: {
                    Image(systemName: "network")
                }
                .accessibilityLabel("API Base")
                .athenaGlassButton()
            }
        }
    }
}

private struct WorkspaceStatusHeader: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaPanel {
            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Athena")
                            .font(.title2.weight(.bold))
                        Text("Pure SwiftUI client shell")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(title: dependencies.runtime.loadState.title, systemImage: "dot.radiowaves.left.and.right", tint: runtimeTint)
                }

                HStack(spacing: AthenaSpacing.sm) {
                    StatusPill(title: "iOS 26+", systemImage: "iphone", tint: .green)
                    StatusPill(title: dependencies.runtime.bootstrap?.protocolVersion ?? "Bootstrap", systemImage: "checklist.checked", tint: .blue)
                }
            }
        }
    }

    private var runtimeTint: Color {
        switch dependencies.runtime.loadState {
        case .loaded:
            .green
        case .failed:
            .red
        case .loading:
            .orange
        case .idle:
            .gray
        }
    }
}

private struct WorkspaceCard: View {
    @Environment(RouterPath.self) private var router
    let workspace: WorkspaceSummary

    var body: some View {
        AthenaPanel {
            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(workspace.name)
                            .font(.headline)
                        Text(workspace.subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(title: "\(workspace.threads.count)", systemImage: "number", tint: .blue)
                }

                VStack(spacing: AthenaSpacing.sm) {
                    ForEach(workspace.threads) { thread in
                        Button {
                            router.navigate(to: .thread(workspaceID: workspace.id, threadID: thread.id))
                        } label: {
                            HStack(spacing: AthenaSpacing.sm) {
                                AthenaIconTile(systemImage: "bubble.left", tint: .secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(thread.title)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    Text(thread.lastMessage)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(thread.title)
                    }
                }
            }
        }
    }
}

struct WorkspaceView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            WorkspaceView()
                .navigationTitle("Workspace")
        }
        .environment(RouterPath())
        .environment(AppDependencies.preview())
    }
}
