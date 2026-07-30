import Foundation
import Observation

enum AppSessionState: Equatable {
    case launching
    case signedOut(String?)
    case authenticating
    case restoringSession
    case loadingWorkspace
    case ready
    case blocked(String)
    case failed(String)
}

@MainActor
@Observable
final class AppDependencies {
    let apiClient: APIClient
    let nativeBootstrapClient: NativeBootstrapClient
    let authCenter: AuthCenter
    let accountProfileCenter: AccountProfileCenter
    let accountSettingsCenter: AccountSettingsCenter
    let passkeyAuthenticationClient: PasskeyAuthenticationClient
    let quickLoginCenter: QuickLoginCenter
    let clientIdentityCenter: ClientIdentityCenter
    let requestSigningCenter: RequestSigningCenter
    let deviceAttestationCenter: DeviceAttestationCenter
    let userRootKeyCenter: UserRootKeyCenter
    let realtimeBroadcastClient: RealtimeBroadcastClient
    let nativeSyncCenter: NativeSyncCenter
    let userStateSyncClient: UserStateSyncClient
    let readerKit: ReaderKit
    let agentControlKit: AgentControlKit
    let uploadDownloadManager: UploadDownloadManager
    let sensitiveSessionClient: SensitiveSessionClient
    let localCache: LocalCache
    let taskScheduler: TaskScheduler
    let optimisticActionCenter: NativeOptimisticActionCenter
    let recoveryCenter: NativeRecoveryCenter
    let serverStateCache: ServerStateCache
    let workspaceCenter: WorkspaceCenter
    let runtime: NativeAppRuntime

    var sessionState: AppSessionState
    var passkeyLoginError: String? = nil
    private var started = false
    private var applicationBackgrounded = false
    private var deferredStartupTask: Task<Void, Never>?
    private let clientIdentityRecoveryGate = APISecurityRecoveryGate()
    private let sessionRecoveryGate = APISecurityRecoveryGate()

    init(
        apiClient: APIClient,
        nativeBootstrapClient: NativeBootstrapClient,
        authCenter: AuthCenter,
        accountProfileCenter: AccountProfileCenter,
        accountSettingsCenter: AccountSettingsCenter,
        passkeyAuthenticationClient: PasskeyAuthenticationClient,
        quickLoginCenter: QuickLoginCenter,
        clientIdentityCenter: ClientIdentityCenter,
        requestSigningCenter: RequestSigningCenter,
        deviceAttestationCenter: DeviceAttestationCenter,
        userRootKeyCenter: UserRootKeyCenter,
        realtimeBroadcastClient: RealtimeBroadcastClient,
        nativeSyncCenter: NativeSyncCenter,
        userStateSyncClient: UserStateSyncClient,
        readerKit: ReaderKit,
        agentControlKit: AgentControlKit,
        uploadDownloadManager: UploadDownloadManager,
        sensitiveSessionClient: SensitiveSessionClient,
        localCache: LocalCache,
        taskScheduler: TaskScheduler,
        optimisticActionCenter: NativeOptimisticActionCenter,
        recoveryCenter: NativeRecoveryCenter,
        serverStateCache: ServerStateCache,
        workspaceCenter: WorkspaceCenter,
        runtime: NativeAppRuntime,
        sessionState: AppSessionState = .launching
    ) {
        self.apiClient = apiClient
        self.nativeBootstrapClient = nativeBootstrapClient
        self.authCenter = authCenter
        self.accountProfileCenter = accountProfileCenter
        self.accountSettingsCenter = accountSettingsCenter
        self.passkeyAuthenticationClient = passkeyAuthenticationClient
        self.quickLoginCenter = quickLoginCenter
        self.clientIdentityCenter = clientIdentityCenter
        self.requestSigningCenter = requestSigningCenter
        self.deviceAttestationCenter = deviceAttestationCenter
        self.userRootKeyCenter = userRootKeyCenter
        self.realtimeBroadcastClient = realtimeBroadcastClient
        self.nativeSyncCenter = nativeSyncCenter
        self.userStateSyncClient = userStateSyncClient
        self.readerKit = readerKit
        self.agentControlKit = agentControlKit
        self.uploadDownloadManager = uploadDownloadManager
        self.sensitiveSessionClient = sensitiveSessionClient
        self.localCache = localCache
        self.taskScheduler = taskScheduler
        self.optimisticActionCenter = optimisticActionCenter
        self.recoveryCenter = recoveryCenter
        self.serverStateCache = serverStateCache
        self.workspaceCenter = workspaceCenter
        self.runtime = runtime
        self.sessionState = sessionState
    }

