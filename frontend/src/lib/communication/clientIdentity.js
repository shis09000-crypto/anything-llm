import { API_BASE } from "@/utils/constants";
import {
  ATHENA_CAPABILITY_PROFILE_HEADER,
  ATHENA_CAPABILITY_PROFILE_QUERY,
  ATHENA_CAPABILITY_SOURCE_HEADER,
  encodeCapabilityProfile,
  getClientCapabilityProfile,
} from "./clientCapabilityProfile";

export const ATHENA_CLIENT_ID_STORAGE_KEY = "athena_client_id_v1";
export const ATHENA_CLIENT_ID_HEADER = "X-Athena-Client-Id";
export const ATHENA_PLATFORM_HEADER = "X-Athena-Platform";
export const ATHENA_APP_VERSION_HEADER = "X-Athena-App-Version";
export const ATHENA_REQUEST_ID_HEADER = "X-Athena-Request-Id";

export const ATHENA_CLIENT_QUERY = {
  clientId: "athenaClientId",
  platform: "athenaPlatform",
  appVersion: "athenaAppVersion",
  requestId: "athenaRequestId",
  capabilityProfile: ATHENA_CAPABILITY_PROFILE_QUERY.profile,
  capabilitySource: ATHENA_CAPABILITY_PROFILE_QUERY.source,
};

export const CLIENT_CAPABILITY_SOURCE = {
  declared: "declared",
  detected: "detected",
  unknown: "unknown",
};

export const CLIENT_PLATFORMS = {
  web: "web",
  desktop: "desktop",
  ios: "ios",
  android: "android",
  api: "api",
};

export function createCommunicationRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function safeLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizePlatform(platform) {
  const normalized = String(platform || "").toLowerCase();
  return Object.values(CLIENT_PLATFORMS).includes(normalized)
    ? normalized
    : CLIENT_PLATFORMS.web;
}

export function getOrCreateClientId() {
  const storage = safeLocalStorage();
  const existing = storage?.getItem(ATHENA_CLIENT_ID_STORAGE_KEY);
  if (existing) return existing;

  const next = `client_${createCommunicationRequestId()}`;
  storage?.setItem(ATHENA_CLIENT_ID_STORAGE_KEY, next);
  return next;
}

export function detectClientPlatform() {
  const envPlatform = import.meta.env.VITE_ATHENA_PLATFORM;
  if (envPlatform) return normalizePlatform(envPlatform);
  if (typeof window === "undefined") return CLIENT_PLATFORMS.web;

  const userAgent = window.navigator?.userAgent || "";
  const platform = window.navigator?.platform || "";
  const isDesktopBridge =
    !!window.__TAURI__ ||
    !!window.__ATHENA_DESKTOP__ ||
    !!window.electron ||
    typeof window.require === "function";
  if (isDesktopBridge) return CLIENT_PLATFORMS.desktop;
  if (/android/i.test(userAgent)) return CLIENT_PLATFORMS.android;
  if (
    /iphone|ipad|ipod/i.test(userAgent) ||
    (platform === "MacIntel" && window.navigator?.maxTouchPoints > 1)
  ) {
    return CLIENT_PLATFORMS.ios;
  }
  return CLIENT_PLATFORMS.web;
}

export function getClientAppVersion() {
  return (
    import.meta.env.VITE_APP_VERSION ||
    import.meta.env.VITE_GIT_SHA ||
    "unknown"
  );
}

export function defaultClientCapabilities(platform = detectClientPlatform()) {
  switch (normalizePlatform(platform)) {
    case CLIENT_PLATFORMS.desktop:
      return {
        fileSystem: true,
        notifications: true,
        localModel: true,
        screenshot: true,
        clipboard: true,
      };
    case CLIENT_PLATFORMS.ios:
    case CLIENT_PLATFORMS.android:
      return {
        fileSystem: false,
        notifications: true,
        localModel: false,
        screenshot: false,
        clipboard: true,
      };
    case CLIENT_PLATFORMS.api:
      return {
        fileSystem: false,
        notifications: false,
        localModel: false,
        screenshot: false,
        clipboard: false,
      };
    case CLIENT_PLATFORMS.web:
    default:
      return {
        fileSystem: false,
        notifications: true,
        localModel: false,
        screenshot: false,
        clipboard: true,
      };
  }
}

export function getClientIdentity() {
  const platform = detectClientPlatform();
  const capabilityProfile = getClientCapabilityProfile();
  return {
    clientId: getOrCreateClientId(),
    platform,
    appVersion: getClientAppVersion(),
    capabilities: {
      ...defaultClientCapabilities(platform),
      ...capabilityProfile.capabilities,
      profile: capabilityProfile,
    },
    capabilityProfile,
    capabilitySource: CLIENT_CAPABILITY_SOURCE.detected,
  };
}

function cleanHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => value !== null && value !== undefined
    )
  );
}

export function clientIdentityHeaders({ requestId } = {}) {
  const identity = getClientIdentity();
  const encodedCapabilityProfile = encodeCapabilityProfile(
    identity.capabilityProfile
  );
  return cleanHeaders({
    [ATHENA_CLIENT_ID_HEADER]: identity.clientId,
    [ATHENA_PLATFORM_HEADER]: identity.platform,
    [ATHENA_APP_VERSION_HEADER]: identity.appVersion,
    [ATHENA_REQUEST_ID_HEADER]: requestId,
    [ATHENA_CAPABILITY_SOURCE_HEADER]: identity.capabilitySource,
    [ATHENA_CAPABILITY_PROFILE_HEADER]: encodedCapabilityProfile,
  });
}

export function withClientIdentityHeaders(headers = {}, { requestId } = {}) {
  return cleanHeaders({
    ...headers,
    ...clientIdentityHeaders({ requestId }),
  });
}

function absoluteUrl(value) {
  try {
    if (typeof window !== "undefined")
      return new URL(value, window.location.href);
    return new URL(value);
  } catch {
    return null;
  }
}

export function shouldAttachClientIdentityToUrl(url) {
  if (!url) return true;
  const value = String(url);
  if (/^(blob:|data:)/i.test(value)) return false;
  if (value.startsWith("/")) return true;

  const target = absoluteUrl(value);
  if (!target) return true;
  if (typeof window !== "undefined" && target.origin === window.location.origin)
    return true;

  const apiBase = absoluteUrl(API_BASE);
  return !!apiBase && target.origin === apiBase.origin;
}

export function appendClientIdentityQueryParams(url, { requestId } = {}) {
  const identity = getClientIdentity();
  const nextRequestId = requestId || createCommunicationRequestId();
  const encodedCapabilityProfile = encodeCapabilityProfile(
    identity.capabilityProfile
  );
  const target =
    typeof window === "undefined"
      ? new URL(url)
      : new URL(url, window.location.href);

  target.searchParams.set(ATHENA_CLIENT_QUERY.clientId, identity.clientId);
  target.searchParams.set(ATHENA_CLIENT_QUERY.platform, identity.platform);
  target.searchParams.set(ATHENA_CLIENT_QUERY.appVersion, identity.appVersion);
  target.searchParams.set(ATHENA_CLIENT_QUERY.requestId, nextRequestId);
  target.searchParams.set(
    ATHENA_CLIENT_QUERY.capabilitySource,
    identity.capabilitySource
  );
  if (encodedCapabilityProfile) {
    target.searchParams.set(
      ATHENA_CLIENT_QUERY.capabilityProfile,
      encodedCapabilityProfile
    );
  }
  return { url: target.toString(), requestId: nextRequestId };
}
