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
import { signWithDeviceIdentityKey } from "./deviceIdentityKey";
import { signWithPostQuantumDeviceKey } from "@/utils/security/browserHybridKeys";
import { assertSecureHttpUrl } from "./transportSecurity";
import { AUTH_SESSION_CLEARED_EVENT } from "@/utils/authTokenStorage";
import { runScheduledTaskRequest } from "@/utils/tasks/taskRequestMetadata";
import {
  CRYPTO_SUITE_IDS,
  CRYPTO_SUITE_PURPOSES,
  cryptoSuite,
  preferredCryptoSuite,
} from "./cryptoSuiteRegistry";

const hmacSignatureSuite = cryptoSuite(
  CRYPTO_SUITE_IDS.requestHmacV1,
  CRYPTO_SUITE_PURPOSES.requestSignature
);
const deviceSignatureSuite = preferredCryptoSuite(
  CRYPTO_SUITE_PURPOSES.requestSignature
);
if (!hmacSignatureSuite || !deviceSignatureSuite) {
  throw new Error("request_signature_crypto_suite_unavailable");
}
export const SIGNATURE_VERSION = hmacSignatureSuite.suiteId;
export const SIGNATURE_PREFIX = hmacSignatureSuite.protocolPrefix;
export const DEVICE_SIGNATURE_VERSION = deviceSignatureSuite.suiteId;
export const DEVICE_SIGNATURE_PREFIX = deviceSignatureSuite.protocolPrefix;
export const SIGNING_SECRET_SESSION_PREFIX = "athena_signing_secret_v1:";