    static func live() -> AppDependencies {
        let profile = NativeClientProfile.current()
        let baseURL: URL = {
            let productionURL = URL(string: "https://athenallm.online")!
            #if DEBUG
            guard
                let value = ProcessInfo.processInfo.environment[
                    "ATHENA_IOS_API_BASE_URL"
                ]?.trimmingCharacters(in: .whitespacesAndNewlines),
                let overrideURL = URL(string: value),
                overrideURL.scheme == "https",
                overrideURL.host?.isEmpty == false
            else {
                return productionURL
            }
            return overrideURL
            #else
            return productionURL
            #endif
        }()
        let apiConfiguration = APIClientConfiguration(
            baseURL: baseURL,
            appVersion: profile.appVersion,
            osVersion: profile.osVersion,
            platform: profile.platform
        )
        #if DEBUG
        let apiClient = APIClient(
            configuration: apiConfiguration,
            session: DevelopmentServerTrustDelegate.session(for: baseURL) ??
                .shared
        )
        #else
        let apiClient = APIClient(configuration: apiConfiguration)
        #endif
        let secureStore = KeychainStore(service: "online.athenallm.ios")
        let nativeBootstrapClient = NativeBootstrapClient(
            apiClient: apiClient,
            compatibilityBootstrap: NativeCompatibilityContract.bootstrap(baseURL: baseURL),
            compatibilityPreflight: NativeCompatibilityContract.preflight(profile: profile)
        )
        let authCenter = AuthCenter(secureStore: secureStore)
        let passkeyAuthenticationClient = PasskeyAuthenticationClient()
        let clientIdentityCenter = ClientIdentityCenter(secureStore: secureStore)
        let requestSigningCenter = RequestSigningCenter(secureStore: secureStore)
        let deviceAttestationCenter = DeviceAttestationCenter(
            secureStore: secureStore
        )
        let userRootKeyCenter = UserRootKeyCenter(secureStore: secureStore)
        let userStateSyncClient = UserStateSyncClient()
        let localCache = LocalCache()
        let taskScheduler = TaskScheduler()
        let quickLoginCenter = QuickLoginCenter(
            apiClient: apiClient,
            secureStore: secureStore,
            taskScheduler: taskScheduler,
            passkeyAuthenticationClient: passkeyAuthenticationClient
        )
        let optimisticActionCenter = NativeOptimisticActionCenter()
        let recoveryCenter = NativeRecoveryCenter()
        let serverStateCache = ServerStateCache(
            scheduler: taskScheduler,
            secureStore: secureStore
        )
        let accountProfileCenter = AccountProfileCenter(
            apiClient: apiClient,
            serverStateCache: serverStateCache,
            taskScheduler: taskScheduler
        )
        let sensitiveSessionClient = SensitiveSessionClient()
        let accountSettingsCenter = AccountSettingsCenter(
            apiClient: apiClient,
            taskScheduler: taskScheduler,
            optimisticActionCenter: optimisticActionCenter,
            recoveryCenter: recoveryCenter,
            localCache: localCache,
            serverStateCache: serverStateCache,
            profileCenter: accountProfileCenter,
            sensitiveSessionClient: sensitiveSessionClient,
            passkeyAuthenticationClient: passkeyAuthenticationClient
        )
        let chatStreamClient = ChatStreamClient(apiClient: apiClient)
        let agentControlKit = AgentControlKit(
            events: [],
            apiClient: apiClient,
            taskScheduler: taskScheduler,
            requestSigningCenter: requestSigningCenter,
            clientIdentityCenter: clientIdentityCenter,
            localCache: localCache
        )
        let workspaceAPI = WorkspaceAPI(apiClient: apiClient)
        let realtimeBroadcastClient = RealtimeBroadcastClient(
            apiClient: apiClient,
            requestSigningCenter: requestSigningCenter,
            clientIdentityCenter: clientIdentityCenter
        )
        let workspaceCenter = WorkspaceCenter(
            api: workspaceAPI,
            apiClient: apiClient,
            chatStreamClient: chatStreamClient,
            agentControlKit: agentControlKit,
            taskScheduler: taskScheduler,
            optimisticActionCenter: optimisticActionCenter,
            recoveryCenter: recoveryCenter,
            serverStateCache: serverStateCache,
            localCache: localCache,
            userStateSyncClient: userStateSyncClient,
            source: .live
        )
        let nativeSyncCenter = NativeSyncCenter(
            apiClient: apiClient,
            workspaceAPI: workspaceAPI,
            workspaceCenter: workspaceCenter,
            accountProfileCenter: accountProfileCenter,
            accountSettingsCenter: accountSettingsCenter,
            optimisticActionCenter: optimisticActionCenter,
            realtimeClient: realtimeBroadcastClient,
            taskScheduler: taskScheduler,
            secureStore: secureStore,
            clientIdentityCenter: clientIdentityCenter,
            serverStateCache: serverStateCache
        )
        let dependencies = AppDependencies(
            apiClient: apiClient,
            nativeBootstrapClient: nativeBootstrapClient,
            authCenter: authCenter,
            accountProfileCenter: accountProfileCenter,
            accountSettingsCenter: accountSettingsCenter,
            passkeyAuthenticationClient: passkeyAuthenticationClient,
            quickLoginCenter: quickLoginCenter,
            clientIdentityCenter: clientIdentityCenter,
            requestSigningCenter: requestSigningCenter,
            deviceAttestationCenter: deviceAttestationCenter,
            userRootKeyCenter: userRootKeyCenter,
            realtimeBroadcastClient: realtimeBroadcastClient,
            nativeSyncCenter: nativeSyncCenter,
            userStateSyncClient: userStateSyncClient,
            readerKit: ReaderKit(),
            agentControlKit: agentControlKit,
            uploadDownloadManager: UploadDownloadManager(),
            sensitiveSessionClient: sensitiveSessionClient,
            localCache: localCache,
            taskScheduler: taskScheduler,
            optimisticActionCenter: optimisticActionCenter,
            recoveryCenter: recoveryCenter,
            serverStateCache: serverStateCache,
            workspaceCenter: workspaceCenter,
            runtime: NativeAppRuntime()
        )
        apiClient.configureSecurity(
            authCenter: authCenter,
            clientIdentityCenter: clientIdentityCenter,
            requestSigningCenter: requestSigningCenter
        )
        apiClient.securityRecoveryHandler = { [weak dependencies] incident in
            await dependencies?.recover(from: incident) ?? false
        }
        agentControlKit.onSessionFinalized = { [weak workspaceCenter, weak agentControlKit] session in
            Task { @MainActor in
                let reconciled = await workspaceCenter?.reconcileFinalizedAgentSession(session) == true
                if reconciled {
                    agentControlKit?.completeReconciliation(invocationID: session.invocationID)
                }
            }
        }
        agentControlKit.onSessionFailed = { [weak workspaceCenter] session, message in
            workspaceCenter?.reconcileFailedAgentSession(session, message: message)
        }
        agentControlKit.onThreadRenamed = { [weak workspaceCenter] workspaceID, threadID, title in
            Task { @MainActor in
                await workspaceCenter?.applySyncedThreadMetadata(
                    workspaceID: workspaceID,
                    threadID: threadID,
                    title: title
                )
            }
        }
        nativeSyncCenter.setSecurityIncidentHandler { [weak dependencies] incident in
            _ = await dependencies?.recover(from: incident)
        }
        workspaceCenter.restoreMutationSecurity = { [weak dependencies] in
            await dependencies?.restoreMutationSecurity() ?? false
        }
        workspaceCenter.onSelectionChanged = { [weak nativeSyncCenter] workspaceID, threadID in
            Task { @MainActor in
                await nativeSyncCenter?.updateSelection(
                    workspaceID: workspaceID,
                    threadID: threadID
                )
            }
        }
        return dependencies
    }

