import Foundation

struct NativeAppBootstrap: Decodable, Equatable {
    let success: Bool
    let protocolVersion: String
    let generatedAt: String
    let app: NativeAppInfo
    let transport: NativeTransportInfo
    let auth: NativeAuthInfo
    let security: NativeSecurityInfo
    let features: NativeFeatureMap
    let endpoints: NativeEndpointMap
    let readiness: NativeReadiness?
}

struct NativeAppInfo: Decodable, Equatable {
    let name: String
    let platform: String
    let platforms: [String]
    let minimumOSVersion: String
    let deploymentVersion: String?
    let versionPolicy: NativeVersionPolicy?
    let liquidGlass: LiquidGlassInfo
}

struct NativeVersionPolicy: Decodable, Equatable {
    let minSupportedAppVersion: String?
    let recommendedAppVersion: String?
}

struct LiquidGlassInfo: Decodable, Equatable {
    let nativeRequired: Bool
    let swiftUIAvailability: String
    let fallbackPromised: Bool
}

struct NativeTransportInfo: Decodable, Equatable {
    let apiBasePath: String
    let httpsRequired: Bool
    let webSocketSecureRequired: Bool
    let publicAppUrl: String?
    let sseSupported: Bool
    let webSocketSupported: Bool
    let runtime: NativeTransportRuntime?
}

struct NativeTransportRuntime: Decodable, Equatable {
    let mode: String?
    let production: Bool?
    let httpsRequired: Bool?
    let trustProxyEnabled: Bool?
    let forceHttps: Bool?
    let publicAppUrlHttps: Bool?
    let hstsConfigured: Bool?
    let tlsMinVersion: String?
    let tls13Recommended: Bool?
    let webSocketSecureRequired: Bool?
}

struct NativeAuthInfo: Decodable, Equatable {
    let passwordLoginPath: String
    let checkTokenPath: String
    let userActionPath: String
    let passkeyAvailable: Bool
    let nativePasskey: NativePasskeyInfo?
    let appleSignInAvailable: Bool
}

struct NativePasskeyInfo: Decodable, Equatable {
    let serverAvailable: Bool
    let nativeAdapterRequired: Bool
    let associatedDomainsRequired: Bool
    let rpID: String?
    let origin: String?
}

struct NativeSecurityInfo: Decodable, Equatable {
    let clientIdentityRequired: Bool
    let clientIdentityHeaders: [String: String]?
    let clientIdentityQuery: [String: String]?
    let nativeAppHeaders: [String: String]?
    let preferredSignatureVersion: String
    let requestSigningHeaders: [String: String]?
    let signingSecretPath: String
    let sensitiveSessionHeader: String
    let opaque: NativeOpaqueInfo?
}

struct NativeOpaqueInfo: Decodable, Equatable {
    let available: Bool
    let protocolVersion: String
    let keyStretching: String
    let serverStaticPublicKey: String?
    let serverStaticPublicKeyFingerprint: String?
    let status: String?
}

struct NativeFeatureMap: Decodable, Equatable {
    let workspaceThreads: Bool
    let chatSSE: Bool
    let reader: Bool
    let readerMaxUploadBytes: Int64
    let agentWebSocket: Bool
    let broadcastWebSocket: Bool
    let broadcastDurableTransport: Bool?
    let userStateSync: Bool
    let syncV2: Bool?
    let nativePush: Bool
    let webPushOnly: Bool
    let universalLinks: Bool?
    let fullOffline: Bool
    let admin: Bool
    let crypto: Bool
    let localModel: Bool
}

struct NativeEndpointMap: Decodable, Equatable {
    let bootstrapPath: String?
    let preflightPath: String?
    let broadcastWebSocketPath: String
    let syncEventsPath: String
    let syncReplayPath: String?
    let threadFingerprintsPath: String?
    let nativePushTokenPath: String?
    let userStatePath: String
    let readerStandaloneBasePath: String
    let readerWorkspaceBasePathTemplate: String
    let agentWebSocketPathTemplate: String
    let agentStatePathTemplate: String
    let appleAppSiteAssociationPath: String?
}

struct NativeReadiness: Decodable, Equatable {
    let p0: [NativeReadinessItem]
    let p1: [NativeReadinessItem]
    let summary: NativeReadinessSummary?
}

struct NativeReadinessItem: Decodable, Equatable, Identifiable {
    let id: String
    let status: String
    let owner: String
    let selectedTransport: String?
    let detail: String?
}

struct NativeReadinessSummary: Decodable, Equatable {
    let serverP0Ready: Bool
    let serverP1Ready: Bool
    let nativeClientRequired: [String]
    let externalConfigurationRequired: [String]
}

struct NativeAppPreflight: Decodable, Equatable {
    let success: Bool
    let protocolVersion: String
    let generatedAt: String
    let platform: String
    let compatible: Bool
    let blocked: Bool
    let updateRecommended: Bool
    let reasons: [String]
    let warnings: [String]
    let policy: NativePreflightPolicy
    let appVersion: NativePreflightAppVersion
    let osVersion: NativePreflightOSVersion
}

struct NativePreflightPolicy: Decodable, Equatable {
    let minimumOSVersion: String
    let minSupportedAppVersion: String?
    let recommendedAppVersion: String?
}

struct NativePreflightAppVersion: Decodable, Equatable {
    let appVersion: String?
    let minSupportedAppVersion: String?
    let recommendedAppVersion: String?
    let compatible: Bool
    let blocked: Bool
    let updateRecommended: Bool
}

struct NativePreflightOSVersion: Decodable, Equatable {
    let osVersion: String?
    let minimumOSVersion: String
    let compatible: Bool
    let blocked: Bool
}
