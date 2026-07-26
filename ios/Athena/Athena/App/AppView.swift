import SwiftUI

@MainActor
struct AppView: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        @Bindable var authCenter = dependencies.authCenter

        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            sessionContent
                .id(sessionContentIdentity)
                .transition(.opacity)
        }
            .animation(.smooth, value: sessionContentIdentity)
            .task {
                await dependencies.start()
            }
            .sheet(item: $authCenter.pendingRecoveryCodes) { bundle in
                RecoveryCodesView(bundle: bundle) {
                    authCenter.pendingRecoveryCodes = nil
                }
            }
    }

    @ViewBuilder
    private var sessionContent: some View {
        switch dependencies.sessionState {
        case .launching:
            Color.clear
                .accessibilityIdentifier("athena-launch-gate")
        case .signedOut, .authenticating, .restoringSession, .loadingWorkspace:
            AthenaAuthFlowView(phase: dependencies.sessionState)
        case .ready:
            ConversationHomeView(workspaceCenter: dependencies.workspaceCenter)
        case .blocked(let message):
            SessionFailureView(
                title: "需要更新 Athena",
                message: message,
                retryTitle: nil,
                retry: nil,
                signOut: nil
            )
        case .failed(let message):
            SessionFailureView(
                title: "暂时无法载入工作区",
                message: message,
                retryTitle: "重试",
                retry: {
                    Task { await dependencies.restart() }
                },
                cachedFallback: dependencies.workspaceCenter.hasCachedFallback
                    ? { Task { await dependencies.useCachedWorkspaceFallback() } }
                    : nil,
                signOut: { dependencies.signOut() }
            )
        }
    }

    private var sessionContentIdentity: String {
        switch dependencies.sessionState {
        case .launching: "launching"
        case .signedOut, .authenticating, .restoringSession, .loadingWorkspace: "auth-flow"
        case .ready: "ready"
        case .blocked: "blocked"
        case .failed: "failed"
        }
    }
}

private struct SessionFailureView: View {
    let title: String
    let message: String
    let retryTitle: String?
    let retry: (() -> Void)?
    var cachedFallback: (() -> Void)? = nil
    let signOut: (() -> Void)?

    var body: some View {
        ZStack {
            AthenaLoginBackdrop()

            ScrollView {
                VStack(spacing: 22) {
                    Spacer(minLength: 112)

                    AthenaAuthBrandBubble(animates: false)

                    VStack(spacing: 8) {
                        Label(title, systemImage: "exclamationmark.triangle.fill")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.primary)
                        Text(message)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)

                    VStack(spacing: 10) {
                        if let retryTitle, let retry {
                            AuthActionButton(
                                title: retryTitle,
                                systemImage: "arrow.clockwise",
                                prominent: true,
                                enabled: true,
                                tint: .black,
                                action: retry
                            )
                        }
                        if let cachedFallback {
                            AuthActionButton(
                                title: "查看缓存内容",
                                systemImage: "internaldrive",
                                prominent: false,
                                enabled: true,
                                action: cachedFallback
                            )
                        }
                        if let signOut {
                            AuthActionButton(
                                title: "退出登录",
                                systemImage: "rectangle.portrait.and.arrow.right",
                                prominent: false,
                                enabled: true,
                                tint: .red,
                                action: signOut
                            )
                        }
                    }

                    Spacer(minLength: 56)
                }
                .frame(maxWidth: 390)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
        }
        .preferredColorScheme(.light)
    }
}

private struct RecoveryCodesView: View {
    @Environment(\.dismiss) private var dismiss
    let bundle: RecoveryCodeBundle
    let acknowledge: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(bundle.codes, id: \.self) { code in
                        Text(code)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                    }
                } footer: {
                    Text("这些恢复代码只显示一次，请保存在安全的位置。")
                }
            }
            .navigationTitle("恢复代码")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        acknowledge()
                        dismiss()
                    }
                }
            }
        }
        .interactiveDismissDisabled()
    }
}

struct AppView_Previews: PreviewProvider {
    static var previews: some View {
        AppView()
            .environment(AppDependencies.preview())
    }
}