export const SIGNING_HEADERS = {
  timestamp: "X-Athena-Timestamp",
  nonce: "X-Athena-Nonce",
  bodySha256: "X-Athena-Body-SHA256",
  signature: "X-Athena-Signature",
  signatureVersion: "X-Athena-Signature-Version",
  devicePublicKey: "X-Athena-Device-Public-Key",
  deviceKeyAlgorithm: "X-Athena-Device-Key-Algorithm",
  hybridSignatureVersion: "X-Athena-Hybrid-Signature-Version",
  pqSignature: "X-Athena-PQ-Signature",
  pqPublicKey: "X-Athena-PQ-Public-Key",
  pqKeyAlgorithm: "X-Athena-PQ-Key-Algorithm",
  pqKeyOrigin: "X-Athena-PQ-Key-Origin",
  pqHardwareProtection: "X-Athena-PQ-Hardware-Protection",
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

export function canonicalWebSocketPathFromUrl(url) {
  const canonicalPath = canonicalPathFromUrl(url);
  return canonicalPath.split("?")[0] || "/";
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
  const normalizedPath = comparablePath(path);
  if (
    normalizedMethod === "GET" &&
    (/^\/vault\/items\/[^/]+$/.test(normalizedPath) ||
      normalizedPath === "/vault/key-epochs" ||
      normalizedPath === "/vault/device-key-envelopes" ||
      normalizedPath === "/vault/user-root-key" ||
      normalizedPath === "/vault/user-root-key/authorization-targets" ||
      normalizedPath === "/vault/user-root-key/envelopes" ||
      /^\/vault\/recovery-packages\/[^/]+$/.test(normalizedPath) ||
      /^\/vault\/user-domain-wraps(?:\/coverage)?$/.test(normalizedPath) ||
      normalizedPath === "/sync/events/replay")
  ) {
    return true;
  }
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;

  const highRiskRoutes = [
    {
      methods: ["POST"],
      pattern: /^\/auth\/passkeys\/register\/(?:options|verify)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/auth\/passkeys\/native-register\/(?:start|exchange)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/auth\/trusted-devices\/enable$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/client-identity\/device-key-rotation\/(?:prepare|commit)$/,
    },
    {
      methods: ["POST"],
      pattern:
        /^\/client-identity\/(?:vault-kem-key(?:\/rotate)?|crypto-observations|attestation\/(?:challenge|verify))$/,
    },
    {
      methods: ["POST"],
      pattern:
        /^\/admin\/security\/keys\/(?:session|preflight|rotations|rotations\/[^/]+\/(?:approve|execute)|recovery\/verify)$/,
    },
    {
      methods: ["POST", "GET"],
      pattern: /^\/vault\/device-key-envelopes(?:\/[^/]+\/consume)?$/,
    },
    {
      methods: ["POST"],
      pattern:
        /^\/vault\/user-root-key(?:\/initialize|\/challenge|\/envelopes(?:\/[^/]+\/consume)?)?$/,
    },
    {
      methods: ["POST", "PUT"],
      pattern: /^\/vault\/user-domain-wraps\/[^/]+(?:\/prepare)?$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/vault\/key-epochs\/(?:rotate|[^/]+\/(?:ack|retire|cancel))$/,
    },
    {
      methods: ["POST", "DELETE"],
      pattern: /^\/vault\/recovery-packages(?:\/[^/]+)?$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/agent-invocation\/[^/]+\/clarification-response$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/agent-invocation\/[^/]+\/tool-approval-response$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/agent-invocation\/[^/]+\/stop$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/workspace\/[^/]+\/(?:thread\/[^/]+\/)?update-chat$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/workspace\/[^/]+\/(?:thread\/[^/]+\/)?delete-edited-chats$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/workspace\/[^/]+\/(?:thread\/[^/]+\/)?chat\/[^/]+$/,
    },
    {
      methods: ["PUT"],
      pattern: /^\/workspace\/workspace-chats\/[^/]+$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/workspace\/[^/]+\/thread\/fork$/,
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
      methods: ["POST"],
      pattern: /^\/system\/sessions\/(?:revoke|revoke-others|revoke-all)$/,
    },
    {
      methods: ["PATCH", "DELETE"],
      pattern: /^\/system\/user\/state$/,
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
      methods: ["POST"],
      pattern: /^\/system\/(?:provider-settings\/[^/]+|custom-models)$/,
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
    {
      methods: ["POST"],
      pattern: /^\/system\/patrol\/repairs\/[^/]+\/confirm$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/generate-api-key$/,
    },
    {
      methods: ["DELETE"],
      pattern: /^\/system\/api-key\/[^/]+$/,
    },
    {
      methods: ["POST", "DELETE"],
      pattern: /^\/browser-extension\/api-keys(?:\/new|\/[^/]+)?$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/sensitive-sessions\/(?:heartbeat|revoke|revoke-scope)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/workspace\/new$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/workspace\/[^/]+\/thread\/new$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/workspace\/[^/]+\/thread\/[^/]+\/update$/,
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
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/vault\/items(?:\/[^/]+)?$/.test(normalizedPath)
  ) {
    return true;
  }
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/vault\/(?:reauth\/password|access-grants(?:\/current)?|lock)$/.test(
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
  prefix = SIGNATURE_PREFIX,
}) {
  return [
    prefix,
    String(method || "").toUpperCase(),
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId,
    bodySha256,
  ].join("\n");
}

async function signedDeviceRequestHeaders({
  method,
  canonicalPath,
  timestamp,
  nonce: nextNonce,
  requestId,
  clientId,
  bodySha256,
} = {}) {
  const signingString = canonicalSigningString({
    method,
    canonicalPath,
    timestamp,
    nonce: nextNonce,
    requestId,
    clientId,
    bodySha256,
    prefix: DEVICE_SIGNATURE_PREFIX,
  });
  const deviceSignature = await signWithDeviceIdentityKey(signingString);
  if (
    !deviceSignature?.signature ||
    !deviceSignature?.publicKey ||
    !deviceSignature?.algorithm
  ) {
    return null;
  }

  const headers = {
    [ATHENA_CLIENT_ID_HEADER]: clientId,
    [ATHENA_REQUEST_ID_HEADER]: requestId,
    [SIGNING_HEADERS.timestamp]: timestamp,
    [SIGNING_HEADERS.nonce]: nextNonce,
    [SIGNING_HEADERS.bodySha256]: bodySha256,
    [SIGNING_HEADERS.signature]: deviceSignature.signature,
    [SIGNING_HEADERS.signatureVersion]: DEVICE_SIGNATURE_VERSION,
    [SIGNING_HEADERS.devicePublicKey]: deviceSignature.publicKey,
    [SIGNING_HEADERS.deviceKeyAlgorithm]: deviceSignature.algorithm,
  };
  const postQuantum = await signWithPostQuantumDeviceKey(signingString);
  if (!postQuantum) return headers;
  return {
    ...headers,
    [SIGNING_HEADERS.hybridSignatureVersion]:
      postQuantum.hybridSignatureVersion,
    [SIGNING_HEADERS.pqSignature]: postQuantum.signature,
    [SIGNING_HEADERS.pqPublicKey]: postQuantum.publicKey,
    [SIGNING_HEADERS.pqKeyAlgorithm]: postQuantum.keyAlgorithm,
    [SIGNING_HEADERS.pqKeyOrigin]: postQuantum.keyOrigin,
    [SIGNING_HEADERS.pqHardwareProtection]: postQuantum.hardwareProtection,
  };
}

async function signedHmacRequestHeaders({
  method,
  canonicalPath,
  timestamp,
  nonce: nextNonce,
  requestId,
  clientId,
  bodySha256,
  signal,
} = {}) {
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

async function fetchSigningSecretCore({ clientId, signal } = {}) {
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

async function fetchSigningSecret({ clientId, signal } = {}) {
  return runScheduledTaskRequest(
    ({ signal: scheduledSignal }) =>
      fetchSigningSecretCore({ clientId, signal: scheduledSignal }),
    {
      method: "POST",
      path: "/client-identity/signing-secret",
      signal,
      transport: "json",
      communicationScene: "security-signing",
      task: {
        kind: "security-signing-secret",
        priority: "P0",
        protected: true,
        abortable: false,
        scope: { route: "auth", surface: "security" },
      },
    }
  );
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
  canonicalPath: canonicalPathOverride,
  requestId,
  bodyString = "",
  signal,
} = {}) {
  const identity = getClientIdentity();
  const clientId = identity.clientId;
  const timestamp = String(Date.now());
  const nextNonce = nonce();
  const bodySha256 = await sha256Base64Url(bodyString);
  const canonicalPath = canonicalPathOverride || canonicalPathFromUrl(url);

  const deviceHeaders = await signedDeviceRequestHeaders({
    method,
    canonicalPath,
    timestamp,
    nonce: nextNonce,
    requestId,
    clientId,
    bodySha256,
  });
  if (deviceHeaders) return deviceHeaders;

  return signedHmacRequestHeaders({
    method,
    canonicalPath,
    timestamp,
    nonce: nextNonce,
    requestId,
    clientId,
    bodySha256,
    signal,
  });
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
    canonicalPath: canonicalWebSocketPathFromUrl(url),
    requestId,
    bodyString,
    signal,
  });
  return {
    type: "athenaSignedMessage",
    signatureVersion: headers[SIGNING_HEADERS.signatureVersion],
    signed: {
      clientId: headers[ATHENA_CLIENT_ID_HEADER],
      requestId,
      timestamp: headers[SIGNING_HEADERS.timestamp],
      nonce: headers[SIGNING_HEADERS.nonce],
      bodySha256: headers[SIGNING_HEADERS.bodySha256],
      signature: headers[SIGNING_HEADERS.signature],
      devicePublicKey: headers[SIGNING_HEADERS.devicePublicKey],
      deviceKeyAlgorithm: headers[SIGNING_HEADERS.deviceKeyAlgorithm],
      hybridSignatureVersion: headers[SIGNING_HEADERS.hybridSignatureVersion],
      pqSignature: headers[SIGNING_HEADERS.pqSignature],
      pqPublicKey: headers[SIGNING_HEADERS.pqPublicKey],
      pqKeyAlgorithm: headers[SIGNING_HEADERS.pqKeyAlgorithm],
      pqKeyOrigin: headers[SIGNING_HEADERS.pqKeyOrigin],
      pqHardwareProtection: headers[SIGNING_HEADERS.pqHardwareProtection],
    },
    payload,
  };
}