    static func preview(
        workspaces: [AthenaWorkspace] = WorkspacePreviewFixtures.workspaces,
        selectedThreadID: String = WorkspacePreviewFixtures.selectedThreadID
    ) -> AppDependencies {
        let apiClient = APIClient(
            configuration: APIClientConfiguration(
                baseURL: URL(string: "https://athenallm.online")!,
                appVersion: "0.1.0",
                osVersion: "26.0",
                platform: "ios"
            )
        )
        let secureStore = InMemorySecureValueStore()
        let nativeBootstrapClient = NativeBootstrapClient(
            apiClient: apiClient,
            fixtureBootstrap: PreviewData.bootstrap,
            fixturePreflight: PreviewData.preflight
        )
        let authCenter = AuthCenter(secureStore: secureStore)
        let passkeyAuthenticationClient = PasskeyAuthenticationClient()
        let clientIdentityCenter = ClientIdentityCenter(secureStore: secureStore)
        let requestSigningCenter = RequestSigningCenter(secureStore: secureStore)
        let deviceAttestationCenter = DeviceAttestationCenter(
            secureStore: secureStore
        )
        let userRootKeyCenter = UserRootKeyCenter(secureStore: secureStore)
        let userStateSyncClient = UserStateSyncClient()
        let localCache = LocalCache()
        let taskScheduler = TaskScheduler()
        let quickLoginCenter = QuickLoginCenter(
            apiClient: apiClient,
            secureStore: secureStore,
            taskScheduler: taskScheduler,
            passkeyAuthenticationClient: passkeyAuthenticationClient
        )
        let optimisticActionCenter = NativeOptimisticActionCenter()
        let recoveryCenter = NativeRecoveryCenter()
        let serverStateCache = ServerStateCache(
            scheduler: taskScheduler,
            secureStore: secureStore
        )
        let accountProfileCenter = AccountProfileCenter(
            apiClient: apiClient,
            serverStateCache: serverStateCache,
            taskScheduler: taskScheduler
        )
        let sensitiveSessionClient = SensitiveSessionClient()
        let accountSettingsCenter = AccountSettingsCenter(
            apiClient: apiClient,
            taskScheduler: taskScheduler,
            optimisticActionCenter: optimisticActionCenter,
            recoveryCenter: recoveryCenter,
            localCache: localCache,
            serverStateCache: serverStateCache,
            profileCenter: accountProfileCenter,
            sensitiveSessionClient: sensitiveSessionClient,
            passkeyAuthenticationClient: passkeyAuthenticationClient
        )
        let previewUser = AthenaUser(
            id: 1,
            username: "athena-owner",
            role: "owner",
            email: "owner@athena.example",
            phone: nil,
            displayName: "Athena Owner",
            pfpFilename: nil,
            bio: nil
        )
        accountProfileCenter.seedPreview(user: previewUser)
        accountSettingsCenter.start(ownerScope: "preview-owner")
        #if DEBUG
        accountSettingsCenter.seedPreview()
        #endif
        let agentControlKit = AgentControlKit(events: PreviewData.agentEvents)
        let workspaceCenter = WorkspaceCenter(
            api: nil,
            apiClient: nil,
            agentControlKit: agentControlKit,
            taskScheduler: taskScheduler,
            optimisticActionCenter: optimisticActionCenter,
            recoveryCenter: recoveryCenter,
            serverStateCache: serverStateCache,
            localCache: localCache,
            userStateSyncClient: userStateSyncClient,
            source: .preview,
            workspaces: workspaces,
            selectedThreadID: selectedThreadID
        )
        let realtimeBroadcastClient = RealtimeBroadcastClient()
        let nativeSyncCenter = NativeSyncCenter(
            apiClient: apiClient,
            workspaceAPI: WorkspaceAPI(apiClient: apiClient),
            workspaceCenter: workspaceCenter,
            accountProfileCenter: accountProfileCenter,
            accountSettingsCenter: accountSettingsCenter,
            optimisticActionCenter: optimisticActionCenter,
            realtimeClient: realtimeBroadcastClient,
            taskScheduler: taskScheduler,
            secureStore: secureStore,
            clientIdentityCenter: clientIdentityCenter,
            serverStateCache: serverStateCache
        )
        let dependencies = AppDependencies(
            apiClient: apiClient,
            nativeBootstrapClient: nativeBootstrapClient,
            authCenter: authCenter,
            accountProfileCenter: accountProfileCenter,
            accountSettingsCenter: accountSettingsCenter,
            passkeyAuthenticationClient: passkeyAuthenticationClient,
            quickLoginCenter: quickLoginCenter,
            clientIdentityCenter: clientIdentityCenter,
            requestSigningCenter: requestSigningCenter,
            deviceAttestationCenter: deviceAttestationCenter,
            userRootKeyCenter: userRootKeyCenter,
            realtimeBroadcastClient: realtimeBroadcastClient,
            nativeSyncCenter: nativeSyncCenter,
            userStateSyncClient: userStateSyncClient,
            readerKit: ReaderKit(documents: PreviewData.readerDocuments),
            agentControlKit: agentControlKit,
            uploadDownloadManager: UploadDownloadManager(),
            sensitiveSessionClient: sensitiveSessionClient,
            localCache: localCache,
            taskScheduler: taskScheduler,
            optimisticActionCenter: optimisticActionCenter,
            recoveryCenter: recoveryCenter,
            serverStateCache: serverStateCache,
            workspaceCenter: workspaceCenter,
            runtime: NativeAppRuntime(bootstrap: PreviewData.bootstrap, preflight: PreviewData.preflight),
            sessionState: .ready
        )
        apiClient.configureSecurity(
            authCenter: authCenter,
            clientIdentityCenter: clientIdentityCenter,
            requestSigningCenter: requestSigningCenter
        )
        dependencies.applyBootstrap(PreviewData.bootstrap)
        return dependencies
    }

