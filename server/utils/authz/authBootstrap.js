const { getDeploymentVersion } = require("../deploymentVersion");
const {
  booleanEnv,
  currentAuthEpoch,
  forceReauth,
  minimumAuthEpoch,
  minimumWebProtocolVersion,
  webProtocolVersion,
} = require("./authCompatibility");

const SERVICE_STATUSES = new Set(["ready", "updating", "degraded"]);

function requestOrigin(request) {
  const forwardedProto = String(request?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || request?.protocol || "http";
  const forwardedHost = String(request?.headers?.["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || String(request?.headers?.host || "").trim();
  return host ? `${protocol}://${host}` : null;
}

function validRpConfiguration(request, env = process.env) {
  try {
    const origin =
      env.PASSKEY_ORIGIN || env.PUBLIC_APP_URL || requestOrigin(request);
    if (!origin) return false;
    const parsed = new URL(origin);
    const secure =
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" && parsed.hostname === "localhost");
    if (!secure) return false;

    const rpId = String(env.PASSKEY_RP_ID || parsed.hostname)
      .trim()
      .toLowerCase();
    const host = parsed.hostname.toLowerCase();
    return Boolean(rpId) && (host === rpId || host.endsWith(`.${rpId}`));
  } catch {
    return false;
  }
}

function serviceStatus(env = process.env) {
  const configured = String(env.ATHENA_AUTH_SERVICE_STATUS || "ready")
    .trim()
    .toLowerCase();
  return SERVICE_STATUSES.has(configured) ? configured : "degraded";
}

function safeSsoRedirect(env = process.env) {
  if (!env.SIMPLE_SSO_NO_LOGIN_REDIRECT) return null;
  try {
    const target = new URL(env.SIMPLE_SSO_NO_LOGIN_REDIRECT);
    return ["https:", "http:"].includes(target.protocol)
      ? target.toString()
      : null;
  } catch {
    return null;
  }
}

async function buildAuthBootstrap({ request, settings, env = process.env }) {
  const multiUser = await settings.isMultiUserMode();
  const requiresPassword = Boolean(env.AUTH_TOKEN);
  const status = serviceStatus(env);
  const forceAuthentication = forceReauth(env);
  const serverMinimumWebProtocol = minimumWebProtocolVersion(env);
  const clientWebProtocol = Number.parseInt(
    String(request?.headers?.["x-athena-web-protocol-version"] || "1"),
    10
  );
  const protocolTooOld =
    Number.isInteger(clientWebProtocol) &&
    clientWebProtocol > 0 &&
    clientWebProtocol < serverMinimumWebProtocol;
  const passkeyRpValid = validRpConfiguration(request, env);
  const ssoEnabled = "SIMPLE_SSO_ENABLED" in env;
  const ssoNoLogin = "SIMPLE_SSO_NO_LOGIN" in env;

  let nextAction = "continue";
  let reasonCode = null;
  if (protocolTooOld) {
    nextAction = "hard_reload";
    reasonCode = "web_protocol_incompatible";
  } else if (status === "updating") {
    nextAction = "wait";
    reasonCode = "identity_updating";
  } else if (forceAuthentication) {
    nextAction = "login";
    reasonCode = "force_reauth";
  }

  return {
    schemaVersion: "athena.auth.bootstrap.v1",
    serviceStatus: status,
    authMode: multiUser ? "multi" : requiresPassword ? "single" : "public",
    nextAction,
    methods: {
      password: { enabled: multiUser || requiresPassword },
      passkey: {
        enabled:
          multiUser &&
          passkeyRpValid &&
          !booleanEnv(env.ATHENA_PASSKEY_DISABLED, false),
        crossDeviceAllowed: !booleanEnv(
          env.ATHENA_PASSKEY_CROSS_DEVICE_DISABLED,
          false
        ),
        rpIdValid: passkeyRpValid,
      },
      sso: {
        enabled: ssoEnabled,
        noLogin: ssoNoLogin,
        redirectUrl: ssoNoLogin ? safeSsoRedirect(env) : null,
      },
    },
    deployment: {
      releaseId: getDeploymentVersion(env) || "unknown",
      webProtocolVersion: webProtocolVersion(env),
      minimumWebProtocolVersion: serverMinimumWebProtocol,
      authEpoch: currentAuthEpoch(env),
      minimumAuthEpoch: minimumAuthEpoch(env),
      forceReauth: forceAuthentication,
    },
    retryAfterMs: 3_000,
    reasonCode,
  };
}

module.exports = {
  buildAuthBootstrap,
  requestOrigin,
  safeSsoRedirect,
  validRpConfiguration,
};
