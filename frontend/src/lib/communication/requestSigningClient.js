import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";
import {
  ATHENA_CLIENT_ID_HEADER,
  ATHENA_REQUEST_ID_HEADER,
  createCommunicationRequestId,
  getClientIdentity,
  withClientIdentityHeaders,
} from "./clientIdentity";
import { assertSecureHttpUrl } from "./transportSecurity";
import { AUTH_SESSION_CLEARED_EVENT } from "@/utils/authTokenStorage";

export const SIGNATURE_VERSION = "v1";
export const SIGNATURE_PREFIX = "ATHENA-SIGN-V1";
export const SIGNING_SECRET_SESSION_PREFIX = "athena_signing_secret_v1:";

export const SIGNING_HEADERS = {
  timestamp: "X-Athena-Timestamp",
  nonce: "X-Athena-Nonce",
  bodySha256: "X-Athena-Body-SHA256",
  signature: "X-Athena-Signature",
  signatureVersion: "X-Athena-Signature-Version",
};

const secretCache = new Map();

function isProd() {
  return !!import.meta.env.PROD;
}

function isDev() {
  return !!import.meta.env.DEV;
}

function devLog(phase, metadata = {}) {
  if (!isDev()) return;
  console.debug(`[requestSigning] ${phase}`, metadata);
}

function safeSessionStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function sessionKey(clientId) {
  return `${SIGNING_SECRET_SESSION_PREFIX}${clientId}`;
}

