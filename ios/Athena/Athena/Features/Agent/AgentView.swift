import SwiftUI

struct AgentView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(RouterPath.self) private var router

    private var sessions: [AgentSessionSnapshot] {
        dependencies.agentControlKit.sessions.sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            AgentStatusPanel(sessionCount: sessions.count)

            SectionHeader("Agent 会话", subtitle: "运行状态可在重新登录后从服务器续接")

            if sessions.isEmpty {
                ContentUnavailableView(
                    "暂无 Agent 会话",
                    systemImage: "sparkles",
                    description: Text("在聊天中启动 Agent 后，会话会显示在这里。")
                )
                .frame(maxWidth: .infinity)
                .padding(.vertical, AthenaSpacing.xl)
            } else {
                ForEach(sessions) { session in
                    Button {
                        router.navigate(to: .agentSession(sessionID: session.invocationID))
                    } label: {
                        AgentSessionRow(session: session)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct AgentStatusPanel: View {
    let sessionCount: Int
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaPanel {
            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Agent Control")
                            .font(.title3.weight(.bold))
                        Text("前台实时连接，重新进入 App 后通过服务器状态恢复。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(title: "\(sessionCount)", systemImage: "sparkles", tint: .purple)
                }

                AthenaMetricRow(
                    title: "Invocation socket",
                    value: dependencies.agentControlKit.webSocketPathTemplate,
                    systemImage: "point.3.connected.trianglepath.dotted",
                    tint: .blue
                )
            }
        }
    }
}

private struct AgentSessionRow: View {
    let session: AgentSessionSnapshot

    var body: some View {
        AthenaPanel {
            HStack(spacing: AthenaSpacing.md) {
                Image(systemName: session.phase.systemImage)
                    .font(.title3)
                    .foregroundStyle(session.phase.tint)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.phase.title)
                        .font(.headline)
                    Text(session.invocationID)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(session.updatedAt, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: AthenaSpacing.sm)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

struct AgentSessionDetailView: View {
    let sessionID: String
    @Environment(AppDependencies.self) private var dependencies

    private var session: AgentSessionSnapshot? {
        dependencies.agentControlKit.sessions.first { $0.invocationID == sessionID }
    }

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            if let session {
                AgentSessionContentView(
                    session: session,
                    agentControlKit: dependencies.agentControlKit
                )
            } else {
                ContentUnavailableView(
                    "会话不可用",
                    systemImage: "exclamationmark.bubble",
                    description: Text("该 Agent 会话已结束或不属于当前登录用户。")
                )
                .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("Agent")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct AgentView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            AgentView()
        }
        .environment(RouterPath())
        .environment(AppDependencies.preview())
    }
}
