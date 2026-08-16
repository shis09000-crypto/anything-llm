import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

export const AUTH_CAPABILITY_STATUS = Object.freeze({
  CHECKING: "checking",
  LOCAL_READY: "local_ready",
  CROSS_DEVICE_ONLY: "cross_device_only",
  UNAVAILABLE: "unavailable",
});

const DEFAULT_CAPABILITY = Object.freeze({
  status: AUTH_CAPABILITY_STATUS.UNAVAILABLE,
  platform: "unknown",
  browser: "unknown",
  secureContext: false,
  validRpHost: false,
  passkeyHostSupported: false,
  webAuthnApiAvailable: false,
  supportsWebAuthn: false,
  serverPasskeyEnabled: false,
  platformAuthenticatorAvailable: false,
  conditionalMediationAvailable: false,
  crossDeviceAllowed: false,
  embeddedWebView: false,
  reasonCode: "environment_unavailable",
  showPasskey: false,
});
let sessionCapabilityOverride = null;

export function detectAuthCapability(serverPasskey = {}) {
  if (typeof navigator === "undefined") return { ...DEFAULT_CAPABILITY };
  return classifyAuthCapability({
    userAgent: navigator.userAgent || "",
    platform: navigator.platform || "",
    maxTouchPoints: navigator.maxTouchPoints || 0,
    userAgentData: navigator.userAgentData || null,
    secureContext: Boolean(globalThis.isSecureContext),
    validRpHost: webAuthnHostSupported(globalThis.location?.hostname),
    webAuthnApiAvailable: browserSupportsWebAuthn(),
    serverPasskeyEnabled: serverPasskey.enabled !== false,
    crossDeviceAllowed: serverPasskey.crossDeviceAllowed !== false,
    rpIdValid: serverPasskey.rpIdValid !== false,
  });
}

export async function detectAuthCapabilityAsync(serverPasskey = {}) {
  const baseline = detectAuthCapability(serverPasskey);
  if (baseline.status === AUTH_CAPABILITY_STATUS.UNAVAILABLE) return baseline;
  if (sessionCapabilityOverride?.status === AUTH_CAPABILITY_STATUS.UNAVAILABLE)
    return { ...baseline, ...sessionCapabilityOverride, showPasskey: false };

  let platformAuthenticatorAvailable = false;
  let conditionalMediationAvailable = false;
  const credentialApi = globalThis.PublicKeyCredential;
  try {
    if (
      typeof credentialApi?.isUserVerifyingPlatformAuthenticatorAvailable ===
      "function"
    ) {
      platformAuthenticatorAvailable = Boolean(
        await credentialApi.isUserVerifyingPlatformAuthenticatorAvailable()
      );
    }
  } catch {
    platformAuthenticatorAvailable = false;
  }

  if (platformAuthenticatorAvailable) {
    try {
      if (
        typeof credentialApi?.isConditionalMediationAvailable === "function"
      ) {
        conditionalMediationAvailable = Boolean(
          await credentialApi.isConditionalMediationAvailable()
        );
      }
    } catch {
      conditionalMediationAvailable = false;
    }
  }

  const result = classifyAuthCapability({
    ...baseline,
    platformAuthenticatorAvailable,
    conditionalMediationAvailable,
  });
  return sessionCapabilityOverride
    ? { ...result, ...sessionCapabilityOverride }
    : result;
}

export function recordWebAuthnCapabilityFailure(error = {}) {
  const name = String(error?.name || "");
  if (["AbortError", "NotAllowedError", "TimeoutError"].includes(name)) {
    return "cancelled";
  }
  if (name === "SecurityError") {
    sessionCapabilityOverride = {
      status: AUTH_CAPABILITY_STATUS.UNAVAILABLE,
      showPasskey: false,
      reasonCode: "webauthn_security_error",
    };
  } else if (name === "NotSupportedError") {
    sessionCapabilityOverride = {
      status: AUTH_CAPABILITY_STATUS.CROSS_DEVICE_ONLY,
      platformAuthenticatorAvailable: false,
      showPasskey: true,
      reasonCode: "platform_authenticator_unavailable",
    };
  } else {
    return "unchanged";
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("athena-passkey-capability-changed"));
  }
  return sessionCapabilityOverride.status;
}

