import SwiftUI

struct PersonalizationSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var draft = PersonalizationDraft()
    @State private var loaded = false

    var body: some View {
        Form {
            Section("称呼") {
                TextField("你的昵称", text: $draft.nickname)
                    .textContentType(.nickname)
                TextField("模型的身份", text: $draft.modelIdentity)
            }
            Section("回答方式") {
                TextField("回答风格", text: $draft.responseStyle, axis: .vertical)
                    .lineLimit(2...4)
            }
            Section {
                TextEditor(text: $draft.details)
                    .frame(minHeight: 150)
                LabeledContent("字符", value: "\(draft.serialized.count) / 1000")
                    .foregroundStyle(draft.serialized.count > 1000 ? .red : .secondary)
            } header: {
                Text("你的详情")
            } footer: {
                Text("这些信息会进入 Athena 的个性化上下文。")
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if center.isSaving(.personalization) {
                    ProgressView()
                } else {
                    Button("保存") {
                        Task { _ = await center.savePersonalization(draft) }
                    }
                    .disabled(draft.serialized.count > 1000)
                }
            }
        }
        .overlay { loadingOverlay(center.isLoading(.personalization) && !loaded) }
        .task {
            guard !loaded else { return }
            await center.loadPersonalization()
            draft = center.personalization
            loaded = true
        }
    }

    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
}

struct MemorySettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var confirmsRebuild = false
    @State private var presentsCreateMemory = false

    var body: some View {
        List {
            if let overview = center.memoryOverview {
                Section("概览") {
                    Text(overview.overview)
                        .textSelection(.enabled)
                }
            }
            ForEach(center.memoryBlocks) { block in
                Section {
                    DisclosureGroup {
                        ForEach(block.items) { item in
                            NavigationLink {
                                if item.isSensitive == true {
                                    SensitiveMemoryBoundaryView(item: item)
                                } else {
                                    MemoryEditorView(item: item)
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Label(item.title, systemImage: item.isSensitive == true ? "lock" : "text.book.closed")
                                    if !item.detail.isEmpty {
                                        Text(item.detail)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                }
                            }
                        }
                    } label: {
                        LabeledContent(block.title, value: "\(block.count)")
                    }
                }
            }
            Section {
                NavigationLink {
                    MemoryArchivesView()
                } label: {
                    Label("归档记录", systemImage: "archivebox")
                }
            }
            if center.memoryBlocks.isEmpty && !center.isLoading(.memory) {
                ContentUnavailableView("暂无长期记忆", systemImage: "book.closed")
                    .listRowBackground(Color.clear)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    presentsCreateMemory = true
                } label: {
                    Label("添加记忆", systemImage: "plus")
                }
                Button("重建", systemImage: "arrow.clockwise") { confirmsRebuild = true }
                    .disabled(center.isSaving(.memory))
            }
        }
        .confirmationDialog("重建长期记忆？", isPresented: $confirmsRebuild) {
            Button("重建") { Task { _ = await center.rebuildMemory() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("Athena 会根据当前有效记忆重新生成概览。")
        }
        .overlay { loadingOverlay(center.isLoading(.memory) && center.memoryBlocks.isEmpty) }
        .task { if center.memoryBlocks.isEmpty { await center.loadMemory() } }
        .sheet(isPresented: $presentsCreateMemory) {
            NavigationStack {
                MemoryComposerView()
            }
        }
    }

    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
}

private struct MemoryEditorView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    let item: NativeMemoryItem
    @State private var confirmsDelete = false

    init(item: NativeMemoryItem) {
        self.item = item
    }

    var body: some View {
        MemoryComposerView(item: item) {
            dismiss()
        } footer: {
            Section {
                Button("移至归档", systemImage: "archivebox", role: .destructive) {
                    confirmsDelete = true
                }
            }
        }
        .confirmationDialog("将这条记忆移至归档？", isPresented: $confirmsDelete) {
            Button("移至归档", role: .destructive) {
                Task {
                    if await dependencies.accountSettingsCenter.deleteMemory(item) { dismiss() }
                }
            }
            Button("取消", role: .cancel) {}
        }
    }
}

private struct SensitiveMemoryBoundaryView: View {
    @Environment(AppDependencies.self) private var dependencies
    let item: NativeMemoryItem
    @State private var password = ""
    @State private var showsPassword = false

