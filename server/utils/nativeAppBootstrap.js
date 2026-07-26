const { CLIENT_HEADERS, CLIENT_QUERY } = require("./clientIdentity");
const {
  DEVICE_SIGNATURE_VERSION,
  SIGNING_HEADERS,
} = require("./requestSigning");
const { getDeploymentVersion } = require("./deploymentVersion");
const { SENSITIVE_SESSION_HEADER } = require("./authz/sensitiveSessions");
const { transportSecurityStatus } = require("./security/transportSecurity");
const { broadcastTransportSummary } = require("./broadcast/transportRegistry");
const { syncV2Enabled } = require("./syncV2/config");
const {
  PURPOSES: CRYPTO_PURPOSES,
  REGISTRY_VERSION: CRYPTO_SUITE_REGISTRY_VERSION,
  SUITE_IDS: CRYPTO_SUITE_IDS,
  publicCryptoSuites,
} = require("./security/cryptoSuiteRegistry");

const NATIVE_APP_PROTOCOL_VERSION = "ios-native-v1";
const IOS_MINIMUM_OS_VERSION = "26.0";
const READER_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const NATIVE_OS_VERSION_HEADER = "X-Athena-OS-Version";
const DEFAULT_UNIVERSAL_LINK_PATHS = [
  "/",
  "/workspace/*",
  "/reader/*",
  "/agent/*",
];

function compactEnvValue(value = null) {
  const next = String(value || "").trim();
  return next ? next : null;
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}

function compactList(value = null, fallback = []) {
  const raw = compactEnvValue(value);
  if (!raw) return [...fallback];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizedPublicAppUrl(env = process.env) {
  return compactEnvValue(env.PUBLIC_APP_URL)?.replace(/\/+$/, "") || null;
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf())
    ? new Date().toISOString()
    : date.toISOString();
}

function compareVersions(left = null, right = null) {
  const leftValue = compactEnvValue(left);
  const rightValue = compactEnvValue(right);
  if (!leftValue || !rightValue) return null;
  const leftParts = leftValue.split(/[.-]/).map((part) => Number(part));
  const rightParts = rightValue.split(/[.-]/).map((part) => Number(part));
  if (
    leftParts.some((part) => !Number.isFinite(part)) ||
    rightParts.some((part) => !Number.isFinite(part))
  ) {
    return null;
  }

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function appVersionPolicy(env = process.env) {
  return {
    minSupportedAppVersion: compactEnvValue(
      env.ATHENA_IOS_MIN_SUPPORTED_APP_VERSION
    ),
    recommendedAppVersion: compactEnvValue(
      env.ATHENA_IOS_RECOMMENDED_APP_VERSION
    ),
  };
}

function appVersionCompatibility(
  appVersion = null,
  policy = appVersionPolicy()
) {
  const minComparison = compareVersions(
    appVersion,
    policy.minSupportedAppVersion
  );
  const recommendedComparison = compareVersions(
    appVersion,
    policy.recommendedAppVersion
  );
  const blocked =
    !!policy.minSupportedAppVersion &&
    (!appVersion || minComparison === null || minComparison < 0);
  const updateRecommended =
    !blocked &&
    !!policy.recommendedAppVersion &&
    (!appVersion ||
      recommendedComparison === null ||
      recommendedComparison < 0);

  return {
    appVersion: compactEnvValue(appVersion),
    minSupportedAppVersion: policy.minSupportedAppVersion,
    recommendedAppVersion: policy.recommendedAppVersion,
    compatible: !blocked,
    blocked,
    updateRecommended,
  };
}

function osCompatibility(osVersion = null) {
  const comparison = compareVersions(osVersion, IOS_MINIMUM_OS_VERSION);
  const blocked = !osVersion || comparison === null || comparison < 0;
  return {
    osVersion: compactEnvValue(osVersion),
    minimumOSVersion: IOS_MINIMUM_OS_VERSION,
    compatible: !blocked,
    blocked,
  };
}

function publicHost(env = process.env) {
  const publicUrl = normalizedPublicAppUrl(env);
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).hostname;
  } catch {
    return null;
  }
}

function associatedAppId(env = process.env) {
  const bundleId = compactEnvValue(env.ATHENA_IOS_BUNDLE_ID);
  const appIdPrefix =
    compactEnvValue(env.ATHENA_IOS_APP_ID_PREFIX) ||
    compactEnvValue(env.ATHENA_IOS_TEAM_ID);
  if (!bundleId || !appIdPrefix) return null;
  return `${appIdPrefix}.${bundleId}`;
}