    func start() async {
        guard !started else {
            return
        }
        started = true
        sessionState = .launching
        let launchStartedAt = Date()
        AppPerformanceSignposts.event("LaunchGateStarted")

        do {
            try authCenter.restore()
        } catch {
            try? authCenter.clearToken()
        }
        var hasStoredSession = authCenter.accessToken != nil
        let hasRecoveryBinding = authCenter.hasSessionRecoveryBinding()

        let runtimeTask = Task { @MainActor [weak self] in
            AppPerformanceSignposts.event("RuntimeBootstrapStarted")
            await self?.refreshNativeRuntime()
            AppPerformanceSignposts.event("RuntimeBootstrapFinished")
        }
        await waitForLaunchGate(startedAt: launchStartedAt)
        AppPerformanceSignposts.event("LaunchGateFinished")
        sessionState = hasStoredSession || hasRecoveryBinding
            ? .restoringSession
            : .signedOut(nil)

        await runtimeTask.value
        guard case .loaded = runtime.loadState else {
            if hasStoredSession || hasRecoveryBinding {
                sessionState = .failed(runtimeErrorMessage)
            }
            return
        }
        guard runtime.preflight?.blocked != true else {
            sessionState = .blocked(runtime.preflight?.reasons.joined(separator: "\n") ?? "当前版本不可用。")
            return
        }
        guard requestSigningCenter.postQuantumContractReady else {
            sessionState = .blocked(postQuantumContractErrorMessage)
            return
        }

        do {
            let clientID = try clientIdentityCenter.prepare()
            try requestSigningCenter.prepareDeviceKey()
            try await authCenter.refreshLoginMode(using: apiClient)
            if authCenter.accessToken == nil, hasRecoveryBinding {
                switch await authCenter.recoverStoredSession(
                    clientID: clientID,
                    source: "bootstrap",
                    using: apiClient
                ) {
                case .recovered:
                    hasStoredSession = true
                case .unavailable(let reason, let transient, _):
                    if transient {
                        sessionState = .failed(
                            "登录状态恢复暂时不可用（\(reason)），网络恢复后可直接重试。"
                        )
                    } else {
                        sessionState = .signedOut(nil)
                    }
                    return
                }
            }
            guard hasStoredSession, authCenter.accessToken != nil else {
                return
            }

            AppPerformanceSignposts.event("SessionValidationStarted")
            try await runSecurityTask(label: "auth:validate-session") { [self] in
                try await self.authCenter.validateStoredSession(using: self.apiClient)
            }
            AppPerformanceSignposts.event("SessionValidationFinished")
            try await completeAuthenticatedStartup()
        } catch {
            if isAuthenticationFailure(error) {
                signOut()
                sessionState = .signedOut(error.localizedDescription)
                return
            }
            if !hasStoredSession || authCenter.accessToken == nil {
                sessionState = .signedOut(nil)
            } else {
                sessionState = .failed(error.localizedDescription)
            }
        }
    }

