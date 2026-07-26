import SwiftUI

private enum AuthEntryMethod: Equatable {
    case password
    case quickLogin
    case passkey
}

struct AuthProgressPresentation: Equatable {
    let title: String
    let detail: String
    let systemImage: String
}

@MainActor
struct AthenaAuthFlowView: View {
    private enum FocusedField: Hashable {
        case identifier
        case password
    }

    @Environment(AppDependencies.self) private var dependencies
    @State private var identifier = ""
    @State private var password = ""
    @State private var revealsPassword = false
    @State private var activeMethod: AuthEntryMethod?
    @State private var presentsAuthEntry = false
    @FocusState private var focusedField: FocusedField?

    let phase: AppSessionState
    let previewQuickLoginDevice: LocalQuickLoginDevice?

    init(
        phase: AppSessionState,
        previewQuickLoginDevice: LocalQuickLoginDevice? = nil
    ) {
        self.phase = phase
        self.previewQuickLoginDevice = previewQuickLoginDevice
    }

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

    private var progressPresentation: AuthProgressPresentation {
        switch phase {
        case .authenticating:
            switch activeMethod {
            case .password:
                AuthProgressPresentation(
                    title: "正在验证账户",
                    detail: "正在安全地确认你的登录信息",
                    systemImage: "lock.shield"
                )
            case .quickLogin:
                AuthProgressPresentation(
                    title: "正在进行快速登录",
                    detail: "请在此设备上完成身份确认",
                    systemImage: "bolt.shield"
                )
            case .passkey:
                AuthProgressPresentation(
                    title: "正在验证网站通行密钥",
                    detail: "请按照系统提示完成验证",
                    systemImage: "touchid"
                )
            case nil:
                AuthProgressPresentation(
                    title: "正在验证身份",
                    detail: "正在建立受保护的 Athena 会话",
                    systemImage: "checkmark.shield"
                )
            }
        case .restoringSession:
            AuthProgressPresentation(
                title: "正在恢复安全会话",
                detail: "正在确认此设备上的登录状态",
                systemImage: "key.viewfinder"
            )
        case .loadingWorkspace:
            AuthProgressPresentation(
                title: "正在准备工作区",
                detail: "正在恢复你上次使用的 Athena 空间",
                systemImage: "square.grid.2x2"
            )
        case .launching:
            AuthProgressPresentation(
                title: "正在检查 Athena",
                detail: "正在准备安全运行环境",
                systemImage: "checkmark.shield"
            )
        default:
            AuthProgressPresentation(
                title: "正在连接 Athena",
                detail: "正在建立受保护的会话",
                systemImage: "checkmark.shield"
            )
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

    private var hasAlternativeLogin: Bool {
        quickLoginDevice != nil || canUsePasskey
    }

    private var quickLoginDevice: LocalQuickLoginDevice? {
        previewQuickLoginDevice ?? dependencies.quickLoginCenter.preferredLocalDevice
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                AthenaLoginBackdrop()

                if isSubmitting {
                    AuthProgressStage(presentation: progressPresentation)
                        .transition(.opacity)
                } else {
                    authScroll(in: geometry)
                        .transition(.opacity)
                }
            }
            .animation(.smooth, value: isSubmitting)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .preferredColorScheme(.light)
        .onChange(of: isSubmitting) { _, submitting in
            if submitting {
                focusedField = nil
            } else {
                activeMethod = nil
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

    private func authScroll(in geometry: GeometryProxy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear
                .frame(height: heroHeight(in: geometry))
                .accessibilityHidden(true)

            authEntry
                .frame(maxWidth: 430)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 26)
                .padding(.bottom, max(geometry.safeAreaInsets.bottom + 24, 38))
                .opacity(presentsAuthEntry ? 1 : 0)
                .offset(y: presentsAuthEntry ? 0 : 24)
                .onAppear {
                    guard !presentsAuthEntry else { return }
                    withAnimation(.easeOut(duration: 0.55).delay(0.08)) {
                        presentsAuthEntry = true
                    }
                }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .frame(
            width: geometry.size.width,
            height: geometry.size.height,
            alignment: .top
        )
        .clipped()
    }

    private func heroHeight(in geometry: GeometryProxy) -> CGFloat {
        let availableHeight = geometry.size.height + geometry.safeAreaInsets.top
        return min(max(availableHeight * 0.31, 235), 300)
    }

    private var authEntry: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 7) {
                Text("欢迎回来")
                    .font(.system(.largeTitle, design: .rounded, weight: .bold))
                    .foregroundStyle(.primary)

                Text("登录以继续使用 Athena")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)

            VStack(spacing: 12) {
                if dependencies.authCenter.requiresIdentifier {
                    AuthGlassFieldRow(systemImage: "envelope") {
                        TextField("用户名或邮箱", text: $identifier)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.next)
                            .focused($focusedField, equals: .identifier)
                            .onSubmit {
                                focusedField = .password
                            }
                            .accessibilityIdentifier("athena-login-identifier")
                    }
                }

                AuthGlassFieldRow(systemImage: "lock") {
                    Group {
                        if revealsPassword {
                            TextField("密码", text: $password)
                        } else {
                            SecureField("密码", text: $password)
                        }
                    }
                    .textContentType(.password)
                    .submitLabel(.go)
                    .focused($focusedField, equals: .password)
                    .onSubmit(login)
                    .accessibilityIdentifier("athena-login-password")
                } trailing: {
                    Button {
                        revealsPassword.toggle()
                        focusedField = .password
                    } label: {
                        Image(systemName: revealsPassword ? "eye.slash" : "eye")
                            .font(.body.weight(.medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(revealsPassword ? "隐藏密码" : "显示密码")
                }
            }

            if let message, !message.isEmpty {
                AuthFailureNotice(message: message)
                    .transition(.opacity)
            }

            Label("登录状态将安全保存在此设备", systemImage: "checkmark.shield")
                .font(.footnote)
                .foregroundStyle(.secondary)

            AuthActionButton(
                title: "登录",
                systemImage: "arrow.right",
                prominent: true,
                enabled: canLogin,
                tint: .black,
                trailingIcon: true,
                compact: true,
                height: 38,
                action: login
            )

            if hasAlternativeLogin {
                AuthLoginDivider()

                VStack(spacing: 10) {
                    if let device = quickLoginDevice {
                        AuthActionButton(
                            title: "快速登录 \(device.username)",
                            systemImage: "bolt.shield",
                            prominent: false,
                            enabled: !isSubmitting
                        ) {
                            activeMethod = .quickLogin
                            Task { await dependencies.loginWithQuickLogin(device) }
                        }
                    }

                    if canUsePasskey {
                        AuthActionButton(
                            title: "使用网站通行密钥",
                            systemImage: "touchid",
                            prominent: false,
                            enabled: true,
                            compact: true,
                            height: 38
                        ) {
                            activeMethod = .passkey
                            Task { await dependencies.loginWithPasskey() }
                        }
                    }
                }
            }
        }
    }

    private func login() {
        guard canLogin else { return }
        activeMethod = .password
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

private struct AuthFailureNotice: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.body.weight(.semibold))
                .foregroundStyle(.red)

            VStack(alignment: .leading, spacing: 3) {
                Text("登录失败")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .glassEffect(
            .regular,
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }
}

struct AthenaLoginBackdrop: View {
    var body: some View {
        GeometryReader { geometry in
            Image("AthenaLoginBackdrop")
                .resizable()
                .scaledToFill()
                .frame(width: geometry.size.width, height: geometry.size.height)
                .clipped()
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

private struct AuthGlassFieldRow<Field: View, Trailing: View>: View {
    let systemImage: String
    @ViewBuilder let field: Field
    @ViewBuilder let trailing: Trailing

    init(
        systemImage: String,
        @ViewBuilder field: () -> Field,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.systemImage = systemImage
        self.field = field()
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 22)

            field
                .font(.body)
                .frame(maxWidth: .infinity)

            trailing
        }
        .padding(.horizontal, 17)
        .frame(height: 58)
        .glassEffect(
            .regular.interactive(),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }
}

private extension AuthGlassFieldRow where Trailing == EmptyView {
    init(systemImage: String, @ViewBuilder field: () -> Field) {
        self.init(systemImage: systemImage, field: field) {
            EmptyView()
        }
    }
}

private struct AuthLoginDivider: View {
    var body: some View {
        HStack(spacing: 12) {
            Rectangle()
                .fill(.secondary.opacity(0.22))
                .frame(maxWidth: .infinity)
                .frame(height: 0.5)

            Text("其他登录方式")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize()

            Rectangle()
                .fill(.secondary.opacity(0.22))
                .frame(maxWidth: .infinity)
                .frame(height: 0.5)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 20)
        .accessibilityHidden(true)
    }
}

struct AuthActionButton: View {
    let title: String
    let systemImage: String
    let prominent: Bool
    let enabled: Bool
    var tint: Color? = nil
    var trailingIcon = false
    var compact = false
    var height: CGFloat = 50
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if !trailingIcon {
                    Image(systemName: systemImage)
                }

                Text(title)

                if trailingIcon {
                    Image(systemName: systemImage)
                }
            }
            .font(.body.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .contentShape(Rectangle())
        }
        .athenaGlassButton(prominent: prominent)
        .controlSize(compact ? .regular : .large)
        .frame(maxWidth: .infinity)
        .tint(tint)
        .disabled(!enabled)
        .accessibilityIdentifier("athena-auth-action-\(title)")
    }
}

struct AthenaAuthBrandBubble: View {
    var animates = true

    var body: some View {
        Image("AthenaBrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: 72, height: 72)
            .clipShape(Circle())
            .padding(12)
            .glassEffect(.regular, in: Circle())
            .phaseAnimator(animates ? [false, true] : [false]) { content, expanded in
                content
                    .scaleEffect(expanded ? 1.025 : 0.985)
                    .opacity(expanded ? 1 : 0.92)
            } animation: { _ in
                .smooth
            }
    }
}

private struct AuthProgressStage: View {
    let presentation: AuthProgressPresentation

    var body: some View {
        VStack(spacing: 18) {
            Spacer()

            AthenaAuthBrandBubble()

            ProgressView()
                .controlSize(.regular)
                .tint(.primary)

            VStack(spacing: 6) {
                Label(presentation.title, systemImage: presentation.systemImage)
                    .font(.headline)
                    .contentTransition(.opacity)
                    .id(presentation.title)
                Text(presentation.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .contentTransition(.opacity)
                    .id(presentation.detail)
            }
            .accessibilityElement(children: .combine)

            Spacer()
        }
        .padding(.horizontal, 32)
        .padding(.vertical, 44)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