function bytesToBase64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : globalThis.Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value = "") {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto?.subtle?.digest?.("SHA-256", bytes);
  if (!digest) throw new Error("WebCrypto SHA-256 is unavailable.");
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hmacBase64Url(secret, value) {
  const key = await globalThis.crypto?.subtle?.importKey?.(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  if (!key) throw new Error("WebCrypto HMAC is unavailable.");
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(value))
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function absoluteApiUrl(path = "") {
  if (/^https?:\/\//i.test(path)) {
    return assertSecureHttpUrl(path, { kind: "api" });
  }
  return assertSecureHttpUrl(
    `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`,
    { kind: "api" }
  );
}

export function canonicalPathFromUrl(url) {
  const target =
    typeof window === "undefined"
      ? new URL(url, "http://athena.local")
      : new URL(url, window.location.href);
  return `${target.pathname}${target.search}`;
}

function comparablePath(pathOrUrl = "") {
  const path = /^https?:\/\//i.test(String(pathOrUrl))
    ? canonicalPathFromUrl(pathOrUrl)
    : String(pathOrUrl || "/");
  const pathname = path.split("?")[0] || "/";
  return pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
}

export function shouldSignHighRiskRequest({ method = "GET", path = "" } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;
  const normalizedPath = comparablePath(path);

  const highRiskRoutes = [
    {
      methods: ["POST"],
      pattern: /^\/auth\/passkeys\/register\/(?:options|verify)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/auth\/trusted-devices\/enable$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/agent-invocation\/[^/]+\/clarification-response$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/auth\/passkeys\/[^/]+$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/auth\/trusted-devices\/[^/]+$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/auth\/zk-login\/devices\/[^/]+$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/user$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/user\/memory\/[^/]+$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/memory\/[^/]+\/reveal$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/memory\/reauth\/passkey\/(?:options|verify)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/memory\/(?:candidates|rebuild)$/,
    },
    {
      methods: ["PATCH"],
      pattern: /^\/system\/user\/memory\/[^/]+$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/delete\/reauth\/password$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/user\/email-verification\/(?:request|confirm)$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/remove-documents?$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/remove-folder$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/prompt-variables$/,
    },
    {
      methods: ["PUT", "DELETE"],
      pattern: /^\/system\/prompt-variables\/[^/]+$/,
    },
  ];
  if (
    highRiskRoutes.some(
      (route) =>
        route.methods.includes(normalizedMethod) &&
        route.pattern.test(normalizedPath)
    )
  ) {
    return true;
  }

  if (
    normalizedMethod === "POST" &&
    /^\/workspace\/[^/]+\/tool-approval$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+\/remove-and-unembed$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/reader-documents\/[^/]+$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+\/reader-documents\/[^/]+$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/crypto-component-experiment(?:\/[^/]+)?\/config$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod) &&
    normalizedPath.startsWith("/admin/")
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/client-identity\/revoke(?:-all-others)?$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/client-identity\/rotate-(?:signing-secret|all-signing-secrets)$/.test(
      normalizedPath
    )
  ) {
    return true;
  }

  return false;
}

function canonicalSigningString({
  method,
  canonicalPath,
  timestamp,
  nonce,
  requestId,
  clientId,
  bodySha256,
}) {
  return [
    SIGNATURE_PREFIX,
    String(method || "").toUpperCase(),
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId,
    bodySha256,
  ].join("\n");
}

async function fetchSigningSecret({ clientId, signal } = {}) {
  const requestId = createCommunicationRequestId();
  const response = await fetch(
    absoluteApiUrl("/client-identity/signing-secret"),
    {
      method: "POST",
      headers: withClientIdentityHeaders(
        {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        { requestId }
      ),
      body: "{}",
      signal,
    }
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success || !data?.signingSecret) {
    if (data?.error === API_ERROR_CODES.CLIENT_REVOKED) {
      clearSigningSecretCache(clientId);
    }
    throw normalizeApiError(null, response, {
      code:
        data?.error === API_ERROR_CODES.CLIENT_REVOKED
          ? API_ERROR_CODES.CLIENT_REVOKED
          : undefined,
      message: "Unable to obtain Athena signing secret.",
      details: { requestId, clientId },
      raw: data,
    });
  }
  return data.signingSecret;
}

export async function getSigningSecret({ signal } = {}) {
  const { clientId } = getClientIdentity();
  if (!clientId) throw new Error("Athena client identity is unavailable.");

  const cached = secretCache.get(clientId);
  if (cached) return cached;

  const storage = safeSessionStorage();
  const stored = storage?.getItem(sessionKey(clientId));
  if (stored) {
    secretCache.set(clientId, stored);
    return stored;
  }

  const secret = await fetchSigningSecret({ clientId, signal });
  secretCache.set(clientId, secret);
  storage?.setItem(sessionKey(clientId), secret);
  return secret;
}

export function clearSigningSecretCache(clientId = null) {
  const storage = safeSessionStorage();
  if (clientId) {
    secretCache.delete(clientId);
    storage?.removeItem?.(sessionKey(clientId));
    return;
  }

  for (const key of secretCache.keys()) {
    storage?.removeItem?.(sessionKey(key));
  }
  secretCache.clear();
}

export function setSigningSecretCache(clientId, secret) {
  if (!clientId || !secret) return;
  secretCache.set(clientId, secret);
  safeSessionStorage()?.setItem(sessionKey(clientId), secret);
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener(AUTH_SESSION_CLEARED_EVENT, () => {
    secretCache.clear();
  });
}

export function isRecoverableSigningError(errorOrCode) {
  const code =
    typeof errorOrCode === "string"
      ? errorOrCode
      : errorOrCode?.code || errorOrCode?.raw?.error || errorOrCode?.raw?.code;
  return [
    API_ERROR_CODES.INVALID_SIGNATURE,
    API_ERROR_CODES.SIGNING_SECRET_ROTATED,
  ].includes(code);
}

function nonce() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export async function signedRequestHeaders({
  method,
  url,
  requestId,
  bodyString = "",
  signal,
} = {}) {
  const identity = getClientIdentity();
  const clientId = identity.clientId;
  const timestamp = String(Date.now());
  const nextNonce = nonce();
  const bodySha256 = await sha256Base64Url(bodyString);
  const canonicalPath = canonicalPathFromUrl(url);
  const signingString = canonicalSigningString({
    method,
    canonicalPath,
    timestamp,
    nonce: nextNonce,
    requestId,
    clientId,
    bodySha256,
  });
  const secret = await getSigningSecret({ signal });
  const signature = await hmacBase64Url(secret, signingString);

  return {
    [ATHENA_CLIENT_ID_HEADER]: clientId,
    [ATHENA_REQUEST_ID_HEADER]: requestId,
    [SIGNING_HEADERS.timestamp]: timestamp,
    [SIGNING_HEADERS.nonce]: nextNonce,
    [SIGNING_HEADERS.bodySha256]: bodySha256,
    [SIGNING_HEADERS.signature]: signature,
    [SIGNING_HEADERS.signatureVersion]: SIGNATURE_VERSION,
  };
}

export async function maybeSignedRequestHeaders({
  method,
  path,
  url,
  requestId,
  bodyString,
  signal,
  signing = "auto",
} = {}) {
  if (signing === "off") return { headers: {}, signed: false };
  const shouldSign =
    signing === "required" || shouldSignHighRiskRequest({ method, path });
  if (!shouldSign) return { headers: {}, signed: false };

  try {
    const headers = await signedRequestHeaders({
      method,
      url,
      requestId,
      bodyString,
      signal,
    });
    devLog("signed", { requestId, method, path, signed: true });
    return { headers, signed: true };
  } catch (error) {
    if (signing === "auto" && !isProd()) {
      devLog("warn_only_skip", {
        requestId,
        method,
        path,
        message: error?.message,
      });
      return { headers: {}, signed: false, warning: error };
    }
    throw createApiError({
      code: API_ERROR_CODES.API_ERROR,
      status: error?.status || 0,
      message: error?.message || "Athena request signing failed.",
      details: { ...(error?.details || {}), requestId, method, path },
      raw: error,
    });
  }
}

export async function signedWebSocketEnvelope({
  payload,
  url,
  requestId = createCommunicationRequestId(),
  signal,
} = {}) {
  const bodyString = JSON.stringify(payload ?? null);
  const headers = await signedRequestHeaders({
    method: "WS",
    url,
    requestId,
    bodyString,
    signal,
  });
  return {
    type: "athenaSignedMessage",
    signatureVersion: SIGNATURE_VERSION,
    signed: {
      clientId: headers[ATHENA_CLIENT_ID_HEADER],
      requestId,
      timestamp: headers[SIGNING_HEADERS.timestamp],
      nonce: headers[SIGNING_HEADERS.nonce],
      bodySha256: headers[SIGNING_HEADERS.bodySha256],
      signature: headers[SIGNING_HEADERS.signature],
    },
    payload,
  };
}