    func login(identifier: String, password: String) async {
        guard requestSigningCenter.postQuantumContractReady else {
            sessionState = .blocked(postQuantumContractErrorMessage)
            return
        }
        sessionState = .authenticating
        do {
            _ = try clientIdentityCenter.prepare()
            try requestSigningCenter.prepareDeviceKey()
            try await authCenter.login(
                identifier: identifier.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password,
                using: apiClient
            )
            try await completeAuthenticatedStartup()
        } catch {
            if authCenter.accessToken == nil {
                sessionState = .signedOut(error.localizedDescription)
            } else {
                sessionState = .failed(error.localizedDescription)
            }
        }
    }

    func loginWithPasskey() async {
        guard requestSigningCenter.postQuantumContractReady else {
            sessionState = .blocked(postQuantumContractErrorMessage)
            return
        }
        passkeyLoginError = nil
        sessionState = .authenticating
        do {
            _ = try clientIdentityCenter.prepare()
            try requestSigningCenter.prepareDeviceKey()
            try await authCenter.loginWithPasskey(
                using: apiClient,
                authenticator: passkeyAuthenticationClient
            )
            try await completeAuthenticatedStartup()
        } catch PasskeyAuthenticationError.cancelled {
            sessionState = .signedOut(nil)
        } catch {
            if authCenter.accessToken == nil {
                passkeyLoginError = "通行密钥登录失败，请使用账号密码登录。"
                sessionState = .signedOut(nil)
            } else {
                sessionState = .failed(error.localizedDescription)
            }
        }
    }

    func loginWithQuickLogin(_ device: LocalQuickLoginDevice) async {
        sessionState = .authenticating
        do {
            _ = try clientIdentityCenter.prepare()
            try requestSigningCenter.prepareDeviceKey()
            let session = try await quickLoginCenter.login(device)
            try authCenter.acceptAuthenticatedSession(
                token: session.token,
                user: session.user
            )
            try await completeAuthenticatedStartup()
        } catch {
            if authCenter.accessToken == nil {
                sessionState = .signedOut(error.localizedDescription)
            } else {
                sessionState = .failed(error.localizedDescription)
            }
        }
    }