    var body: some View {
        Group {
            if let revealed = dependencies.accountSettingsCenter.revealedSensitiveMemory,
               revealed.id == item.id {
                List {
                    Section("敏感记忆") {
                        LabeledContent("标题", value: revealed.title)
                        Text(revealed.detail)
                            .textSelection(.enabled)
                    }
                    Section {
                        Label("内容仅保留在当前内存会话中，进入后台或离开页面后会自动清除。", systemImage: "lock.shield")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("需要安全验证", systemImage: "lock.shield")
                } description: {
                    Text("敏感记忆不会写入本地缓存。验证后可在当前安全会话中查看。")
                } actions: {
                    Button("使用密码验证") { showsPassword = true }
                        .buttonStyle(.glassProminent)
                    Button("使用通行密钥验证", systemImage: "touchid") {
                        Task {
                            _ = await dependencies.accountSettingsCenter
                                .revealSensitiveMemoryUsingPasskey(item)
                        }
                    }
                    .buttonStyle(.glass)
                }
            }
        }
        .navigationTitle(item.title)
        .navigationBarTitleDisplayMode(.inline)
        .alert("验证当前密码", isPresented: $showsPassword) {
            SecureField("当前密码", text: $password)
            Button("查看") {
                let submitted = password
                password = ""
                Task {
                    _ = await dependencies.accountSettingsCenter.revealSensitiveMemory(
                        item,
                        currentPassword: submitted
                    )
                }
            }
            Button("取消", role: .cancel) { password = "" }
        } message: {
            Text("验证成功后将建立最长五分钟的 Sensitive Session。")
        }
        .onDisappear {
            dependencies.accountSettingsCenter.clearSensitiveMemory()
        }
    }
}

private struct MemoryComposerView<Footer: View>: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    let item: NativeMemoryItem?
    let completion: (() -> Void)?
    let footer: Footer

    @State private var category: NativeMemoryCategory
    @State private var title: String
    @State private var detail: String
    @State private var source: String
    @State private var confidence: String
    @State private var isSensitive: Bool

    init(
        item: NativeMemoryItem? = nil,
        completion: (() -> Void)? = nil,
        @ViewBuilder footer: () -> Footer
    ) {
        self.item = item
        self.completion = completion
        self.footer = footer()
        _category = State(initialValue: NativeMemoryCategory(rawValue: item?.category ?? "") ?? .preferences)
        _title = State(initialValue: item?.title ?? "")
        _detail = State(initialValue: item?.detail ?? "")
        _source = State(initialValue: item?.source?.nonEmpty ?? "手动添加")
        _confidence = State(initialValue: item?.confidence?.nonEmpty ?? "中")
        _isSensitive = State(initialValue: item?.isSensitive == true)
    }

    init(item: NativeMemoryItem? = nil, completion: (() -> Void)? = nil) where Footer == EmptyView {
        self.init(item: item, completion: completion) { EmptyView() }
    }

    var body: some View {
        Form {
            Section("分类") {
                Picker("记忆分类", selection: $category) {
                    ForEach(NativeMemoryCategory.allCases) { category in
                        Text(category.title).tag(category)
                    }
                }
            }
            Section("内容") {
                TextField("标题", text: $title)
                TextEditor(text: $detail)
                    .frame(minHeight: 180)
            }
            Section("来源与可信度") {
                TextField("来源", text: $source)
                Picker("可信度", selection: $confidence) {
                    Text("低").tag("低")
                    Text("中").tag("中")
                    Text("高").tag("高")
                }
                if item == nil {
                    Toggle("敏感记忆", isOn: $isSensitive)
                }
            }
            footer
        }
        .navigationTitle(item == nil ? "添加记忆" : "编辑记忆")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if item == nil {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    Task {
                        let body = MemoryMutationBody(
                            category: category.rawValue,
                            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                            detail: detail.trimmingCharacters(in: .whitespacesAndNewlines),
                            source: source.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "手动添加",
                            confidence: confidence,
                            isSensitive: item == nil ? isSensitive : nil
                        )
                        let success = if let item {
                            await dependencies.accountSettingsCenter.updateMemory(item, body: body)
                        } else {
                            await dependencies.accountSettingsCenter.createMemory(body)
                        }
                        if success {
                            completion?()
                            dismiss()
                        }
                    }
                }
                .disabled(
                    title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || dependencies.accountSettingsCenter.isSaving(.memory)
                )
            }
        }
    }
}

