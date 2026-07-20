import SwiftUI

@MainActor
struct AthenaAuthFlowView: View {
    private enum FocusedField: Hashable {
        case identifier
        case password
    }

    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.colorScheme) private var colorScheme
    @State private var identifier = ""
    @State private var password = ""
    @State private var brandBreathing = false
    @FocusState private var focusedField: FocusedField?

    let phase: AppSessionState

    private var isSubmitting: Bool {
        switch phase {
        case .authenticating, .restoringSession, .loadingWorkspace:
            true
        default:
            false
        }
    }

    private var message: String? {
        switch phase {
        case .signedOut(let message):
            message
        default:
            nil
        }
    }

    private var progressTitle: String {
        switch phase {
        case .authenticating:
            "正在验证身份"
        case .restoringSession:
            "正在验证登录状态"
        case .loadingWorkspace:
            "正在同步工作区"
        case .launching:
            "正在检查 Athena"
        default:
            ""
        }
    }

    private var canLogin: Bool {
        (!dependencies.authCenter.requiresIdentifier
            || !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && !password.isEmpty
            && !isSubmitting
    }

    private var canUsePasskey: Bool {
        dependencies.authCenter.passkeyAvailable
            && dependencies.authCenter.nativePasskey?.serverAvailable == true
            && !isSubmitting
    }

    private var primaryButtonTint: Color {
        colorScheme == .dark ? .white : .black
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                brandStage

                ZStack(alignment: .top) {
                    authEntry
                        .opacity(isSubmitting ? 0 : 1)
                        .allowsHitTesting(!isSubmitting)
                        .accessibilityHidden(isSubmitting)

                    authProgress
                        .opacity(isSubmitting ? 1 : 0)
                        .allowsHitTesting(isSubmitting)
                        .accessibilityHidden(!isSubmitting)
                }
                .frame(maxWidth: 420)
                .frame(minHeight: 330, alignment: .top)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 34)
            .padding(.bottom, 28)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(Color(.systemBackground).ignoresSafeArea())
        .animation(.smooth, value: isSubmitting)
        .onChange(of: isSubmitting) { _, submitting in
            if submitting {
                focusedField = nil
            }
        }
        .accessibilityIdentifier("athena-auth-flow")
        .alert(
            "通行密钥登录失败",
            isPresented: Binding(
                get: { dependencies.passkeyLoginError != nil },
                set: { if !$0 { dependencies.passkeyLoginError = nil } }
            )
        ) {
            Button("使用账号密码", role: .cancel) {
                dependencies.passkeyLoginError = nil
            }
        } message: {
            Text(dependencies.passkeyLoginError ?? "请使用账号密码登录。")
        }
    }

    private var brandStage: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(.clear)
                    .frame(width: 116, height: 116)
                    .glassEffect(.regular, in: Circle())

                Image("AthenaBrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 88, height: 88)
                    .scaleEffect(1.35)
                    .frame(width: 88, height: 88)
                    .clipShape(Circle())
                    .scaleEffect(brandBreathing ? 1.035 : 0.975)
                    .opacity(brandBreathing ? 1 : 0.86)
                    .animation(
                        .easeInOut(duration: 2.6).repeatForever(autoreverses: true),
                        value: brandBreathing
                    )
            }
            .frame(width: 116, height: 116)
            .accessibilityHidden(true)

            VStack(spacing: 5) {
                Text("Athena")
                    .font(.largeTitle.weight(.bold))
                Text("你的 AI 工作空间")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(height: 216, alignment: .top)
        .onAppear {
            brandBreathing = true
        }
    }

    private var authEntry: some View {
        VStack(spacing: 18) {
            credentialPanel

            if let message, !message.isEmpty {
                Label(message, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
            }

            VStack(spacing: 10) {
                AuthActionButton(
                    title: "登录",
                    systemImage: "arrow.right",
                    prominent: true,
                    enabled: canLogin,
                    tint: primaryButtonTint,
                    action: login
                )

                if let device = dependencies.quickLoginCenter.preferredLocalDevice {
                    AuthActionButton(
                        title: "快速登录 \(device.username)",
                        systemImage: "bolt.shield",
                        prominent: false,
                        enabled: !isSubmitting
                    ) {
                        Task { await dependencies.loginWithQuickLogin(device) }
                    }
                }

                if canUsePasskey {
                    AuthActionButton(
                        title: "使用网站通行密钥",
                        systemImage: "touchid",
                        prominent: false,
                        enabled: true
                    ) {
                        Task { await dependencies.loginWithPasskey() }
                    }
                }
            }
        }
    }

    private var credentialPanel: some View {
        VStack(spacing: 0) {
            if dependencies.authCenter.requiresIdentifier {
                AuthFieldRow(systemImage: "person") {
                    TextField("用户名或邮箱", text: $identifier)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focusedField, equals: .identifier)
                        .onSubmit {
                            focusedField = .password
                        }
                        .accessibilityIdentifier("athena-login-identifier")
                }

                Divider()
                    .padding(.leading, 48)
            }

            AuthFieldRow(systemImage: "lock") {
                SecureField("密码", text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .focused($focusedField, equals: .password)
                    .onSubmit(login)
                    .accessibilityIdentifier("athena-login-password")
            }
        }
        .padding(.horizontal, 16)
        .glassEffect(
            .regular.interactive(),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
        )
    }

    private var authProgress: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.regular)
            Text(progressTitle)
                .font(.headline)
                .contentTransition(.opacity)
                .id(progressTitle)
            Text("正在建立受保护的 Athena 会话")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 42)
        .accessibilityElement(children: .combine)
    }

    private func login() {
        guard canLogin else { return }
        let submittedPassword = password
        password = ""
        Task {
            await dependencies.login(
                identifier: identifier.trimmingCharacters(in: .whitespacesAndNewlines),
                password: submittedPassword
            )
        }
    }
}

private struct AuthFieldRow<Field: View>: View {
    let systemImage: String
    @ViewBuilder let field: Field

    init(systemImage: String, @ViewBuilder field: () -> Field) {
        self.systemImage = systemImage
        self.field = field()
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)

            field
                .font(.body)
                .frame(maxWidth: .infinity)
        }
        .frame(height: 58)
        .contentShape(Rectangle())
    }
}

private struct AuthActionButton: View {
    let title: String
    let systemImage: String
    let prominent: Bool
    let enabled: Bool
    var tint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .frame(height: 54)
                .contentShape(Capsule())
        }
        .athenaGlassButton(prominent: prominent)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
        .tint(tint)
        .disabled(!enabled)
        .accessibilityIdentifier("athena-auth-action-\(title)")
    }
}
