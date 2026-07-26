import Foundation

enum PreviewData {
    static let workspaces: [WorkspaceSummary] = [
        WorkspaceSummary(
            id: "athena",
            name: "Athena",
            subtitle: "Native iOS adapter",
            threads: [
                ThreadSummary(id: "inbox", title: "Mobile scaffold", lastMessage: "Bootstrap, Reader, Agent"),
                ThreadSummary(id: "reader", title: "Reader review", lastMessage: "Preview and original access"),
                ThreadSummary(id: "agent", title: "Agent run", lastMessage: "Approval pending"),
            ]
        ),
        WorkspaceSummary(
            id: "research",
            name: "Research",
            subtitle: "Cross-device state",
            threads: [
                ThreadSummary(id: "sync", title: "User state sync", lastMessage: "Recent navigation restored"),
            ]
        ),
    ]

    static let messages: [ChatMessage] = [
        ChatMessage(id: "m1", role: .assistant, text: "Native bootstrap is ready."),
        ChatMessage(id: "m2", role: .user, text: "Keep the shell pure SwiftUI."),
        ChatMessage(id: "m3", role: .assistant, text: "Reader and Agent adapters are staged behind protocol boundaries."),
    ]

    static let readerDocuments: [ReaderDocumentSummary] = [
        ReaderDocumentSummary(id: "doc-contract", title: "iOS Native App Contract", kind: "Markdown", status: "Postprocessed", workspaceID: "athena"),
        ReaderDocumentSummary(id: "doc-reader", title: "Reader Preview Fixture", kind: "PDF", status: "Ready", workspaceID: "research"),
    ]

    static let agentEvents: [AgentEvent] = [
        AgentEvent(id: "approval-1", title: "Approve file read", detail: "Reader original access", kind: .approval),
        AgentEvent(id: "clarification-1", title: "Clarify next action", detail: "Choose whether to resume the run", kind: .clarification),
    ]