export function classifyAuthCapability({
  userAgent = "",
  platform = "",
  maxTouchPoints = 0,
  userAgentData = null,
  secureContext = false,
  validRpHost,
  passkeyHostSupported,
  webAuthnApiAvailable,
  supportsWebAuthn,
  serverPasskeyEnabled = true,
  platformAuthenticatorAvailable = false,
  conditionalMediationAvailable = false,
  crossDeviceAllowed = true,
  rpIdValid = true,
  embeddedWebView,
} = {}) {
  const ua = String(userAgent || "");
  const platformText = getPlatformText(userAgentData, platform);
  const browser = detectBrowser({ userAgent: ua, userAgentData });
  const detectedPlatform = detectPlatform({
    userAgent: ua,
    platform: platformText,
    maxTouchPoints,
  });
  const hostValid = Boolean(validRpHost ?? passkeyHostSupported ?? true);
  const apiAvailable = Boolean(
    webAuthnApiAvailable ?? supportsWebAuthn ?? false
  );
  const isEmbedded = Boolean(embeddedWebView ?? isEmbeddedWebView(ua));

  let status = AUTH_CAPABILITY_STATUS.UNAVAILABLE;
  let reasonCode = null;
  if (!secureContext) reasonCode = "insecure_context";
  else if (!hostValid || !rpIdValid) reasonCode = "rp_id_invalid";
  else if (!serverPasskeyEnabled) reasonCode = "server_passkey_disabled";
  else if (!apiAvailable) reasonCode = "webauthn_unavailable";
  else if (isEmbedded) reasonCode = "embedded_webview_unsupported";
  else if (platformAuthenticatorAvailable) {
    status = AUTH_CAPABILITY_STATUS.LOCAL_READY;
  } else if (crossDeviceAllowed) {
    status = AUTH_CAPABILITY_STATUS.CROSS_DEVICE_ONLY;
    reasonCode = "platform_authenticator_unavailable";
  } else {
    reasonCode = "no_available_authenticator";
  }

  return {
    status,
    platform: detectedPlatform,
    browser,
    secureContext: Boolean(secureContext),
    validRpHost: hostValid,
    passkeyHostSupported: hostValid,
    webAuthnApiAvailable: apiAvailable,
    supportsWebAuthn: apiAvailable,
    serverPasskeyEnabled: Boolean(serverPasskeyEnabled),
    platformAuthenticatorAvailable: Boolean(platformAuthenticatorAvailable),
    conditionalMediationAvailable: Boolean(conditionalMediationAvailable),
    crossDeviceAllowed: Boolean(crossDeviceAllowed),
    embeddedWebView: isEmbedded,
    reasonCode,
    showPasskey: status !== AUTH_CAPABILITY_STATUS.UNAVAILABLE,
  };
}

export function passkeyCapabilityDescription(capability) {
  if (!capability?.secureContext) {
    return "通行密钥需要 HTTPS 或 localhost。手机局域网 HTTP 地址无法使用通行密钥。";
  }
  if (capability?.validRpHost === false) {
    return "当前域名与通行密钥 RP 配置不匹配。";
  }
  if (capability?.status === AUTH_CAPABILITY_STATUS.CROSS_DEVICE_ONLY) {
    return "可使用手机扫码、USB 或 NFC 安全密钥完成验证。";
  }
  if (capability?.status !== AUTH_CAPABILITY_STATUS.LOCAL_READY) {
    return "当前环境无法使用通行密钥。";
  }
  if (capability.platform === "apple") {
    return "可使用 Face ID、Touch ID 或设备密码安全登录。";
  }
  if (capability.platform === "windows") {
    return "可使用 Windows Hello 安全登录。";
  }
  return "可使用当前设备的本机认证器安全登录。";
}

function getPlatformText(userAgentData, platform) {
  return (
    userAgentData?.platform || userAgentData?.mobilePlatform || platform || ""
  );
}

function detectPlatform({ userAgent, platform, maxTouchPoints }) {
  const ua = userAgent.toLowerCase();
  const platformText = String(platform || "").toLowerCase();
  const isIPadDesktopMode =
    platformText === "macintel" && Number(maxTouchPoints || 0) > 1;
  if (
    /mac|iphone|ipad|ipod/.test(platformText) ||
    /iphone|ipad|ipod|mac os x|macintosh/.test(ua) ||
    isIPadDesktopMode
  )
    return "apple";
  if (/android/.test(platformText) || /android/.test(ua)) return "android";
  if (/win/.test(platformText) || /windows/.test(ua)) return "windows";
  return "unknown";
}

function detectBrowser({ userAgent, userAgentData }) {
  const ua = String(userAgent || "");
  const brands = [
    ...(Array.isArray(userAgentData?.brands) ? userAgentData.brands : []),
    ...(Array.isArray(userAgentData?.fullVersionList)
      ? userAgentData.fullVersionList
      : []),
  ];
  const source = `${brands.map((item) => item?.brand || "").join(" ")} ${ua}`;
  if (/\b(edg|edge|edga|edgios)\//i.test(ua) || /microsoft edge/i.test(source))
    return "edge";
  if (/firefox|fxios/i.test(source)) return "firefox";
  if (/chrome|crios|chromium/i.test(source)) return "chrome";
  if (
    /safari/i.test(source) &&
    !/chrome|crios|chromium|android|edg/i.test(source)
  )
    return "safari";
  return "unknown";
}

function isEmbeddedWebView(userAgent = "") {
  const ua = String(userAgent || "");
  return /;\s*wv\)|\bwv\b|WebView|FBAN|FBAV|Instagram|Line\//i.test(ua);
}

function webAuthnHostSupported(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
  return host.includes(".");
}