    func retryAuthenticatedStartup() async {
        do {
            sessionState = .restoringSession
            let clientID = try clientIdentityCenter.prepare()
            try requestSigningCenter.prepareDeviceKey()
            if authCenter.accessToken == nil {
                guard authCenter.hasSessionRecoveryBinding(for: clientID) else {
                    sessionState = .signedOut(nil)
                    return
                }
                switch await authCenter.recoverStoredSession(
                    clientID: clientID,
                    source: "bootstrap",
                    using: apiClient
                ) {
                case .recovered:
                    break
                case .unavailable(let reason, let transient, _):
                    sessionState = transient
                        ? .failed(
                            "登录状态恢复暂时不可用（\(reason)），网络恢复后可直接重试。"
                        )
                        : .signedOut(nil)
                    return
                }
            }
            try await runSecurityTask(label: "auth:validate-session") { [self] in
                try await self.authCenter.validateStoredSession(using: self.apiClient)
            }
            try await completeAuthenticatedStartup()
        } catch {
            if isAuthenticationFailure(error) {
                signOut()
                sessionState = .signedOut(error.localizedDescription)
                return
            }
            sessionState = authCenter.accessToken == nil
                ? .signedOut(error.localizedDescription)
                : .failed(error.localizedDescription)
        }
    }

    func useCachedWorkspaceFallback() async {
        guard authCenter.accessToken != nil else {
            sessionState = .signedOut(nil)
            return
        }
        if await workspaceCenter.useCachedFallback() {
            sessionState = .ready
        }
    }

    func restart() async {
        deferredStartupTask?.cancel()
        deferredStartupTask = nil
        started = false
        await start()
    }

    func signOut(resetDeviceIdentity: Bool = false) {
        deferredStartupTask?.cancel()
        deferredStartupTask = nil
        nativeSyncCenter.stop(clearCursor: true)
        agentControlKit.signOut()
        workspaceCenter.reset(clearAuthenticatedCache: true)
        MarkdownRenderCache.shared.clear()
        accountProfileCenter.reset()
        accountSettingsCenter.reset()
        quickLoginCenter.resetAuthenticatedState()
        optimisticActionCenter.clearAll()
        recoveryCenter.dismissNotice()
        Task {
            await taskScheduler.cancelAll(reason: "sign-out")
        }
        localCache.clearAllWorkspaceSnapshots()
        userStateSyncClient.reset()
        try? requestSigningCenter.clearSigningSecret()
        try? authCenter.clearToken()
        try? authCenter.clearSessionRecoveryBinding()
        userRootKeyCenter.lock()
        if resetDeviceIdentity {
            try? userRootKeyCenter.resetDeviceIdentity()
            try? requestSigningCenter.resetDeviceKey()
            try? clientIdentityCenter.reset()
        }
        sessionState = .signedOut(nil)
    }

    func refreshNativeRuntime() async {
        await runtime.refresh(using: nativeBootstrapClient)
        applyBootstrap(runtime.bootstrap)
    }

    func restoreMutationSecurity() async -> Bool {
        guard authCenter.accessToken != nil,
              clientIdentityCenter.clientID != nil else {
            return false
        }
        do {
            try requestSigningCenter.prepareDeviceKey()
            try await runSecurityTask(label: "security:refresh-signing-secret") { [self] in
                try await self.requestSigningCenter.refreshSigningSecret(using: self.apiClient)
            }
            return requestSigningCenter.status == .ready
        } catch {
            return false
        }
    }

    func setApplicationBackgrounded(_ backgrounded: Bool) async {
        guard applicationBackgrounded != backgrounded else {
            return
        }
        applicationBackgrounded = backgrounded
        if backgrounded {
            sensitiveSessionClient.end()
            accountSettingsCenter.clearSensitiveMemory()
        }
        await taskScheduler.setPaused(
            .p3,
            paused: backgrounded,
            reason: "application-background"
        )
        await taskScheduler.setPaused(
            .p4,
            paused: backgrounded,
            reason: "application-background"
        )
        await workspaceCenter.setApplicationBackgrounded(backgrounded)
        await agentControlKit.setApplicationBackgrounded(backgrounded)
        await nativeSyncCenter.setApplicationBackgrounded(backgrounded)
        if backgrounded {
            NativeAppDelegate.scheduleRefresh()
        }
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        authCenter.applyBootstrap(bootstrap)
        clientIdentityCenter.applyBootstrap(bootstrap)
        requestSigningCenter.applyBootstrap(bootstrap)
        realtimeBroadcastClient.applyBootstrap(bootstrap)
        nativeSyncCenter.applyBootstrap(bootstrap)
        userStateSyncClient.applyBootstrap(bootstrap)
        readerKit.applyBootstrap(bootstrap)
        agentControlKit.applyBootstrap(bootstrap)
        sensitiveSessionClient.applyBootstrap(bootstrap)
        quickLoginCenter.applyBootstrap(bootstrap)
        localCache.applyBootstrap(bootstrap)
    }