private struct MemoryArchivesView: View {
    @Environment(AppDependencies.self) private var dependencies

    var body: some View {
        List {
            ForEach(dependencies.accountSettingsCenter.memoryArchives) { archive in
                VStack(alignment: .leading, spacing: 5) {
                    Text(archive.archivedMemory?.title.nonEmpty ?? "已归档记忆")
                    Text(NativeMemoryCategory(rawValue: archive.category)?.title ?? archive.category)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let date = archive.archivedAt?.nonEmpty {
                        Text(date)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            if dependencies.accountSettingsCenter.memoryArchives.isEmpty,
               !dependencies.accountSettingsCenter.isLoading(.memory) {
                ContentUnavailableView("暂无归档记录", systemImage: "archivebox")
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("归档记录")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            loadingOverlay(
                dependencies.accountSettingsCenter.isLoading(.memory)
                && dependencies.accountSettingsCenter.memoryArchives.isEmpty
            )
        }
        .task {
            await dependencies.accountSettingsCenter.loadMemoryArchives()
        }
    }
}

struct EmailBindingSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var email = ""
    @State private var code = ""
    @State private var challengeID: String?

    var body: some View {
        Form {
            Section("当前状态") {
                LabeledContent("邮箱", value: center.emailStatus?.email?.nonEmpty ?? "未绑定")
                LabeledContent("验证", value: center.emailStatus?.verified == true ? "已验证" : "未验证")
            }
            Section("绑定或更换") {
                TextField("邮箱地址", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Button(emailCodeButtonTitle) {
                        Task { challengeID = await center.requestEmailCode(email) }
                    }
                    .disabled(
                        email.isEmpty
                            || center.isSaving(.email)
                            || center.securityStore.emailResendSecondsRemaining > 0
                    )
                }
                TextField("六位验证码", text: $code)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                Button("确认绑定") {
                    Task { _ = await center.confirmEmail(email, code: code, challengeID: challengeID) }
                }
                .disabled(code.count != 6 || center.isSaving(.email))
            }
        }
        .overlay { loadingOverlay(center.isLoading(.email) && center.emailStatus == nil) }
        .task {
            await center.loadEmailStatus()
            email = center.emailStatus?.pendingEmail?.nonEmpty
                ?? center.emailStatus?.email
                ?? dependencies.accountProfileCenter.email
                ?? ""
            challengeID = center.emailStatus?.pendingChallengeId
        }
    }
    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
    private var emailCodeButtonTitle: String {
        let seconds = center.securityStore.emailResendSecondsRemaining
        return seconds > 0 ? "\(seconds) 秒后可重发" : (challengeID == nil ? "发送验证码" : "重新发送验证码")
    }
}

struct PhoneBindingSettingsView: View {
    var body: some View {
        ContentUnavailableView {
            Label("电话绑定暂不可用", systemImage: "phone.badge.clock")
        } description: {
            Text("服务端尚未提供电话绑定协议。Athena 不会展示无法完成的绑定按钮。")
        }
    }
}

struct LoginSecuritySettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""

    var body: some View {
        Form {
            Section("安全概览") {
                LabeledContent(
                    "密码",
                    value: securityRisk?.methods.password == true ? "已配置" : "未配置"
                )
                LabeledContent(
                    "邮箱验证",
                    value: securityRisk?.methods.verifiedEmail == true ? "已验证" : "未验证"
                )
                LabeledContent(
                    "通行密钥",
                    value: "\(securityRisk?.methods.passkeys ?? center.passkeys.count) 枚"
                )
                LabeledContent(
                    "快速登录设备",
                    value: "\(dependencies.quickLoginCenter.serverDevices.count) 台"
                )
                LabeledContent(
                    "恢复码",
                    value: securityRisk?.methods.recoveryCodes == true ? "已配置" : "未配置"
                )
            }
            Section("修改密码") {
                SecureField("当前密码", text: $currentPassword)
                    .textContentType(.password)
                SecureField("新密码", text: $newPassword)
                    .textContentType(.newPassword)
                SecureField("确认新密码", text: $confirmPassword)
                    .textContentType(.newPassword)
                Button("更新密码") {
                    Task {
                        if await center.changePassword(current: currentPassword, new: newPassword) {
                            currentPassword = ""
                            newPassword = ""
                            confirmPassword = ""
                        }
                    }
                }
                .disabled(newPassword.count < 8 || newPassword != confirmPassword || center.isSaving(.password))
            }
            Section("账户恢复") {
                LabeledContent(
                    "邮箱恢复",
                    value: center.emailStatus?.verified == true ? "可用" : "未配置"
                )
                Label("恢复码再生成暂未提供正式协议。已有恢复码不会保存在本机设置缓存。", systemImage: "key.viewfinder")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("登录方式") {
                NavigationLink(value: NativeSettingsDestination.quickLogin) {
                    Label("快速登录", systemImage: "bolt")
                }
                NavigationLink(value: NativeSettingsDestination.passkeys) {
                    Label("通行密钥", systemImage: "touchid")
                }
            }
        }
        .overlay {
            loadingOverlay(
                center.isLoading(.email)
                    || center.isLoading(.passkeys)
            )
        }
        .task {
            async let email: Void = center.loadEmailStatus()
            async let passkeys: Void = center.loadPasskeys()
            async let quick: Void = dependencies.quickLoginCenter.refreshDevices()
            _ = await (email, passkeys, quick)
        }
    }
    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
    private var securityRisk: NativeLoginMethodRisk? {
        center.securityStore.loginRisk
    }
}

struct QuickLoginSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var showsPasswordEnrollment = false
    @State private var password = ""
    @State private var pendingRevoke: TrustedLoginDevice?

    var body: some View {
        List {
            Section("本机恢复") {
                LabeledContent("Keychain 会话", value: dependencies.authCenter.accessToken == nil ? "未保存" : "已启用")
                Label("Athena 启动时会先检查 Keychain，并在有效登录态下恢复会话。", systemImage: "checkmark.shield")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("可信设备") {
                Button {
                    showsPasswordEnrollment = true
                } label: {
                    Label("使用密码启用", systemImage: "lock.shield")
                }
                .disabled(isBusy)
                Button {
                    Task {
                        _ = await dependencies.quickLoginCenter.enrollUsingPasskey()
                    }
                } label: {
                    Label("使用通行密钥启用", systemImage: "touchid")
                }
                .disabled(isBusy)

                ForEach(dependencies.quickLoginCenter.serverDevices) { device in
                    HStack(spacing: 12) {
                        Image(systemName: device.deviceId == localDeviceID
                            ? "iphone.gen3"
                            : "laptopcomputer.and.iphone")
                        VStack(alignment: .leading, spacing: 3) {
                            Text(device.deviceName?.nonEmpty ?? "可信设备")
                            if device.deviceId == localDeviceID {
                                Text("当前设备")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else if let lastUsed = device.lastUsedAt?.nonEmpty {
                                Text("上次使用 \(lastUsed)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Button(role: .destructive) {
                            pendingRevoke = device
                        } label: {
                            Image(systemName: "xmark.circle")
                        }
                        .buttonStyle(.borderless)
                    }
                }

                if dependencies.quickLoginCenter.serverDevices.isEmpty && !isBusy {
                    Text("尚未启用可信设备")
                        .foregroundStyle(.secondary)
                }
                Text("设备 secret 只保存在本机 Keychain，并由 Face ID、Touch ID 或设备密码保护。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .overlay {
            if isBusy {
                ProgressView()
            }
        }
        .task {
            await dependencies.quickLoginCenter.refreshDevices()
        }
        .alert("验证当前密码", isPresented: $showsPasswordEnrollment) {
            SecureField("当前密码", text: $password)
            Button("启用") {
                let submitted = password
                password = ""
                Task {
                    _ = await dependencies.quickLoginCenter.enrollUsingPassword(submitted)
                }
            }
            Button("取消", role: .cancel) { password = "" }
        } message: {
            Text("验证成功后，Athena 会为这台设备创建独立的零知识快速登录凭证。")
        }
        .confirmationDialog(
            "撤销这台可信设备？",
            isPresented: Binding(
                get: { pendingRevoke != nil },
                set: { if !$0 { pendingRevoke = nil } }
            )
        ) {
            Button("撤销", role: .destructive) {
                guard let device = pendingRevoke else { return }
                Task { _ = await dependencies.quickLoginCenter.revoke(device) }
            }
            Button("取消", role: .cancel) {}
        }
        .alert(
            "无法完成快速登录操作",
            isPresented: Binding(
                get: {
                    if case .failed = dependencies.quickLoginCenter.status {
                        return true
                    }
                    return false
                },
                set: { if !$0 { dependencies.quickLoginCenter.clearFailure() } }
            )
        ) {
            Button("好") { dependencies.quickLoginCenter.clearFailure() }
        } message: {
            if case .failed(let message) = dependencies.quickLoginCenter.status {
                Text(message)
            }
        }
    }

    private var localDeviceID: String? {
        dependencies.quickLoginCenter.preferredLocalDevice?.deviceId
    }

    private var isBusy: Bool {
        switch dependencies.quickLoginCenter.status {
        case .loading, .enrolling, .authenticating:
            true
        case .idle, .failed:
            false
        }
    }
}

struct PasskeySettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var pendingDelete: NativePasskey?

    var body: some View {
        List {
            Section {
                Button {
                    Task { _ = await center.registerPasskey() }
                } label: {
                    Label("添加通行密钥", systemImage: "touchid")
                }
                .disabled(center.isSaving(.passkeys))
                Label("注册过程会在 athenallm.online 完成，成功后自动返回 Athena。App 不会把登录 token 放入浏览器。", systemImage: "safari")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Section("已有通行密钥") {
                ForEach(center.passkeys) { passkey in
                    HStack(spacing: 12) {
                        Image(systemName: "touchid")
                        VStack(alignment: .leading, spacing: 3) {
                            Text(passkey.deviceName?.nonEmpty ?? passkey.providerName?.nonEmpty ?? "通行密钥")
                            Text([
                                passkey.providerName?.nonEmpty,
                                passkey.platformName?.nonEmpty,
                                passkey.lastUsedAt?.nonEmpty.map { "上次使用 \($0)" },
                            ].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(role: .destructive) { pendingDelete = passkey } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                if center.passkeys.isEmpty && !center.isLoading(.passkeys) {
                    Text("暂无通行密钥").foregroundStyle(.secondary)
                }
            }
        }
        .overlay { loadingOverlay(center.isLoading(.passkeys) && center.passkeys.isEmpty) }
        .task { await center.loadPasskeys() }
        .confirmationDialog("删除这枚通行密钥？", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        )) {
            Button("删除", role: .destructive) {
                guard let passkey = pendingDelete else { return }
                Task { _ = await center.deletePasskey(passkey, confirmRisk: true) }
            }
            Button("取消", role: .cancel) {}
        }
    }
    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
}

struct SessionDevicesSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var pendingSessionRevoke: NativeAuthSession?
    @State private var pendingDeviceRevoke: NativeClientDevice?
    @State private var confirmsOthers = false
    @State private var confirmsAll = false

    var body: some View {
        List {
            Section("登录会话") {
                ForEach(center.authSessions) { session in
                    HStack(spacing: 12) {
                        Image(systemName: session.current ? "iphone.circle.fill" : "rectangle.connected.to.line.below")
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(authModeTitle(session.authMode))
                                if session.current {
                                    Text("当前会话").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            if let lastSeen = session.lastSeenAt?.nonEmpty {
                                Text("最近活动 \(lastSeen)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if let clientID = session.clientId?.nonEmpty {
                                Text(clientID)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        Button(role: .destructive) { pendingSessionRevoke = session } label: {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                if center.authSessions.isEmpty && !center.isLoading(.sessions) {
                    Text("暂无可用登录会话").foregroundStyle(.secondary)
                }
            }
            Section {
                Button("退出其他会话", systemImage: "rectangle.stack.badge.minus", role: .destructive) {
                    confirmsOthers = true
                }
                .disabled(center.authSessions.filter { !$0.current }.isEmpty)
                Button("退出全部会话", systemImage: "rectangle.stack.badge.xmark", role: .destructive) {
                    confirmsAll = true
                }
                .disabled(center.authSessions.isEmpty)
            }
            Section("受信任客户端") {
                ForEach(center.clientDevices) { device in
                    HStack(spacing: 12) {
                        Image(systemName: device.platform == "ios" ? "iphone" : "desktopcomputer")
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(device.deviceName?.nonEmpty ?? "Athena 客户端")
                                if device.isCurrentClient {
                                    Text("当前设备").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text([device.platform, device.appVersion].compactMap { $0?.nonEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if let lastSeen = device.lastSeenAt?.nonEmpty {
                                Text("最近活动 \(lastSeen)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            if device.revokedAt != nil {
                                Text("已撤销")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.red)
                            }
                        }
                        Spacer()
                        if !device.isCurrentClient && device.revokedAt == nil {
                            Button(role: .destructive) { pendingDeviceRevoke = device } label: {
                                Image(systemName: "xmark.circle")
                            }.buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
        .overlay {
            loadingOverlay(
                (center.isLoading(.sessions) && center.authSessions.isEmpty)
                    || (center.isLoading(.devices) && center.clientDevices.isEmpty)
            )
        }
        .task {
            async let sessions: Void = center.loadAuthSessions()
            async let devices: Void = center.loadClientDevices()
            _ = await (sessions, devices)
        }
        .confirmationDialog("退出这个登录会话？", isPresented: Binding(
            get: { pendingSessionRevoke != nil },
            set: { if !$0 { pendingSessionRevoke = nil } }
        )) {
            Button("退出", role: .destructive) {
                guard let session = pendingSessionRevoke else { return }
                Task {
                    if await center.revokeAuthSession(session), session.current {
                        dependencies.signOut()
                    }
                }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("撤销这台设备？", isPresented: Binding(
            get: { pendingDeviceRevoke != nil },
            set: { if !$0 { pendingDeviceRevoke = nil } }
        )) {
            Button("撤销", role: .destructive) {
                guard let device = pendingDeviceRevoke else { return }
                Task { _ = await center.revokeClient(device) }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("退出所有其他登录会话？", isPresented: $confirmsOthers) {
            Button("全部退出", role: .destructive) {
                Task { _ = await center.revokeOtherAuthSessions() }
            }
            Button("取消", role: .cancel) {}
        }
        .confirmationDialog("退出全部登录会话？", isPresented: $confirmsAll) {
            Button("全部退出", role: .destructive) {
                Task {
                    if await center.revokeAllAuthSessions() { dependencies.signOut() }
                }
            }
            Button("取消", role: .cancel) {}
        }
    }
    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }

    private func authModeTitle(_ value: String) -> String {
        switch value {
        case "passkey": "通行密钥登录"
        case "zk": "可信设备登录"
        case "sso": "SSO 登录"
        case "invite": "邀请登录"
        default: "密码登录"
        }
    }
}

struct DataPrivacySettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var showsDelete = false

    var body: some View {
        List {
            Section("数据") {
                LabeledContent("数据导出", value: "暂不可用")
                Text("服务端尚无正式导出协议，因此不会生成虚假的下载结果。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("删除账户") {
                if let totals = center.deletionPreview?.totals {
                    LabeledContent("工作区", value: "\(totals.workspaceCount)")
                    LabeledContent("线程", value: "\(totals.threadCount)")
                    LabeledContent("聊天", value: "\(totals.chatCount)")
                    LabeledContent("文档", value: "\(totals.documentCount)")
                    LabeledContent("记忆", value: "\(totals.memoryCount)")
                }
                Button("永久删除账户", systemImage: "person.crop.circle.badge.minus", role: .destructive) {
                    showsDelete = true
                }
            }
        }
        .overlay { loadingOverlay(center.isLoading(.privacy) && center.deletionPreview == nil) }
        .task { await center.loadDeletionPreview() }
        .sheet(isPresented: $showsDelete) {
            AccountDeleteConfirmationView()
        }
    }
    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
}

private struct AccountDeleteConfirmationView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var confirmsFinalDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("此操作会永久删除当前环境中的账户数据，无法撤销。", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                    SecureField("当前密码", text: $password)
                }
                Section {
                    Button("继续删除", role: .destructive) { confirmsFinalDelete = true }
                        .disabled(password.isEmpty)
                }
            }
            .navigationTitle("删除账户")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .confirmationDialog("最终确认删除账户？", isPresented: $confirmsFinalDelete) {
                Button("永久删除", role: .destructive) {
                    Task {
                        if await dependencies.accountSettingsCenter.deleteAccount(currentPassword: password) {
                            dependencies.signOut()
                            dismiss()
                        }
                    }
                }
                Button("取消", role: .cancel) {}
            }
        }
    }
}

struct AppearanceSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    var body: some View {
        Form {
            Section("外观") {
                Picker("显示模式", selection: appearanceBinding) {
                    ForEach(AthenaAppearance.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.inline)
            }
        }
    }
    private var appearanceBinding: Binding<AthenaAppearance> {
        Binding(
            get: { dependencies.accountSettingsCenter.preferences.appearance },
            set: { dependencies.accountSettingsCenter.setAppearance($0) }
        )
    }
}

struct AppColorSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    var body: some View {
        List {
            Section {
                ForEach(AthenaAppAccent.allCases) { accent in
                    Button {
                        dependencies.accountSettingsCenter.setAccent(accent)
                    } label: {
                        HStack {
                            Circle().fill(accent.color).frame(width: 22, height: 22)
                            Text(accent.title).foregroundStyle(.primary)
                            Spacer()
                            if dependencies.accountSettingsCenter.preferences.accent == accent {
                                Image(systemName: "checkmark").foregroundStyle(accent.color)
                            }
                        }
                    }
                }
            } header: {
                Text("应用色")
            } footer: {
                Text("应用色仅保存在当前设备，不参与跨设备同步。")
            }
        }
    }
}

struct AIProviderSettingsView: View {
    @Environment(AppDependencies.self) private var dependencies
    @State private var pendingSecretClearKey: String?
    @State private var autosaveTask: Task<Void, Never>?

    var body: some View {
        Form {
            Section("当前配置") {
                LabeledContent(
                    "提供商",
                    value: store.snapshot?.configuration.provider ?? "未载入"
                )
                LabeledContent(
                    "模型",
                    value: store.snapshot?.configuration.model?.nonEmpty ?? currentModelTitle
                )
            }
            if store.canManage {
                Section("提供商") {
                    NavigationLink {
                        ProviderSelectionView()
                    } label: {
                        LabeledContent(
                            "主聊天提供商",
                            value: store.selectedProvider?.name ?? store.selectedProviderID
                        )
                    }
                }
                if let provider = store.selectedProvider {
                    Section(provider.name) {
                        ForEach(provider.fields) { field in
                            providerField(field)
                        }
                        if provider.supportsDynamicModels {
                            Button("读取可用模型", systemImage: "arrow.clockwise") {
                                Task { await center.loadProviderModels() }
                            }
                            .disabled(center.isLoading(.provider))
                        }
                    }
                }
            } else {
                Section("管理权限") {
                    LabeledContent("账户级别", value: roleTitle)
                    Text("提供商全局配置由管理员或所有者管理。密钥不会下发到当前设备。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .overlay {
            loadingOverlay(center.isLoading(.provider) && store.snapshot == nil)
        }
        .task {
            if store.snapshot == nil {
                await center.loadProviderSettings()
            }
        }
        .onChange(of: store.selectedProviderID) { _, _ in
            scheduleAutosave(immediate: true)
        }
        .onDisappear {
            autosaveTask?.cancel()
            guard store.hasUnsavedChanges else { return }
            Task { @MainActor in
                _ = await center.saveProviderSettings()
            }
        }
        .confirmationDialog(
            "清除已保存的密钥？",
            isPresented: Binding(
                get: { pendingSecretClearKey != nil },
                set: { if !$0 { pendingSecretClearKey = nil } }
            )
        ) {
            Button("清除", role: .destructive) {
                guard let key = pendingSecretClearKey else { return }
                store.updateSecretAction(key, action: "clear")
                store.updateField(key, value: "")
                pendingSecretClearKey = nil
                scheduleAutosave(immediate: true)
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("确认后服务端将删除该字段的现有密钥。")
        }
    }

    @ViewBuilder
    private func providerField(_ field: NativeProviderField) -> some View {
        if field.secret {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(field.label)
                    Spacer()
                    Text(secretStatus(field))
                        .foregroundStyle(.secondary)
                }
                Picker("操作", selection: secretActionBinding(field.key)) {
                    Text("保留").tag("keep")
                    Text("替换").tag("replace")
                    Text("清除").tag("clear-request")
                }
                .onChange(of: store.secretActions[field.key]) { _, action in
                    if action == "clear-request" {
                        store.updateSecretAction(field.key, action: "keep")
                        pendingSecretClearKey = field.key
                    } else if action == "keep" {
                        scheduleAutosave(immediate: true)
                    }
                }
                if store.secretActions[field.key] == "replace" {
                    SecureField("输入新的\(field.label)", text: fieldBinding(field.key))
                        .textContentType(.password)
                        .onSubmit {
                            scheduleAutosave(immediate: true)
                        }
                }
            }
        } else if !field.options.isEmpty {
            Picker(field.label, selection: fieldBinding(field.key)) {
                ForEach(field.options) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .onChange(of: store.fieldDrafts[field.key]) { _, _ in
                scheduleAutosave(immediate: true)
            }
        } else if isModelField(field), !store.modelOptions.isEmpty {
            Picker(field.label, selection: fieldBinding(field.key)) {
                ForEach(store.modelOptions) { model in
                    Text(model.name?.nonEmpty ?? model.id).tag(model.id)
                }
            }
            .onChange(of: store.fieldDrafts[field.key]) { _, _ in
                scheduleAutosave(immediate: true)
            }
        } else {
            TextField(field.label, text: fieldBinding(field.key))
                .keyboardType(field.type == "integer" ? .numberPad : (field.type == "url" ? .URL : .default))
                .textInputAutocapitalization(field.type == "url" ? .never : .sentences)
                .autocorrectionDisabled(field.type == "url")
                .onSubmit {
                    scheduleAutosave(immediate: true)
                }
        }
    }

    private var center: AccountSettingsCenter { dependencies.accountSettingsCenter }
    private var store: ProviderSettingsStore { center.providerStore }

    private func fieldBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { store.fieldDrafts[key] ?? "" },
            set: { value in
                store.updateField(key, value: value)
                scheduleAutosave()
            }
        )
    }

    private func secretActionBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { store.secretActions[key] ?? "keep" },
            set: { store.updateSecretAction(key, action: $0) }
        )
    }

    private func scheduleAutosave(immediate: Bool = false) {
        guard store.canManage, store.hasUnsavedChanges else { return }
        autosaveTask?.cancel()
        autosaveTask = Task { @MainActor in
            if !immediate {
                try? await Task.sleep(for: .milliseconds(700))
            }
            guard !Task.isCancelled else { return }
            while store.hasUnsavedChanges
                && !store.isCurrentDraftAwaitingReconciliation {
                if center.isSaving(.provider) {
                    try? await Task.sleep(for: .milliseconds(100))
                    guard !Task.isCancelled else { return }
                    continue
                }
                guard await center.saveProviderSettings() else { return }
            }
        }
    }

    private func secretStatus(_ field: NativeProviderField) -> String {
        if store.secretActions[field.key] == "replace" { return "待替换" }
        if store.secretActions[field.key] == "clear" { return "待清除" }
        return store.snapshot?.configuration.values[field.key]?.configured == true
            ? "已配置"
            : "未配置"
    }

    private func isModelField(_ field: NativeProviderField) -> Bool {
        field.key.hasSuffix("Model") || field.key.hasSuffix("ModelPref")
    }

    private var currentModelTitle: String {
        guard let workspaceID = dependencies.workspaceCenter.currentWorkspaceID,
              let workspace = dependencies.workspaceCenter.workspaces.first(where: { $0.id == workspaceID }) else {
            return "未选择"
        }
        let thread = workspace.threads.first(where: { $0.id == dependencies.workspaceCenter.currentThreadID })
        return (thread?.chatModel ?? workspace.chatModel ?? .pro).displayName
    }
    private var roleTitle: String {
        switch dependencies.accountProfileCenter.role?.lowercased() {
        case "owner": "所有者"
        case "admin": "管理员"
        default: "普通账号"
        }
    }
}

private struct ProviderSelectionView: View {
    @Environment(AppDependencies.self) private var dependencies
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    var body: some View {
        List(filteredProviders) { provider in
            Button {
                let center = dependencies.accountSettingsCenter
                center.providerStore.selectProvider(provider.id)
                Task { @MainActor in
                    _ = await center.saveProviderSettings()
                }
                dismiss()
            } label: {
                HStack {
                    Text(provider.name)
                        .foregroundStyle(.primary)
                    Spacer()
                    if provider.id == dependencies.accountSettingsCenter.providerStore.selectedProviderID {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.primary)
                    }
                }
            }
        }
        .navigationTitle("选择提供商")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "搜索提供商")
    }

    private var filteredProviders: [NativeProviderDescriptor] {
        let providers = dependencies.accountSettingsCenter.providerStore.catalog
        guard !searchText.isEmpty else { return providers }
        return providers.filter {
            $0.name.localizedCaseInsensitiveContains(searchText)
                || $0.id.localizedCaseInsensitiveContains(searchText)
        }
    }
}

@ViewBuilder
private func loadingOverlay(_ visible: Bool) -> some View {
    if visible {
        ProgressView()
            .controlSize(.large)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.background.opacity(0.7))
    }
}
