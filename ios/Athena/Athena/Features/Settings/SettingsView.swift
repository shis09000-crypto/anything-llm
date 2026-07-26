import SwiftUI
import PhotosUI
import UIKit

struct SettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    var closeAction: (() -> Void)? = nil

    @State private var selectedPhoto: PhotosPickerItem?
    @State private var cropSource: AvatarCropSource?
    @State private var photoError: String?
    @State private var confirmsSignOut = false

    var body: some View {
        List {
            Section {
                PhotosPicker(selection: $selectedPhoto, matching: .images) {
                    profileHeader
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .accessibilityLabel("更换头像")
            }

            settingsSection("个性设置", items: [
                SettingsMenuItem(.personalization, "个性化设置", "sparkles"),
                SettingsMenuItem(.memory, "长期记忆", "book.closed"),
            ])

            settingsSection("账户", items: [
                SettingsMenuItem(.email, "绑定邮箱", "envelope", accountEmailValue),
                SettingsMenuItem(.phone, "绑定电话", "phone", accountPhoneValue),
                SettingsMenuItem(.loginSecurity, "登录与安全", "lock.shield"),
                SettingsMenuItem(.quickLogin, "快速登录", "bolt"),
                SettingsMenuItem(.passkeys, "通行密钥", "touchid"),
                SettingsMenuItem(.sessionDevices, "会话设备", "laptopcomputer.and.iphone"),
                SettingsMenuItem(.dataPrivacy, "数据与隐私", "hand.raised"),
            ])

            settingsSection("主题", items: [
                SettingsMenuItem(
                    .appearance,
                    "外观",
                    "sun.max",
                    dependencies.accountSettingsCenter.preferences.appearance.title
                ),
                SettingsMenuItem(
                    .appColor,
                    "应用色",
                    "paintpalette",
                    dependencies.accountSettingsCenter.preferences.accent.title
                ),
            ])

            settingsSection("应用设置", items: [
                SettingsMenuItem(.general, "常规", "gearshape"),
                SettingsMenuItem(.aiProviders, "人工智能提供商", "server.rack"),
            ])

            Section {
                Button(role: .destructive) {
                    confirmsSignOut = true
                } label: {
                    Label("退出登录", systemImage: "arrow.right.square")
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: NativeSettingsDestination.self) { destination in
            NativeSettingsDetailView(
                destination: destination,
                closeAction: closeAction
            )
        }
        .toolbar {
            if let closeAction {
                ToolbarItem(placement: .topBarTrailing) {
                    SettingsCloseButton(action: closeAction)
                }
            }
        }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            Task { await loadSelectedPhoto(item) }
        }
        .fullScreenCover(item: $cropSource, onDismiss: {
            selectedPhoto = nil
        }) { source in
            AvatarCropView(source: source)
        }
        .alert("无法读取照片", isPresented: Binding(
            get: { photoError != nil },
            set: { if !$0 { photoError = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            Text(photoError ?? "请选择其他照片。")
        }
        .confirmationDialog("确认退出登录？", isPresented: $confirmsSignOut) {
            Button("退出登录", role: .destructive) {
                dependencies.signOut()
                closeAction?()
                dismiss()
            }
            Button("取消", role: .cancel) {}
        }
    }

    private var profileHeader: some View {
        Group {
            if verticalSizeClass == .compact {
                HStack(spacing: 18) {
                    avatarEditor(size: 76, editButtonSize: 30)
                    VStack(alignment: .leading, spacing: 6) {
                        accountIdentity
                        accountProfileStatus
                    }
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 8)
            } else {
                VStack(spacing: 12) {
                    avatarEditor(size: 112, editButtonSize: 34)
                    accountIdentity
                    accountProfileStatus
                }
                .padding(.vertical, 18)
            }
        }
    }

    private func avatarEditor(size: CGFloat, editButtonSize: CGFloat) -> some View {
        ZStack(alignment: .bottomTrailing) {
            accountAvatar
                .frame(width: size, height: size)
                .clipShape(Circle())

            Image(systemName: "pencil")
                .font(.body.weight(.semibold))
                .frame(width: editButtonSize, height: editButtonSize)
                .glassEffect(.regular.interactive(), in: Circle())
        }
    }

    @ViewBuilder
    private var accountIdentity: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: 6) {
                accountDisplayName
                accountRoleLabel
            }
            .multilineTextAlignment(.center)
        } else {
            HStack(spacing: 8) {
                accountDisplayName
                accountRoleLabel
            }
        }
    }

    @ViewBuilder
    private var accountProfileStatus: some View {
        if dependencies.accountProfileCenter.status == .uploading
            || dependencies.accountProfileCenter.status == .awaitingSync {
            HStack(spacing: 7) {
                ProgressView()
                    .controlSize(.small)
                Text(dependencies.accountProfileCenter.status == .uploading
                    ? "正在上传头像"
                    : "正在同步头像")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accountDisplayName: some View {
        Text(dependencies.accountProfileCenter.displayName)
            .font(.title2.weight(.semibold))
            .foregroundStyle(.primary)
    }

    @ViewBuilder
    private var accountRoleLabel: some View {
        if let badge = AccountRoleBadge.resolve(dependencies.accountProfileCenter.role) {
            Label(badge.title, systemImage: badge.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var accountAvatar: some View {
        if let data = dependencies.accountProfileCenter.avatarData,
           let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                Circle()
                    .fill(Color(.tertiarySystemFill))
                Text(String(dependencies.accountProfileCenter.displayName.prefix(1)).uppercased())
                    .font(.system(size: 42, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var accountEmailValue: String {
        dependencies.accountProfileCenter.email?.isEmpty == false
            ? dependencies.accountProfileCenter.email!
            : "未绑定"
    }

    private var accountPhoneValue: String {
        dependencies.accountProfileCenter.phone?.isEmpty == false
            ? dependencies.accountProfileCenter.phone!
            : "未绑定"
    }

    private func settingsSection(
        _ title: String,
        items: [SettingsMenuItem]
    ) -> some View {
        Section(title) {
            ForEach(items) { item in
                NavigationLink(value: item.destination) {
                    SettingsMenuRow(item: item)
                }
            }
        }
    }

    private func loadSelectedPhoto(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            cropSource = AvatarCropSource(image: image)
        } catch {
            selectedPhoto = nil
            photoError = error.localizedDescription
        }
    }
}

private struct SettingsMenuItem: Identifiable {
    let destination: NativeSettingsDestination
    let title: String
    let systemImage: String
    let value: String?

    var id: NativeSettingsDestination { destination }

    init(
        _ destination: NativeSettingsDestination,
        _ title: String,
        _ systemImage: String,
        _ value: String? = nil
    ) {
        self.destination = destination
        self.title = title
        self.systemImage = systemImage
        self.value = value
    }
}

private struct SettingsMenuRow: View {
    let item: SettingsMenuItem

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: item.systemImage)
                .font(.body)
                .foregroundStyle(.primary)
                .frame(width: 24, alignment: .center)
            Text(item.title)
                .foregroundStyle(.primary)
            Spacer(minLength: 12)
            if let value = item.value {
                Text(value)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .contentShape(Rectangle())
    }
}

enum NativeSettingsDestination: String, Hashable, Identifiable {
    case personalization
    case memory
    case email
    case phone
    case loginSecurity
    case quickLogin
    case passkeys
    case sessionDevices
    case dataPrivacy
    case appearance
    case appColor
    case general
    case aiProviders

    var id: String { rawValue }

    var title: String {
        switch self {
        case .personalization: "个性化设置"
        case .memory: "长期记忆"
        case .email: "绑定邮箱"
        case .phone: "绑定电话"
        case .loginSecurity: "登录与安全"
        case .quickLogin: "快速登录"
        case .passkeys: "通行密钥"
        case .sessionDevices: "会话设备"
        case .dataPrivacy: "数据与隐私"
        case .appearance: "外观"
        case .appColor: "应用色"
        case .general: "常规"
        case .aiProviders: "人工智能提供商"
        }
    }

    var systemImage: String {
        switch self {
        case .personalization: "sparkles"
        case .memory: "book.closed"
        case .email: "envelope"
        case .phone: "phone"
        case .loginSecurity: "lock.shield"
        case .quickLogin: "bolt"
        case .passkeys: "touchid"
        case .sessionDevices: "laptopcomputer.and.iphone"
        case .dataPrivacy: "hand.raised"
        case .appearance: "sun.max"
        case .appColor: "paintpalette"
        case .general: "gearshape"
        case .aiProviders: "server.rack"
        }
    }
}

struct NativeSettingsDetailView: View {
    let destination: NativeSettingsDestination
    var closeAction: (() -> Void)? = nil

    var body: some View {
        Group {
            switch destination {
            case .personalization: PersonalizationSettingsView()
            case .memory: MemorySettingsView()
            case .email: EmailBindingSettingsView()
            case .phone: PhoneBindingSettingsView()
            case .loginSecurity: LoginSecuritySettingsView()
            case .quickLogin: QuickLoginSettingsView()
            case .passkeys: PasskeySettingsView()
            case .sessionDevices: SessionDevicesSettingsView()
            case .dataPrivacy: DataPrivacySettingsView()
            case .appearance: AppearanceSettingsView()
            case .appColor: AppColorSettingsView()
            case .general: GeneralSettingsDetailView()
            case .aiProviders: AIProviderSettingsView()
            }
        }
        .navigationTitle(destination.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let closeAction {
                ToolbarItem(placement: .topBarTrailing) {
                    SettingsCloseButton(action: closeAction)
                }
            }
        }
    }
}

private struct SettingsCloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.body.weight(.medium))
                .foregroundStyle(.black)
                .shadow(color: .black.opacity(0.24), radius: 1, x: 0, y: 0.75)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("关闭设置")
    }
}

private struct GeneralSettingsDetailView: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        List {
            Section("连接") {
                LabeledContent("API Base", value: dependencies.apiClient.configuration.baseURL.absoluteString)
                LabeledContent("HTTPS", value: enabledText(dependencies.runtime.bootstrap?.transport.httpsRequired))
                LabeledContent("WSS", value: enabledText(dependencies.runtime.bootstrap?.transport.webSocketSecureRequired))
                LabeledContent("SSE", value: enabledText(dependencies.runtime.bootstrap?.transport.sseSupported))
            }
            Section("原生客户端") {
                LabeledContent("协议", value: dependencies.runtime.bootstrap?.protocolVersion ?? "未载入")
                LabeledContent("系统要求", value: "iOS 26+")
                LabeledContent("Client Identity", value: dependencies.clientIdentityCenter.status.displayTitle)
                LabeledContent("请求签名", value: dependencies.requestSigningCenter.status.displayTitle)
            }
        }
        .listStyle(.insetGrouped)
    }

    private func enabledText(_ value: Bool?) -> String {
        value == true ? "已启用" : "未启用"
    }
}

private struct SettingsStatusPanel: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaPanel {
            VStack(alignment: .leading, spacing: AthenaSpacing.md) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("System Readiness")
                            .font(.title3.weight(.bold))
                        Text(dependencies.runtime.bootstrap?.protocolVersion ?? "Bootstrap not loaded")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusPill(title: dependencies.runtime.loadState.title, systemImage: "dot.radiowaves.left.and.right", tint: tint)
                }

                HStack(spacing: AthenaSpacing.sm) {
                    StatusPill(title: dependencies.runtime.preflight?.compatible == true ? "Compatible" : "Preflight", systemImage: "checkmark.seal", tint: dependencies.runtime.preflight?.compatible == true ? .green : .orange)
                    StatusPill(title: "iOS 26+", systemImage: "iphone", tint: .green)
                }
            }
        }
    }

    private var tint: Color {
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

private extension SettingsSection {
    var icon: String {
        switch self {
        case .transport:
            "lock.icloud"
        case .security:
            "key.horizontal"
        case .nativeReadiness:
            "checklist.checked"
        }
    }

    var subtitle: String {
        switch self {
        case .transport:
            "HTTPS, WSS, SSE, and public API base"
        case .security:
            "Client identity, signing, and sensitive session"
        case .nativeReadiness:
            "P0 and P1 server/client readiness boundaries"
        }
    }

    var tint: Color {
        switch self {
        case .transport:
            .blue
        case .security:
            .orange
        case .nativeReadiness:
            .green
        }
    }
}

private struct SettingsRow: View {
    let title: String
    let subtitle: String?
    let systemImage: String
    let tint: Color
    var showsDisclosure = true

    var body: some View {
        HStack(spacing: AthenaSpacing.md) {
            AthenaIconTile(systemImage: systemImage, tint: tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if showsDisclosure {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

private struct ReadinessSummaryView: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        VStack(alignment: .leading, spacing: AthenaSpacing.sm) {
            HStack {
                StatusPill(title: dependencies.runtime.loadState.title, systemImage: "dot.radiowaves.left.and.right", tint: tint)
                if dependencies.runtime.preflight?.compatible == true {
                    StatusPill(title: "iOS 26+", systemImage: "iphone", tint: .green)
                }
            }

            if let bootstrap = dependencies.runtime.bootstrap {
                Text(bootstrap.protocolVersion)
                    .font(.subheadline.weight(.semibold))
                Text(bootstrap.app.minimumOSVersion)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, AthenaSpacing.xs)
    }

    private var tint: Color {
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

struct SettingsSectionView: View {
    let section: SettingsSection
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        AthenaScrollSurface(spacing: AthenaSpacing.lg) {
            switch section {
            case .transport:
                transportRows
            case .security:
                securityRows
            case .nativeReadiness:
                readinessRows
            }
        }
        .navigationTitle(section.title)
    }

    @ViewBuilder
    private var transportRows: some View {
        SectionHeader("Transport", subtitle: dependencies.runtime.bootstrap?.transport.publicAppUrl ?? "Public app URL not reported")
        AthenaPanel {
            VStack(spacing: AthenaSpacing.md) {
                NativeSettingLine(title: "HTTPS", value: boolText(dependencies.runtime.bootstrap?.transport.httpsRequired), icon: "lock.icloud", tint: .blue)
                NativeSettingLine(title: "WSS", value: boolText(dependencies.runtime.bootstrap?.transport.webSocketSecureRequired), icon: "lock.rectangle.stack", tint: .blue)
                NativeSettingLine(title: "SSE", value: boolText(dependencies.runtime.bootstrap?.transport.sseSupported), icon: "wave.3.right", tint: .orange)
                NativeSettingLine(title: "WebSocket", value: boolText(dependencies.runtime.bootstrap?.transport.webSocketSupported), icon: "antenna.radiowaves.left.and.right", tint: .green)
            }
        }
    }

    @ViewBuilder
    private var securityRows: some View {
        SectionHeader("Security", subtitle: "Secrets stay behind Keychain-backed centers")
        AthenaPanel {
            VStack(spacing: AthenaSpacing.md) {
                NativeSettingLine(title: "Client Identity", value: boolText(dependencies.runtime.bootstrap?.security.clientIdentityRequired), icon: "person.badge.key", tint: .orange)
                NativeSettingLine(title: "Client ID Status", value: dependencies.clientIdentityCenter.status.displayTitle, icon: "iphone.gen3", tint: .blue)
                NativeSettingLine(title: "Signature", value: dependencies.runtime.bootstrap?.security.preferredSignatureVersion ?? AthenaCryptoSuiteRegistry.requestDeviceP256V2, icon: "signature", tint: .purple)
                NativeSettingLine(title: "Signing Status", value: dependencies.requestSigningCenter.status.displayTitle, icon: "key.horizontal", tint: .orange)
                NativeSettingLine(title: "Sensitive Header", value: dependencies.runtime.bootstrap?.security.sensitiveSessionHeader ?? "X-Athena-Sensitive-Session", icon: "lock.shield", tint: .red)
            }
        }
    }

    @ViewBuilder
    private var readinessRows: some View {
        SectionHeader("P0", subtitle: "Blocking readiness")
        AthenaPanel {
            VStack(spacing: AthenaSpacing.md) {
            ForEach(dependencies.runtime.bootstrap?.readiness?.p0 ?? []) { item in
                    NativeSettingLine(title: item.id, value: item.status, icon: "exclamationmark.triangle", tint: item.status == "ready" ? .green : .orange)
                }
            }
        }
        SectionHeader("P1", subtitle: "Important preparation")
        AthenaPanel {
            VStack(spacing: AthenaSpacing.md) {
            ForEach(dependencies.runtime.bootstrap?.readiness?.p1 ?? []) { item in
                    NativeSettingLine(title: item.id, value: item.status, icon: "checklist", tint: item.status == "ready" ? .green : .blue)
                }
            }
        }
    }

    private func boolText(_ value: Bool?) -> String {
        value == true ? "Yes" : "No"
    }
}

private struct NativeSettingLine: View {
    let title: String
    let value: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(spacing: AthenaSpacing.md) {
            AthenaIconTile(systemImage: icon, tint: tint)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: AthenaSpacing.sm)
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

struct APIBaseSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppDependencies.self) private var dependencies
    @State private var draft = ""

    var body: some View {
        Form {
            Section {
                TextField("https://athenallm.online", text: $draft)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
            }

            Section {
                Button {
                    apply()
                } label: {
                    Label("Apply", systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                }
                .athenaGlassButton(prominent: true)
            }
        }
        .navigationTitle("API Base")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
        .onAppear {
            draft = dependencies.apiClient.configuration.baseURL.absoluteString
        }
    }

    private func apply() {
        guard let url = URL(string: draft.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return
        }
        dependencies.apiClient.configuration.baseURL = url
        Task {
            await dependencies.refreshNativeRuntime()
            dismiss()
        }
    }
}

struct SettingsView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            SettingsView()
        }
        .environment(RouterPath())
        .environment(AppDependencies.preview())
    }
}