    private func completeAuthenticatedStartup() async throws {
        deferredStartupTask?.cancel()
        sessionState = .loadingWorkspace
        try await runSecurityTask(label: "security:refresh-signing-secret") { [self] in
            try await self.requestSigningCenter.refreshSigningSecret(using: self.apiClient)
        }
        do {
            _ = try await runSecurityTask(label: "security:migrate-device-key") { [self] in
                try await self.requestSigningCenter.migrateDeviceKeyToSecureEnclave(
                    using: self.apiClient
                )
            }
        } catch {
            // Secure Enclave migration hardens an already authenticated client,
            // but the existing signing key remains valid when migration is not
            // yet supported by the server. Authentication failures still leave
            // through the normal security recovery path.
            guard authCenter.accessToken != nil else {
                throw error
            }
        }
        if let clientID = clientIdentityCenter.clientID {
            do {
                try await runSecurityTask(
                    label: "auth:session-recovery-enroll"
                ) { [self] in
                    try await self.authCenter.enrollSessionRecovery(
                        clientID: clientID,
                        using: self.apiClient
                    )
                }
            } catch {
                // Enrollment only adds silent recovery for this existing
                // device-bound session. A transient enrollment failure must
                // not invalidate the session that just authenticated.
            }
        }
        if #available(iOS 26.0, *),
           let clientID = clientIdentityCenter.clientID
        {
            do {
                _ = try await runSecurityTask(
                    label: "security:device-attestation"
                ) { [self] in
                    try await self.deviceAttestationCenter
                        .establishBoundDeviceIdentity(
                            clientID: clientID,
                            using: self.apiClient
                        )
                }
            } catch {
                // Attestation is a fail-closed gate for high-risk operations,
                // not for restoring cached workspaces or reading ordinary data.
                // The next authenticated startup retries the durable challenge.
                guard authCenter.accessToken != nil else {
                    throw error
                }
            }
        }
        if let authUserID = authCenter.user?.authenticationID,
           let clientID = clientIdentityCenter.clientID
        {
            do {
                _ = try await runSecurityTask(
                    label: "security:user-root-status"
                ) { [self] in
                    try await self.userRootKeyCenter.refresh(
                        authUserId: authUserID,
                        clientId: clientID,
                        using: self.apiClient
                    )
                }
            } catch {
                // Root readiness is required only by Root-backed data domains.
                // Existing UMK/VMK and ordinary reads remain available while a
                // legacy account initializes or a new device awaits approval.
                guard authCenter.accessToken != nil else {
                    throw error
                }
            }
        }
        let ownerScope = authCenter.cacheOwnerScope(
            fallbackClientID: clientIdentityCenter.clientID
        )
        let readinessGate = StartupReadinessGate()
        deferredStartupTask = Task { @MainActor [weak self] in
            guard let self else {
                readinessGate.fail(CancellationError())
                return
            }
            do {
                _ = await self.accountProfileCenter.prepare(
                    ownerScope: ownerScope,
                    user: self.authCenter.user
                )
                self.accountSettingsCenter.start(ownerScope: ownerScope)
                await self.workspaceCenter.restoreCachedStartup(
                    ownerScope: ownerScope
                ) { [weak self] in
                    AppPerformanceSignposts.event("PriorityConversationReady")
                    self?.sessionState = .ready
                    readinessGate.succeed()
                }

                // Sync V2 now owns the first authoritative navigation/profile
                // hydration. Legacy repository reads below remain the fallback
                // for uncovered nodes, failures and security-sensitive state.
                _ = await self.nativeSyncCenter.start(ownerScope: ownerScope)
                try await self.workspaceCenter.bootstrap(ownerScope: ownerScope) { [weak self] in
                    AppPerformanceSignposts.event("PriorityConversationReady")
                    self?.sessionState = .ready
                    readinessGate.succeed()
                }
                if !readinessGate.isResolved {
                    self.sessionState = .ready
                    readinessGate.succeed()
                }

                await Task.yield()
                guard !Task.isCancelled, self.authCenter.accessToken != nil else {
                    return
                }
                AppPerformanceSignposts.event("DeferredCentersStarted")
                await self.accountProfileCenter.start(
                    ownerScope: ownerScope,
                    user: self.authCenter.user
                )
                await self.quickLoginCenter.start(
                    ownerScope: ownerScope,
                    user: self.authCenter.user
                )
                await self.workspaceCenter.restorePersistedChatStreams()
                await self.agentControlKit.restorePersistedSessions(ownerScope: ownerScope)
                AppPerformanceSignposts.event("DeferredCentersFinished")
            } catch {
                if !readinessGate.isResolved {
                    if self.isTransientServiceFailure(error),
                       await self.workspaceCenter.useCachedFallback()
                    {
                        self.workspaceCenter.lastError = error.localizedDescription
                        self.sessionState = .ready
                        readinessGate.succeed()
                    } else {
                        readinessGate.fail(error)
                    }
                } else if !Task.isCancelled {
                    self.workspaceCenter.lastError = error.localizedDescription
                }
            }
        }
        try await readinessGate.wait()
        AppPerformanceSignposts.event("FirstInteractiveFrameScheduled")
    }