function universalLinksConfig(env = process.env) {
  const appId = associatedAppId(env);
  const paths = compactList(
    env.ATHENA_IOS_UNIVERSAL_LINK_PATHS,
    DEFAULT_UNIVERSAL_LINK_PATHS
  );
  return {
    configured: !!appId,
    associationFilePath: "/.well-known/apple-app-site-association",
    alternateAssociationFilePath: "/apple-app-site-association",
    appId,
    paths,
    domain: publicHost(env),
  };
}

function appleAppSiteAssociation(env = process.env) {
  const links = universalLinksConfig(env);
  if (!links.configured) {
    return { configured: false, payload: null, links };
  }

  const details = [
    {
      appID: links.appId,
      paths: links.paths,
    },
  ];
  return {
    configured: true,
    links,
    payload: {
      applinks: {
        apps: [],
        details,
      },
      webcredentials: {
        apps: [links.appId],
      },
    },
  };
}

function apnsConfig(env = process.env) {
  const enabled = envFlag(env.ATHENA_IOS_APNS_ENABLED);
  const environment =
    compactEnvValue(env.ATHENA_IOS_APNS_ENVIRONMENT) || "development";
  const bundleId = compactEnvValue(env.ATHENA_IOS_BUNDLE_ID);
  const teamId = compactEnvValue(env.ATHENA_IOS_TEAM_ID);
  const keyId = compactEnvValue(env.ATHENA_IOS_APNS_KEY_ID);
  const keyPathConfigured = !!compactEnvValue(env.ATHENA_IOS_APNS_KEY_PATH);
  const configured =
    enabled && !!bundleId && !!teamId && !!keyId && keyPathConfigured;

  return {
    available: configured,
    enabled,
    configured,
    environment,
    bundleId,
    teamIdConfigured: !!teamId,
    keyIdConfigured: !!keyId,
    keyPathConfigured,
    tokenRegistrationPath: "/api/native-app/push-token",
    status: configured
      ? "ready"
      : enabled
        ? "requires_apns_configuration"
        : "disabled",
  };
}

function nativePasskeyConfig(env = process.env) {
  const publicUrl = normalizedPublicAppUrl(env);
  const rpID = compactEnvValue(env.PASSKEY_RP_ID) || publicHost(env);
  const origin = compactEnvValue(env.PASSKEY_ORIGIN) || publicUrl;
  return {
    serverAvailable: true,
    nativeAdapterRequired: true,
    associatedDomainsRequired: true,
    rpID,
    origin,
  };
}

function appleSignInConfig() {
  return {
    available: false,
    configured: false,
    status: "not_implemented",
  };
}

function cloudTransportReady(transportStatus) {
  if (!transportStatus.production) return true;
  return (
    transportStatus.mode !== "invalid" &&
    transportStatus.httpsRequired &&
    transportStatus.webSocketSecureRequired &&
    transportStatus.publicAppUrlHttps
  );
}

function buildReadiness({ env, transportStatus, broadcastTransport } = {}) {
  const universalLinks = universalLinksConfig(env);
  const apns = apnsConfig(env);
  const transportReady = cloudTransportReady(transportStatus);
  const durableBroadcastReady = true;

  const p0 = [
    {
      id: "cloud_https_wss_api_base",
      status: transportReady ? "ready" : "requires_production_transport_config",
      owner: "server",
    },
    {
      id: "native_auth_keychain",
      status: "requires_native_client",
      owner: "ios",
    },
    {
      id: "client_identity_request_signing",
      status: "ready",
      owner: "server",
    },
    {
      id: "chat_sse_agent_ws_broadcast_ws_adapter",
      status: "requires_native_client",
      owner: "ios",
    },
    {
      id: "sensitive_session_native_lifecycle",
      status: "requires_native_client",
      owner: "ios",
    },
    {
      id: "reader_upload_download_minimum_loop",
      status: "requires_native_client",
      owner: "ios",
    },
  ];

  const p1 = [
    {
      id: "broadcast_durable_transport",
      status: durableBroadcastReady ? "ready" : "requires_durable_transport",
      owner: "server",
      selectedTransport: broadcastTransport?.selected || "memory",
    },
    {
      id: "apns_push",
      status: apns.available ? "ready" : apns.status,
      owner: "server",
    },
    {
      id: "apple_sign_in_native_passkey",
      status: "partially_ready",
      owner: "server_ios",
      detail:
        "Passkey server endpoints exist; Apple Sign in is not implemented.",
    },
    {
      id: "universal_links_deep_links",
      status: universalLinks.configured
        ? "ready"
        : "requires_associated_domain_config",
      owner: "server_ios",
    },
    {
      id: "background_upload_download",
      status: "requires_native_client",
      owner: "ios",
    },
    {
      id: "app_version_compatibility_endpoint",
      status: "ready",
      owner: "server",
    },
  ];

  return {
    p0,
    p1,
    summary: {
      serverP0Ready: p0
        .filter((item) => item.owner === "server")
        .every((item) => item.status === "ready"),
      serverP1Ready: p1
        .filter((item) => item.owner === "server")
        .every((item) => item.status === "ready"),
      nativeClientRequired: [...p0, ...p1]
        .filter((item) => item.status === "requires_native_client")
        .map((item) => item.id),
      externalConfigurationRequired: [...p0, ...p1]
        .filter((item) => /requires_/.test(item.status))
        .map((item) => item.id),
    },
  };
}