    static let bootstrap = NativeAppBootstrap(
        success: true,
        protocolVersion: "ios-native-v1",
        generatedAt: "2026-07-08T00:00:00.000Z",
        app: NativeAppInfo(
            name: "Athena",
            platform: "ios",
            platforms: ["ios", "ipad"],
            minimumOSVersion: "26.0",
            deploymentVersion: "local-preview",
            versionPolicy: NativeVersionPolicy(minSupportedAppVersion: nil, recommendedAppVersion: nil),
            liquidGlass: LiquidGlassInfo(nativeRequired: true, swiftUIAvailability: "iOS 26+", fallbackPromised: false)
        ),
        transport: NativeTransportInfo(
            apiBasePath: "/api",
            httpsRequired: true,
            webSocketSecureRequired: true,
            publicAppUrl: "https://athenallm.online",
            sseSupported: true,
            webSocketSupported: true,
            runtime: NativeTransportRuntime(
                mode: "production",
                production: true,
                httpsRequired: true,
                trustProxyEnabled: true,
                forceHttps: true,
                publicAppUrlHttps: true,
                hstsConfigured: true,
                tlsMinVersion: "TLSv1.2",
                tls13Recommended: true,
                webSocketSecureRequired: true
            )
        ),
        auth: NativeAuthInfo(
            passwordLoginPath: "/api/request-token",
            checkTokenPath: "/api/system/check-token",
            userActionPath: "/api/system/user-action",
            passkeyAvailable: true,
            nativePasskey: NativePasskeyInfo(
                serverAvailable: true,
                nativeAdapterRequired: true,
                associatedDomainsRequired: true,
                rpID: "athenallm.online",
                origin: "https://athenallm.online"
            ),
            appleSignInAvailable: false
        ),
        security: NativeSecurityInfo(
            clientIdentityRequired: true,
            clientIdentityHeaders: ["clientId": "X-Athena-Client-Id"],
            clientIdentityQuery: ["clientId": "athenaClientId"],
            nativeAppHeaders: ["osVersion": "X-Athena-OS-Version"],
            preferredSignatureVersion: AthenaCryptoSuiteRegistry.requestDeviceP256V2,
            cryptoSuiteRegistryVersion: AthenaCryptoSuiteRegistry.registryVersion,
            cryptoSuites: AthenaCryptoSuiteRegistry.strictPostQuantumSuites,
            highRiskRequestSigning: NativeHighRiskRequestSigningInfo(
                enforcementMode: "required",
                minimumOSVersion: "26.0",
                minimumAppVersion: "2.4.0",
                classicalSuiteId: AthenaCryptoSuiteRegistry.requestDeviceP256V2,
                postQuantumSuiteId: AthenaCryptoSuiteRegistry.requestDeviceMLDSA65V1,
                hybridSuiteId: AthenaCryptoSuiteRegistry.deviceHybridP256MLDSA65V1,
                hardwareBackedPostQuantumKeyRequired: true
            ),
            postQuantumExperiments: nil,
            requestSigningHeaders: ["signature": "X-Athena-Signature"],
            signingSecretPath: "/api/client-identity/signing-secret",
            sensitiveSessionHeader: "X-Athena-Sensitive-Session",
            opaque: nil
        ),
        features: NativeFeatureMap(
            workspaceThreads: true,
            chatSSE: true,
            reader: true,
            readerMaxUploadBytes: 524_288_000,
            agentWebSocket: true,
            broadcastWebSocket: true,
            broadcastDurableTransport: false,
            userStateSync: true,
            syncV2: false,
            nativePush: false,
            webPushOnly: true,
            universalLinks: false,
            fullOffline: false,
            admin: false,
            crypto: false,
            localModel: false
        ),
        endpoints: NativeEndpointMap(
            bootstrapPath: "/api/native-app/bootstrap",
            preflightPath: "/api/native-app/preflight",
            broadcastWebSocketPath: "/api/realtime/broadcast",
            syncEventsPath: "/api/sync/events",
            syncReplayPath: "/api/sync/events/replay",
            threadFingerprintsPath: "/api/sync/thread-fingerprints",
            nativePushTokenPath: "/api/native-app/push-token",
            userStatePath: "/api/system/user/state",
            readerStandaloneBasePath: "/api/reader-documents",
            readerWorkspaceBasePathTemplate: "/api/workspace/:slug/reader-documents",
            agentWebSocketPathTemplate: "/api/agent-invocation/:uuid",
            agentStatePathTemplate: "/api/agent-invocation/:uuid/state",
            appleAppSiteAssociationPath: "/.well-known/apple-app-site-association"
        ),
        readiness: NativeReadiness(
            p0: [
                NativeReadinessItem(id: "cloud_https_wss_api_base", status: "ready", owner: "server", selectedTransport: nil, detail: nil),
                NativeReadinessItem(id: "native_auth_keychain", status: "requires_native_client", owner: "ios", selectedTransport: nil, detail: nil),
            ],
            p1: [
                NativeReadinessItem(id: "broadcast_durable_transport", status: "requires_durable_transport", owner: "server", selectedTransport: "memory", detail: nil),
            ],
            summary: NativeReadinessSummary(
                serverP0Ready: true,
                serverP1Ready: false,
                nativeClientRequired: ["native_auth_keychain"],
                externalConfigurationRequired: ["broadcast_durable_transport"]
            )
        )
    )

    static let preflight = NativeAppPreflight(
        success: true,
        protocolVersion: "ios-native-v1",
        generatedAt: "2026-07-08T00:00:00.000Z",
        platform: "ios",
        compatible: true,
        blocked: false,
        updateRecommended: false,
        reasons: [],
        warnings: [],
        policy: NativePreflightPolicy(minimumOSVersion: "26.0", minSupportedAppVersion: nil, recommendedAppVersion: nil),
        appVersion: NativePreflightAppVersion(appVersion: "0.1.0", minSupportedAppVersion: nil, recommendedAppVersion: nil, compatible: true, blocked: false, updateRecommended: false),
        osVersion: NativePreflightOSVersion(osVersion: "26.0", minimumOSVersion: "26.0", compatible: true, blocked: false)
    )
}