    private func runSecurityTask<Value: Sendable>(
        label: String,
        operation: @escaping @MainActor @Sendable () async throws -> Value
    ) async throws -> Value {
        try await taskScheduler.run(
            AthenaTaskDescriptor(
                label: label,
                kind: "security",
                priority: .p0,
                intentRank: 0,
                executionClass: .security,
                policy: .foreground,
                resource: .network,
                scope: AthenaTaskScope(route: "auth", surface: label, transport: "http"),
                isProtected: true,
                isAbortable: false
            )
        ) { context in
            try context.checkCancellation()
            return try await operation()
        }
    }

    private func recover(from incident: APISecurityIncident) async -> Bool {
        switch incident {
        case .signingSecretRotated:
            do {
                try requestSigningCenter.clearSigningSecret()
                try await requestSigningCenter.refreshSigningSecret(using: apiClient)
                return true
            } catch {
                return false
            }
        case .invalidSignature:
            return await restoreMutationSecurity()
        case .clientRevoked:
            signOut(resetDeviceIdentity: true)
            return false
        case .clientIdentityReauthRequired:
            return await clientIdentityRecoveryGate.run { [weak self] in
                guard let self else { return false }
                return await self.reauthenticateClientIdentity()
            }
        case .sessionExpired:
            return await sessionRecoveryGate.run { [weak self] in
                guard
                    let self,
                    let clientID = self.clientIdentityCenter.clientID,
                    self.authCenter.hasSessionRecoveryBinding(for: clientID)
                else {
                    self?.signOut()
                    return false
                }
                switch await self.authCenter.recoverStoredSession(
                    clientID: clientID,
                    source: "api",
                    using: self.apiClient
                ) {
                case .recovered:
                    return true
                case .unavailable(_, let transient, let terminal):
                    if terminal || !transient {
                        self.signOut()
                    }
                    return false
                }
            }
        }
    }

    private func reauthenticateClientIdentity() async -> Bool {
        guard authCenter.passkeyAvailable,
              authCenter.nativePasskey?.serverAvailable == true else {
            signOut(resetDeviceIdentity: true)
            return false
        }

        sessionState = .restoringSession
        nativeSyncCenter.stop(clearCursor: false)
        do {
            try authCenter.clearSessionRecoveryBinding()
            try authCenter.clearToken()
            try userRootKeyCenter.resetDeviceIdentity()
            try requestSigningCenter.resetDeviceKey()
            try clientIdentityCenter.reset()
            _ = try clientIdentityCenter.prepare()
            try requestSigningCenter.prepareDeviceKey()
            try await authCenter.loginWithPasskey(
                using: apiClient,
                authenticator: passkeyAuthenticationClient
            )
            try await completeAuthenticatedStartup()
            await deferredStartupTask?.value
            return authCenter.accessToken != nil && sessionState == .ready
        } catch PasskeyAuthenticationError.cancelled {
            signOut()
            return false
        } catch {
            passkeyLoginError = "设备身份恢复失败，请重新登录。"
            signOut()
            return false
        }
    }

    private var runtimeErrorMessage: String {
        if case .failed(let message) = runtime.loadState {
            return message
        }
        return "无法完成原生客户端启动检查。"
    }

    private var postQuantumContractErrorMessage: String {
        "当前设备未能建立 Athena 2.4 所要求的硬件后量子签名能力。请确认已安装最新版 Athena；系统不会降级到旧签名协议。"
    }

    private func waitForLaunchGate(startedAt: Date) async {
        let remaining = 0.35 - Date().timeIntervalSince(startedAt)
        guard remaining > 0 else { return }
        try? await Task.sleep(for: .seconds(remaining))
    }

    private func isAuthenticationFailure(_ error: Error) -> Bool {
        guard let authError = error as? AuthCenterError else {
            return false
        }
        switch authError {
        case .invalidCredentials, .invalidSession, .missingToken:
            return true
        }
    }

    private func isTransientServiceFailure(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return [
                .timedOut,
                .cannotFindHost,
                .cannotConnectToHost,
                .networkConnectionLost,
                .dnsLookupFailed,
                .notConnectedToInternet,
            ].contains(urlError.code)
        }
        guard let apiError = error as? APIClientError,
              case .httpStatus(let status, _, _) = apiError else {
            return false
        }
        return [502, 503, 504].contains(status)
    }
}

@MainActor
private final class StartupReadinessGate {
    private var result: Result<Void, Error>?
    private var continuation: CheckedContinuation<Void, Error>?

    var isResolved: Bool {
        result != nil
    }

    func wait() async throws {
        if let result {
            return try result.get()
        }
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func succeed() {
        resolve(.success(()))
    }

    func fail(_ error: Error) {
        resolve(.failure(error))
    }

    private func resolve(_ result: Result<Void, Error>) {
        guard self.result == nil else {
            return
        }
        self.result = result
        continuation?.resume(with: result)
        continuation = nil
    }
}