function buildNativeAppBootstrap({
  env = process.env,
  generatedAt = new Date(),
  deploymentVersion = getDeploymentVersion(env),
} = {}) {
  const transportStatus = transportSecurityStatus(env);
  const broadcastTransport = broadcastTransportSummary(env);
  const universalLinks = universalLinksConfig(env);
  const apns = apnsConfig(env);

  return {
    success: true,
    protocolVersion: NATIVE_APP_PROTOCOL_VERSION,
    generatedAt: isoTimestamp(generatedAt),
    app: {
      name: "Athena",
      platform: "ios",
      platforms: ["ios", "ipad"],
      minimumOSVersion: IOS_MINIMUM_OS_VERSION,
      deploymentVersion: deploymentVersion || null,
      versionPolicy: appVersionPolicy(env),
      liquidGlass: {
        nativeRequired: true,
        swiftUIAvailability: "iOS 26+",
        fallbackPromised: false,
      },
    },
    transport: {
      apiBasePath: "/api",
      httpsRequired: true,
      webSocketSecureRequired: true,
      publicAppUrl: normalizedPublicAppUrl(env),
      sseSupported: true,
      webSocketSupported: true,
      runtime: {
        mode: transportStatus.mode,
        production: transportStatus.production,
        httpsRequired: transportStatus.httpsRequired,
        trustProxyEnabled: transportStatus.trustProxyEnabled,
        forceHttps: transportStatus.forceHttps,
        publicAppUrlHttps: transportStatus.publicAppUrlHttps,
        hstsConfigured: transportStatus.hstsConfigured,
        tlsMinVersion: transportStatus.tlsMinVersion,
        tls13Recommended: transportStatus.tls13Recommended,
        webSocketSecureRequired: transportStatus.webSocketSecureRequired,
      },
    },
    auth: {
      passwordLoginPath: "/api/request-token",
      checkTokenPath: "/api/system/check-token",
      userActionPath: "/api/system/user-action",
      passkeyAvailable: true,
      nativePasskey: nativePasskeyConfig(env),
      appleSignIn: appleSignInConfig(),
      appleSignInAvailable: false,
    },
    security: {
      clientIdentityRequired: true,
      clientIdentityHeaders: { ...CLIENT_HEADERS },
      clientIdentityQuery: { ...CLIENT_QUERY },
      nativeAppHeaders: {
        osVersion: NATIVE_OS_VERSION_HEADER,
      },
      preferredSignatureVersion: DEVICE_SIGNATURE_VERSION,
      cryptoSuiteRegistryVersion: CRYPTO_SUITE_REGISTRY_VERSION,
      cryptoSuites: publicCryptoSuites({
        purposes: [
          CRYPTO_PURPOSES.REQUEST_SIGNATURE,
          CRYPTO_PURPOSES.DEVICE_KEY,
        ],
      }),
      highRiskRequestSigning: {
        enforcementMode:
          env.ATHENA_IOS_HIGH_RISK_PQ_REQUIRED === "true"
            ? "required"
            : "disabled",
        minimumOSVersion: "26.0",
        minimumAppVersion: "2.4.0",
        classicalSuiteId: CRYPTO_SUITE_IDS.REQUEST_DEVICE_P256_V2,
        postQuantumSuiteId: CRYPTO_SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1,
        hybridSuiteId: CRYPTO_SUITE_IDS.DEVICE_HYBRID_P256_MLDSA65_V1,
        hardwareBackedPostQuantumKeyRequired: true,
      },
      postQuantumExperiments: {
        enabled: envFlag(env.ATHENA_IOS_PQ_EXPERIMENTS),
        productionEffect: false,
        minimumOSVersion: "26.0",
        suiteIds: publicCryptoSuites({
          purposes: [
            CRYPTO_PURPOSES.DEVICE_KEY,
            CRYPTO_PURPOSES.DEVICE_KEY_ESTABLISHMENT,
            CRYPTO_PURPOSES.VAULT_DEVICE_AUTHORIZATION,
          ],
        })
          .filter((suite) => suite.pqAlgorithm)
          .map((suite) => suite.suiteId),
      },
      requestSigningHeaders: { ...SIGNING_HEADERS },
      signingSecretPath: "/api/client-identity/signing-secret",
      sensitiveSessionHeader: SENSITIVE_SESSION_HEADER,
    },
    features: {
      workspaceThreads: true,
      chatSSE: true,
      reader: true,
      readerMaxUploadBytes: READER_MAX_UPLOAD_BYTES,
      agentWebSocket: true,
      broadcastWebSocket: true,
      broadcastDurableTransport: true,
      userStateSync: true,
      syncV2: syncV2Enabled(env),
      nativePush: apns.available,
      webPushOnly: !apns.available,
      universalLinks: universalLinks.configured,
      fullOffline: false,
      admin: false,
      crypto: false,
      localModel: false,
    },
    integrations: {
      apns,
      universalLinks,
      appleSignIn: appleSignInConfig(),
      nativePasskey: nativePasskeyConfig(env),
    },
    realtime: {
      broadcastTransport,
    },
    endpoints: {
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
      appleAppSiteAssociationPath: universalLinks.associationFilePath,
    },
    readiness: buildReadiness({
      env,
      transportStatus,
      broadcastTransport,
    }),
  };
}

