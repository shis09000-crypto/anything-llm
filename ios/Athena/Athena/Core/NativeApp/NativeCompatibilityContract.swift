import Foundation

enum NativeCompatibilityContract {
    private static let minimumOSVersion = "26.0"

    static func bootstrap(baseURL: URL) -> NativeAppBootstrap {
        NativeAppBootstrap(
            success: true,
            protocolVersion: "ios-native-v1",
            generatedAt: timestamp,
            app: NativeAppInfo(
                name: "Athena",
                platform: "ios",
                platforms: ["ios", "ipad"],
                minimumOSVersion: minimumOSVersion,
                deploymentVersion: nil,
                versionPolicy: NativeVersionPolicy(
                    minSupportedAppVersion: nil,
                    recommendedAppVersion: nil
                ),
                liquidGlass: LiquidGlassInfo(
                    nativeRequired: true,
                    swiftUIAvailability: "iOS 26+",
                    fallbackPromised: false
                )
            ),
            transport: NativeTransportInfo(
                apiBasePath: "/api",
                httpsRequired: true,
                webSocketSecureRequired: true,
                publicAppUrl: baseURL.absoluteString,
                sseSupported: true,
                webSocketSupported: true,
                runtime: nil
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
                    rpID: baseURL.host ?? "athenallm.online",
                    origin: baseURL.absoluteString
                ),
                appleSignInAvailable: false
            ),
            security: NativeSecurityInfo(
                clientIdentityRequired: true,
                clientIdentityHeaders: [
                    "clientId": "X-Athena-Client-Id",
                    "platform": "X-Athena-Platform",
                    "appVersion": "X-Athena-App-Version",
                    "requestId": "X-Athena-Request-Id",
                    "capabilitySource": "X-Athena-Capability-Source",
                ],
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
                requestSigningHeaders: [
                    "timestamp": "X-Athena-Timestamp",
                    "nonce": "X-Athena-Nonce",
                    "bodySha256": "X-Athena-Body-SHA256",
                    "signature": "X-Athena-Signature",
                    "signatureVersion": "X-Athena-Signature-Version",
                    "devicePublicKey": "X-Athena-Device-Public-Key",
                    "deviceKeyAlgorithm": "X-Athena-Device-Key-Algorithm",
                    "hybridSignatureVersion": "X-Athena-Hybrid-Signature-Version",
                    "pqSignature": "X-Athena-PQ-Signature",
                    "pqPublicKey": "X-Athena-PQ-Public-Key",
                    "pqKeyAlgorithm": "X-Athena-PQ-Key-Algorithm",
                    "pqKeyOrigin": "X-Athena-PQ-Key-Origin",
                    "pqHardwareProtection": "X-Athena-PQ-Hardware-Protection",
                ],
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
            readiness: nil
        )
    }

    static func preflight(profile: NativeClientProfile) -> NativeAppPreflight {
        let supportedPlatform = ["ios", "ipad"].contains(profile.platform.lowercased())
        let supportedOS = version(profile.osVersion, isAtLeast: minimumOSVersion)
        let reasons = [
            supportedPlatform ? nil : "unsupported_platform",
            supportedOS ? nil : "minimum_ios_26_required",
        ].compactMap { $0 }
        let blocked = !reasons.isEmpty

        return NativeAppPreflight(
            success: true,
            protocolVersion: "ios-native-v1",
            generatedAt: timestamp,
            platform: profile.platform,
            compatible: !blocked,
            blocked: blocked,
            updateRecommended: false,
            reasons: reasons,
            warnings: ["native_contract_route_unavailable"],
            policy: NativePreflightPolicy(
                minimumOSVersion: minimumOSVersion,
                minSupportedAppVersion: nil,
                recommendedAppVersion: nil
            ),
            appVersion: NativePreflightAppVersion(
                appVersion: profile.appVersion,
                minSupportedAppVersion: nil,
                recommendedAppVersion: nil,
                compatible: true,
                blocked: false,
                updateRecommended: false
            ),
            osVersion: NativePreflightOSVersion(
                osVersion: profile.osVersion,
                minimumOSVersion: minimumOSVersion,
                compatible: supportedOS,
                blocked: !supportedOS
            )
        )
    }

    private static var timestamp: String {
        ISO8601DateFormatter().string(from: Date())
    }

    private static func version(_ value: String, isAtLeast minimum: String) -> Bool {
        value.compare(minimum, options: .numeric) != .orderedAscending
    }
}