function headerValue(headers = {}, name) {
  const lower = String(name || "").toLowerCase();
  return headers[name] || headers[lower] || null;
}

function buildNativeAppPreflight({
  env = process.env,
  query = {},
  headers = {},
  generatedAt = new Date(),
} = {}) {
  const appVersion =
    compactEnvValue(query.appVersion) ||
    compactEnvValue(headerValue(headers, CLIENT_HEADERS.appVersion));
  const osVersion =
    compactEnvValue(query.osVersion) ||
    compactEnvValue(headerValue(headers, NATIVE_OS_VERSION_HEADER));
  const platform = (
    compactEnvValue(query.platform) ||
    compactEnvValue(headerValue(headers, CLIENT_HEADERS.platform)) ||
    "ios"
  ).toLowerCase();
  const version = appVersionCompatibility(appVersion, appVersionPolicy(env));
  const os = osCompatibility(osVersion);
  const supportedPlatform = ["ios", "ipad"].includes(platform);
  const reasons = [];
  const warnings = [];

  if (!supportedPlatform) reasons.push("unsupported_platform");
  if (os.blocked) reasons.push("minimum_ios_26_required");
  if (version.blocked) reasons.push("app_version_blocked");
  if (version.updateRecommended) warnings.push("app_update_recommended");

  return {
    success: true,
    protocolVersion: NATIVE_APP_PROTOCOL_VERSION,
    generatedAt: isoTimestamp(generatedAt),
    platform,
    compatible: supportedPlatform && !os.blocked && !version.blocked,
    blocked: !supportedPlatform || os.blocked || version.blocked,
    updateRecommended: version.updateRecommended,
    reasons,
    warnings,
    policy: {
      minimumOSVersion: IOS_MINIMUM_OS_VERSION,
      ...appVersionPolicy(env),
    },
    appVersion: version,
    osVersion: os,
  };
}

module.exports = {
  IOS_MINIMUM_OS_VERSION,
  NATIVE_OS_VERSION_HEADER,
  NATIVE_APP_PROTOCOL_VERSION,
  READER_MAX_UPLOAD_BYTES,
  appleAppSiteAssociation,
  appVersionCompatibility,
  buildNativeAppBootstrap,
  buildNativeAppPreflight,
  compareVersions,
  osCompatibility,
  universalLinksConfig,
};
