const crypto = require("crypto");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const RequestSigningData = lazyDataAccessFacade("requestSigning");
const requestSigningDb = RequestSigningData.db;
const { EncryptionManager } = require("../EncryptionManager");
const { isSecretEncrypted, readSecret, saveSecret } = require("../security");
const {
  CLIENT_HEADERS,
  clientAuditMetadata,
  getClientRecord,
  getClientContext,
  recordClientTrustCheckpoint,
  registerClient,
} = require("../clientIdentity");
const { safeJsonParse } = require("../http");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
  preferredCryptoSuite,
  keyMetadataForSuite,
  supportsNodeSignatureSuite,
  suiteSupportsClient,
  verifyWithCryptoSuite,
} = require("../security/cryptoSuiteRegistry");
const {
  mlDSA65PublicKey: importMLDSA65PublicKey,
} = require("../security/postQuantumKeyEncoding");
const {
  deviceAttestationMode,
  validDeviceAttestation,
} = require("../security/deviceAttestation");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { metrics } = require("../observability/metrics");

const HMAC_SIGNATURE_SUITE = cryptoSuite(SUITE_IDS.REQUEST_HMAC_V1, {
  purpose: PURPOSES.REQUEST_SIGNATURE,
});
const DEVICE_SIGNATURE_SUITE = preferredCryptoSuite(PURPOSES.REQUEST_SIGNATURE);
if (!HMAC_SIGNATURE_SUITE || !DEVICE_SIGNATURE_SUITE)
  throw new Error("request_signature_crypto_suite_unavailable");
const SIGNATURE_VERSION = HMAC_SIGNATURE_SUITE.suiteId;
const SIGNATURE_PREFIX = HMAC_SIGNATURE_SUITE.protocolPrefix;
const DEVICE_SIGNATURE_VERSION = DEVICE_SIGNATURE_SUITE.suiteId;
const DEVICE_SIGNATURE_PREFIX = DEVICE_SIGNATURE_SUITE.protocolPrefix;
const CLIENT_REVOKED_ERROR = "CLIENT_REVOKED";
const INVALID_SIGNATURE_ERROR = "INVALID_SIGNATURE";
const SIGNING_SECRET_ROTATED_ERROR = "SIGNING_SECRET_ROTATED";
const CLIENT_IDENTITY_REAUTH_RECOVERY = "CLIENT_IDENTITY_REAUTH_REQUIRED";
const DEFAULT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const NONCE_CLEANUP_INTERVAL_MS = 60 * 1000;
const NONCE_VOLUME_AUDIT_INTERVAL_MS = 5 * 60 * 1000;
const legacySigningEncryption = new EncryptionManager();
let lastNonceCleanupAt = 0;
const nonceVolumeAuditAt = new Map();

const SIGNING_HEADERS = {
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

function compactString(value, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  if (!next) return null;
  return next.slice(0, maxLength);
}

function headerValue(request, name) {
  return request?.header?.(name) || request?.headers?.[name.toLowerCase()];
}

function numericEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function signatureWindowMs() {
  return numericEnv("ATHENA_SIGNATURE_WINDOW_MS", DEFAULT_SIGNATURE_WINDOW_MS);
}

function nonceTtlMs() {
  return numericEnv("ATHENA_NONCE_TTL_MS", DEFAULT_NONCE_TTL_MS);
}

function signingWarnOnly() {
  if (process.env.ATHENA_REQUIRE_SIGNED_HIGH_RISK === "true") return false;
  if (process.env.REQUEST_SIGNING_DEVICE_REQUIRED === "true") return false;
  if (process.env.ATHENA_DEVICE_SIGNATURE_REQUIRED === "true") return false;
  if (process.env.ATHENA_SIGNING_WARN_ONLY === "true") return true;
  if (process.env.ATHENA_SIGNING_WARN_ONLY === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function hmacHighRiskCompatEnabled() {
  if (process.env.REQUEST_SIGNING_HMAC_COMPAT === "true") return true;
  if (process.env.ATHENA_ALLOW_HMAC_HIGH_RISK_COMPAT === "true") return true;
  return false;
}

function deviceSignatureRequired() {
  if (process.env.REQUEST_SIGNING_DEVICE_REQUIRED === "false") return false;
  if (process.env.ATHENA_DEVICE_SIGNATURE_REQUIRED === "false") return false;
  if (process.env.REQUEST_SIGNING_DEVICE_REQUIRED === "true") return true;
  if (process.env.ATHENA_DEVICE_SIGNATURE_REQUIRED === "true") return true;
  if (hmacHighRiskCompatEnabled()) return false;
  return process.env.NODE_ENV === "production";
}

function productionRuntime() {
  return process.env.NODE_ENV === "production";
}

function nativeAppleMobileContext(context = {}) {
  const platform = String(context.platform || "").toLowerCase();
  if (!["ios", "ipad"].includes(platform)) return false;
  const surface = String(
    context.surface || context.capabilityProfile?.surface || ""
  ).toLowerCase();
  // Native clients released before capability profiles did not send a
  // surface. Browser/PWA clients do, and cannot access the native Secure
  // Enclave ML-DSA implementation.
  return !surface || ["mobile-app", "mobileapp"].includes(surface);
}

function iosHybridRequired(context = {}, client = null) {
  if (client?.pqPublicKey) return true;
  if (!nativeAppleMobileContext(context)) return false;
  if (!productionRuntime()) return false;
  return process.env.ATHENA_IOS_HIGH_RISK_PQ_REQUIRED === "true";
}

function isDeviceAttestationBootstrapPath(path = "") {
  const comparablePath = highRiskComparablePath(path);
  return (
    /^\/client-identity\/attestation\/(?:challenge|verify)$/.test(
      comparablePath
    ) ||
    comparablePath === "/client-identity/vault-kem-key" ||
    /^\/client-identity\/device-key-rotation\/(?:prepare|commit)$/.test(
      comparablePath
    )
  );
}

function iosDeviceAttestationRequired(context = {}, path = "") {
  return (
    deviceAttestationMode() === "required" &&
    nativeAppleMobileContext(context) &&
    !isDeviceAttestationBootstrapPath(path)
  );
}

async function registerClientHybridKEMKey({
  userId,
  clientId,
  publicKey = null,
  kemPublicKey = null,
  p256PublicKey,
  mlDSA65PublicKey,
  suiteId,
  keyGeneration = 1,
  allowRotation = false,
} = {}) {
  const suite = cryptoSuite(suiteId, {
    purpose: PURPOSES.VAULT_DEVICE_AUTHORIZATION,
  });
  const normalizedKEMPublicKey = String(kemPublicKey || publicKey || "");
  const normalizedP256PublicKey = String(p256PublicKey || "");
  const normalizedMLDSA65PublicKey = String(mlDSA65PublicKey || "");
  const raw = Buffer.from(normalizedKEMPublicKey, "base64url");
  const rawP256 = Buffer.from(normalizedP256PublicKey, "base64url");
  const rawMLDSA65 = Buffer.from(normalizedMLDSA65PublicKey, "base64url");
  const normalizedKeyGeneration = Number(keyGeneration);
  let p256Valid = false;
  let mlDSA65Valid = false;
  try {
    p256Valid =
      rawP256.length === 65 &&
      rawP256[0] === 0x04 &&
      crypto.ECDH.convertKey(
        rawP256,
        "prime256v1",
        undefined,
        undefined,
        "uncompressed"
      ).equals(rawP256);
    mlDSA65Valid = Boolean(importMLDSA65PublicKey(normalizedMLDSA65PublicKey));
  } catch {}
  if (
    !suite ||
    suite.suiteId !== SUITE_IDS.VAULT_XWING_MLDSA65_V1 ||
    raw.length !== 1216 ||
    raw.toString("base64url") !== normalizedKEMPublicKey ||
    rawMLDSA65.length !== 1952 ||
    rawMLDSA65.toString("base64url") !== normalizedMLDSA65PublicKey ||
    !Number.isSafeInteger(normalizedKeyGeneration) ||
    normalizedKeyGeneration < 1 ||
    !p256Valid ||
    !mlDSA65Valid
  )
    return { ok: false, reasonCode: "invalid_hybrid_kem_key" };
  const existing = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (!existing || existing.revokedAt)
    return { ok: false, reasonCode: "client_revoked_or_missing" };
  const existingBinding = [
    existing.hybridKemPublicKey,
    existing.vaultSigningP256PublicKey,
    existing.vaultSigningMLDSA65PublicKey,
  ];
  const requestedBinding = [
    normalizedKEMPublicKey,
    normalizedP256PublicKey,
    normalizedMLDSA65PublicKey,
  ];
  const currentGeneration = Math.max(
    Number(existing.vaultKeyGeneration || 0),
    1
  );
  const bindingChanged =
    existingBinding.some(Boolean) &&
    existingBinding.some((value, index) => value !== requestedBinding[index]);
  if (
    bindingChanged &&
    (!allowRotation || normalizedKeyGeneration !== currentGeneration + 1)
  )
    return {
      ok: false,
      reasonCode: "hybrid_kem_key_rotation_required",
      keyGeneration: currentGeneration,
    };
  if (
    existingBinding.every(
      (value, index) => value === requestedBinding[index]
    ) &&
    Number(existing.vaultKeyGeneration || 0) > 0
  )
    return {
      ok: normalizedKeyGeneration === currentGeneration,
      suiteId: suite.suiteId,
      keyGeneration: currentGeneration,
      reasonCode:
        normalizedKeyGeneration === currentGeneration
          ? undefined
          : "vault_key_generation_mismatch",
    };
  let bound;
  try {
    bound = await requestSigningDb.$transaction(async (tx) => {
      if (bindingChanged) {
        await tx.vault_device_key_registrations.upsert({
          where: {
            userId_clientId_keyGeneration: {
              userId: Number(userId),
              clientId: String(clientId),
              keyGeneration: currentGeneration,
            },
          },
          create: {
            id: `vkdkr_${crypto.randomUUID()}`,
            userId: Number(userId),
            clientId: String(clientId),
            keyGeneration: currentGeneration,
            suiteId: existing.vaultSigningSuiteId || suite.suiteId,
            kemPublicKey: existing.hybridKemPublicKey,
            p256PublicKey: existing.vaultSigningP256PublicKey,
            mlDSA65PublicKey: existing.vaultSigningMLDSA65PublicKey,
            status: "superseded",
            supersededAt: new Date(),
          },
          update: { status: "superseded", supersededAt: new Date() },
        });
      }
      const registration = await tx.vault_device_key_registrations.upsert({
        where: {
          userId_clientId_keyGeneration: {
            userId: Number(userId),
            clientId: String(clientId),
            keyGeneration: normalizedKeyGeneration,
          },
        },
        create: {
          id: `vkdkr_${crypto.randomUUID()}`,
          userId: Number(userId),
          clientId: String(clientId),
          keyGeneration: normalizedKeyGeneration,
          suiteId: suite.suiteId,
          kemPublicKey: normalizedKEMPublicKey,
          p256PublicKey: normalizedP256PublicKey,
          mlDSA65PublicKey: normalizedMLDSA65PublicKey,
          status: "active",
          hardwareProtection: existing.pqPublicKeyHardwareProtection || null,
        },
        update: {},
      });
      if (
        registration.suiteId !== suite.suiteId ||
        registration.kemPublicKey !== normalizedKEMPublicKey ||
        registration.p256PublicKey !== normalizedP256PublicKey ||
        registration.mlDSA65PublicKey !== normalizedMLDSA65PublicKey
      )
        throw new Error("vault_device_key_generation_conflict");
      const updated = await tx.athena_clients.updateMany({
        where: {
          userId: Number(userId),
          clientId: String(clientId),
          revokedAt: null,
          ...(bindingChanged
            ? { vaultKeyGeneration: Number(existing.vaultKeyGeneration || 0) }
            : {
                hybridKemPublicKey: null,
                vaultSigningP256PublicKey: null,
                vaultSigningMLDSA65PublicKey: null,
              }),
        },
        data: {
          hybridKemPublicKey: normalizedKEMPublicKey,
          hybridKemSuiteId: suite.suiteId,
          vaultSigningP256PublicKey: normalizedP256PublicKey,
          vaultSigningMLDSA65PublicKey: normalizedMLDSA65PublicKey,
          vaultSigningSuiteId: suite.suiteId,
          vaultKeyGeneration: normalizedKeyGeneration,
        },
      });
      if (updated.count !== 1)
        throw new Error("vault_device_key_registration_race");
      return updated;
    });
  } catch (error) {
    if (error?.message !== "vault_device_key_registration_race") throw error;
    bound = { count: 0 };
  }
  if (bound.count !== 1) {
    const current = await getClientRecord({
      userId,
      clientId,
      includeRevoked: true,
    });
    if (
      current?.revokedAt ||
      current?.hybridKemPublicKey !== normalizedKEMPublicKey ||
      current?.vaultSigningP256PublicKey !== normalizedP256PublicKey ||
      current?.vaultSigningMLDSA65PublicKey !== normalizedMLDSA65PublicKey ||
      Number(current?.vaultKeyGeneration || 0) !== normalizedKeyGeneration
    )
      return { ok: false, reasonCode: "hybrid_kem_key_rotation_required" };
  }
  return {
    ok: true,
    suiteId: suite.suiteId,
    keyGeneration: normalizedKeyGeneration,
    rotated: bindingChanged,
  };
}

function consoleAuditMetadata(request) {
  if (!productionRuntime()) return clientAuditMetadata(request);
  return {
    method: request?.method || null,
    path: highRiskComparablePath(canonicalPathForRequest(request)),
  };
}

function sha256Base64Url(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

function hmacBase64Url(secret, value) {
  return crypto
    .createHmac("sha256", secret)
    .update(String(value))
    .digest("base64url");
}

function newSigningSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function newSigningSecretVersion() {
  return `sec_${crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex")}`;
}

function encryptSigningSecret(secret) {
  return saveSecret(secret);
}

function decryptSigningSecret(encryptedSecret) {
  if (!encryptedSecret) return null;
  if (isSecretEncrypted(encryptedSecret)) return readSecret(encryptedSecret);

  try {
    const decrypted = legacySigningEncryption.decrypt(encryptedSecret);
    if (decrypted && decrypted !== encryptedSecret) return decrypted;
  } catch {}

  if (String(encryptedSecret).startsWith("enc:")) {
    return String(encryptedSecret).slice(4);
  }

  return String(encryptedSecret);
}

function signingErrorCode(reasonCode) {
  if (reasonCode === "client_revoked") return CLIENT_REVOKED_ERROR;
  if (
    [
      "signature_mismatch",
      "device_key_mismatch",
      "invalid_device_public_key",
      "unsupported_device_key_suite",
      "unsupported_signature_suite",
      "unsupported_signature_suite_for_client",
      "post_quantum_signature_required",
      "post_quantum_signature_incomplete",
      "unsupported_post_quantum_signature_suite",
      "unsupported_hybrid_signature_suite",
      "post_quantum_device_key_mismatch",
      "post_quantum_signature_mismatch",
    ].includes(reasonCode)
  ) {
    return INVALID_SIGNATURE_ERROR;
  }
  if (reasonCode === "signing_secret_rotated")
    return SIGNING_SECRET_ROTATED_ERROR;
  return "invalid_signed_request";
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalPathForRequest(request) {
  return request?.originalUrl || request?.url || "/";
}

function externalWebSocketPath(value = "/") {
  const raw = String(value || "/");
  const queryIndex = raw.indexOf("?");
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const query = queryIndex >= 0 ? raw.slice(queryIndex) : "";
  const externalPath = path.endsWith("/.websocket")
    ? path.slice(0, -"/.websocket".length) || "/"
    : path || "/";
  return `${externalPath}${query}`;
}

function canonicalWebSocketPathForRequest(request) {
  // Router-mounted websocket requests can retain a proxy-facing originalUrl
  // that is not the route view used by the browser. Prefer the active router
  // URL. express-ws adds one internal /.websocket route sentinel, which is
  // never part of the client-visible path and must be removed before signing.
  return (
    externalWebSocketPath(request?.url || request?.originalUrl || "/").split(
      "?"
    )[0] || "/"
  );
}

function equivalentWebSocketApiPath(path = "/") {
  const stablePath = String(path || "/");
  if (stablePath === "/api") return "/";
  if (stablePath.startsWith("/api/")) return stablePath.slice(4) || "/";
  return stablePath === "/" ? "/api" : `/api${stablePath}`;
}

function canonicalWebSocketPathCandidates(request) {
  const stablePath = canonicalWebSocketPathForRequest(request);
  const legacyPath = externalWebSocketPath(canonicalPathForRequest(request));
  const candidates = [
    { path: stablePath, mode: "stable_path" },
    {
      path: equivalentWebSocketApiPath(stablePath),
      mode: "api_mount_equivalent_path",
    },
    { path: legacyPath, mode: "legacy_query_path" },
  ];
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex((entry) => entry.path === candidate.path) === index
  );
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

function highRiskComparablePath(value = "") {
  const path = String(value || "/").split("?")[0] || "/";
  return path.startsWith("/api/") ? path.slice(4) : path;
}

function canonicalPublicKey(value = null) {
  const raw = compactString(value, 2048);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed?.kty !== "EC" ||
      parsed?.crv !== "P-256" ||
      typeof parsed?.x !== "string" ||
      typeof parsed?.y !== "string"
    ) {
      return null;
    }
    return JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: parsed.x,
      y: parsed.y,
      ext: true,
      key_ops: ["verify"],
    });
  } catch {
    return null;
  }
}

function normalizeDeviceKeyAlgorithm(value = null) {
  const algorithm = compactString(value, 96) || "p256-v1";
  return (
    cryptoSuite(algorithm, { purpose: PURPOSES.DEVICE_KEY })?.suiteId || null
  );
}

function isDeviceSignatureVersion(value) {
  return (
    cryptoSuite(value, { purpose: PURPOSES.REQUEST_SIGNATURE })
      ?.authentication === "device-bound"
  );
}

function verifyDeviceSignature({
  publicKey,
  signingString,
  signature,
  suite = DEVICE_SIGNATURE_SUITE,
} = {}) {
  if (!suite || suite.purpose !== PURPOSES.REQUEST_SIGNATURE) return false;
  if (!supportsNodeSignatureSuite(suite)) return false;
  const canonicalKey = canonicalPublicKey(publicKey);
  if (!canonicalKey) return false;
  try {
    const publicKeyObject = crypto.createPublicKey({
      key: JSON.parse(canonicalKey),
      format: "jwk",
    });
    return verifyWithCryptoSuite({
      suite,
      data: Buffer.from(String(signingString)),
      publicKey: publicKeyObject,
      signature,
    });
  } catch {
    return false;
  }
}

async function ensureClientDevicePublicKey({
  userId,
  clientId,
  context = null,
  publicKey,
  deviceKeyAlgorithm,
  allowPending = false,
} = {}) {
  const canonicalKey = canonicalPublicKey(publicKey);
  const normalizedAlgorithm = normalizeDeviceKeyAlgorithm(deviceKeyAlgorithm);
  if (!canonicalKey || !normalizedAlgorithm) {
    return { ok: false, reasonCode: "invalid_device_public_key" };
  }
  const deviceKeySuite = cryptoSuite(normalizedAlgorithm, {
    purpose: PURPOSES.DEVICE_KEY,
  });
  if (!deviceKeySuite) {
    return { ok: false, reasonCode: "unsupported_device_key_suite" };
  }
  if (!suiteSupportsClient(deviceKeySuite, context?.appVersion)) {
    return { ok: false, reasonCode: "unsupported_device_key_suite" };
  }

  const client = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (client?.revokedAt) return { ok: false, reasonCode: "client_revoked" };
  if (!client && context) {
    await registerClient({
      userId,
      clientId,
      platform: context.platform,
      appVersion: context.appVersion,
      trustLevel: "medium",
      capabilities: context.capabilities,
      capabilitySource: context.capabilitySource,
      publicKey: canonicalKey,
      deviceFingerprintVersion: normalizedAlgorithm,
    });
    return {
      ok: true,
      publicKey: canonicalKey,
      client: null,
      deviceKeySuite,
    };
  }
  if (!client) return { ok: false, reasonCode: "missing_client" };
  const pendingAllowed =
    allowPending &&
    client.pendingPublicKey === canonicalKey &&
    client.pendingDeviceKeyAlgorithm === normalizedAlgorithm &&
    client.pendingDeviceKeyExpiresAt &&
    new Date(client.pendingDeviceKeyExpiresAt).getTime() > Date.now();
  if (
    client.publicKey &&
    client.publicKey !== canonicalKey &&
    !pendingAllowed
  ) {
    return { ok: false, reasonCode: "device_key_mismatch" };
  }

  if (!client.publicKey) {
    const keyMetadata = keyMetadataForSuite(normalizedAlgorithm, {
      purpose: PURPOSES.DEVICE_KEY,
    });
    await requestSigningDb.athena_clients.updateMany({
      where: {
        userId: Number(userId),
        clientId: String(clientId),
        revokedAt: null,
        publicKey: null,
      },
      data: {
        publicKey: canonicalKey,
        deviceFingerprintVersion: normalizedAlgorithm,
        publicKeyAlgorithm: keyMetadata?.algorithm || null,
        publicKeyParameterSet: keyMetadata?.parameterSet || null,
        publicKeyOrigin: keyMetadata?.keyOrigin || null,
        publicKeyHardwareProtection: keyMetadata?.hardwareProtection || null,
        trustLevel: "medium",
        attestationStatus: "unverified",
      },
    });
  }

  return {
    ok: true,
    publicKey: canonicalKey,
    client,
    pendingKey: pendingAllowed,
    deviceKeySuite,
  };
}

function isHighRiskSignedRequest({ method, path } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const comparablePath = highRiskComparablePath(path);
  if (
    normalizedMethod === "GET" &&
    (/^\/vault\/items\/[^/]+$/.test(comparablePath) ||
      comparablePath === "/vault/key-epochs" ||
      comparablePath === "/vault/device-key-envelopes" ||
      comparablePath === "/vault/user-root-key" ||
      comparablePath === "/vault/user-root-key/authorization-targets" ||
      comparablePath === "/vault/user-root-key/envelopes" ||
      /^\/vault\/recovery-packages\/[^/]+$/.test(comparablePath))
  ) {
    return true;
  }
  if (
    normalizedMethod === "GET" &&
    /^\/sync\/events\/replay$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "GET" &&
    /^\/vault\/user-domain-wraps(?:\/coverage)?$/.test(comparablePath)
  ) {
    return true;
  }
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;

  const highRiskRoutes = [
    {
      methods: ["POST"],
      pattern: /^\/auth\/session\/recovery\/enroll$/,
    },
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
        /^\/client-identity\/(?:vault-kem-key(?:\/rotate)?|crypto-observations)$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/client-identity\/attestation\/(?:challenge|verify)$/,
    },
    {
      methods: ["POST"],
      pattern:
        /^\/admin\/security\/keys\/(?:session|preflight|rotations(?:\/[^/]+\/(?:approve|execute))?|recovery\/verify)$/,
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
      pattern: /^\/system\/provider-settings\/llm$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/system\/custom-models$/,
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
      pattern: /^\/sync\/thread-fingerprints$/,
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
      methods: ["POST", "DELETE"],
      pattern: /^\/native-app\/push-token$/,
    },
    {
      methods: ["POST"],
      pattern: /^\/workspace\/[^/]+\/thread\/[^/]+\/update$/,
    },
    {
      methods: ["POST"],
      pattern:
        /^\/operations\/actions\/runs(?:\/[^/]+\/(?:approve|reject|execute|reconcile))?$/,
    },
  ];
  if (
    highRiskRoutes.some(
      (route) =>
        route.methods.includes(normalizedMethod) &&
        route.pattern.test(comparablePath)
    )
  ) {
    return true;
  }

  if (
    normalizedMethod === "POST" &&
    /^\/workspace\/[^/]+\/tool-approval$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+\/remove-and-unembed$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/reader-documents\/[^/]+$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "DELETE" &&
    /^\/workspace\/[^/]+\/reader-documents\/[^/]+$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/crypto-component-experiment(?:\/[^/]+)?\/config$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod) &&
    comparablePath.startsWith("/admin/")
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/client-identity\/revoke(?:-all-others)?$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/client-identity\/rotate-(?:signing-secret|all-signing-secrets)$/.test(
      comparablePath
    )
  ) {
    return true;
  }
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/vault\/items(?:\/[^/]+)?$/.test(comparablePath)
  ) {
    return true;
  }
  if (
    ["POST", "DELETE"].includes(normalizedMethod) &&
    /^\/vault\/(?:reauth\/password|access-grants(?:\/current)?|lock)$/.test(
      comparablePath
    )
  ) {
    return true;
  }

  return false;
}

function requestSigningHeaders(request) {
  return {
    clientId: compactString(headerValue(request, CLIENT_HEADERS.clientId), 256),
    requestId: compactString(
      headerValue(request, CLIENT_HEADERS.requestId),
      256
    ),
    timestamp: compactString(headerValue(request, SIGNING_HEADERS.timestamp)),
    nonce: compactString(headerValue(request, SIGNING_HEADERS.nonce), 256),
    bodySha256: compactString(
      headerValue(request, SIGNING_HEADERS.bodySha256),
      256
    ),
    signature: compactString(
      headerValue(request, SIGNING_HEADERS.signature),
      1024
    ),
    signatureVersion: compactString(
      headerValue(request, SIGNING_HEADERS.signatureVersion),
      96
    ),
    devicePublicKey: compactString(
      headerValue(request, SIGNING_HEADERS.devicePublicKey),
      2048
    ),
    deviceKeyAlgorithm: compactString(
      headerValue(request, SIGNING_HEADERS.deviceKeyAlgorithm),
      96
    ),
    hybridSignatureVersion: compactString(
      headerValue(request, SIGNING_HEADERS.hybridSignatureVersion),
      96
    ),
    pqSignature: compactString(
      headerValue(request, SIGNING_HEADERS.pqSignature),
      8192
    ),
    pqPublicKey: compactString(
      headerValue(request, SIGNING_HEADERS.pqPublicKey),
      4096
    ),
    pqKeyAlgorithm: compactString(
      headerValue(request, SIGNING_HEADERS.pqKeyAlgorithm),
      96
    ),
    pqKeyOrigin: compactString(
      headerValue(request, SIGNING_HEADERS.pqKeyOrigin),
      96
    ),
    pqHardwareProtection: compactString(
      headerValue(request, SIGNING_HEADERS.pqHardwareProtection),
      96
    ),
  };
}

function parseTimestamp(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signingFailure(reasonCode, details = {}) {
  return {
    ok: false,
    reasonCode,
    details,
  };
}

async function cleanupExpiredNonces() {
  const now = Date.now();
  if (now - lastNonceCleanupAt < NONCE_CLEANUP_INTERVAL_MS) return;
  lastNonceCleanupAt = now;

  try {
    await requestSigningDb.athena_request_nonces.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    });
  } catch (error) {
    console.warn("[request-signing] Nonce cleanup failed", error.message);
  }
}

async function auditNonceVolume({ clientId, userId } = {}) {
  if (
    !clientId ||
    typeof requestSigningDb.athena_request_nonces.count !== "function"
  )
    return;

  const threshold = numericEnv("ATHENA_NONCE_WARNING_THRESHOLD", 5_000);
  const now = Date.now();
  const lastAuditAt = nonceVolumeAuditAt.get(clientId) || 0;
  if (now - lastAuditAt < NONCE_VOLUME_AUDIT_INTERVAL_MS) return;

  try {
    const activeNonceCount = await requestSigningDb.athena_request_nonces.count(
      {
        where: {
          clientId: String(clientId),
          expiresAt: { gt: new Date(now) },
        },
      }
    );
    if (activeNonceCount >= threshold) {
      nonceVolumeAuditAt.set(clientId, now);
      const metadata = productionRuntime()
        ? { activeNonceCount, threshold }
        : { clientId, userId: userId || null, activeNonceCount, threshold };
      console.warn("[request-signing] High active nonce volume", metadata);
    }
  } catch (error) {
    console.warn("[request-signing] Nonce volume audit failed", error.message);
  }
}

async function clientSigningSecret({ userId, clientId } = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const client = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (client?.revokedAt) return { client, secret: null, revoked: true };
  if (!client?.signingSecretEncrypted) return null;

  let secret = null;
  try {
    secret = decryptSigningSecret(client.signingSecretEncrypted);
  } catch (error) {
    console.warn(
      "[request-signing] Failed to decrypt client signing secret; reissuing",
      productionRuntime()
        ? { clientId: "[redacted]" }
        : { clientId, error: error.message }
    );
    return null;
  }
  if (secret && !isSecretEncrypted(client.signingSecretEncrypted)) {
    try {
      await requestSigningDb.athena_clients.updateMany({
        where: {
          userId: Number(userId),
          clientId: String(clientId),
          revokedAt: null,
        },
        data: {
          signingSecretEncrypted: encryptSigningSecret(secret),
        },
      });
    } catch (error) {
      console.warn(
        "[request-signing] Failed to migrate signing secret encryption",
        productionRuntime()
          ? { clientId: "[redacted]" }
          : { clientId, error: error.message }
      );
    }
  }
  return secret ? { client, secret } : null;
}

async function ensureClientSigningSecret({ context } = {}) {
  if (!context?.userId || !context?.clientId || context.clientId === "legacy") {
    return null;
  }

  const client = await getClientRecord({
    userId: context.userId,
    clientId: context.clientId,
    includeRevoked: true,
  });
  if (client?.revokedAt) {
    return { revoked: true, client };
  }

  const existing = await clientSigningSecret({
    userId: context.userId,
    clientId: context.clientId,
  });
  if (existing?.secret) {
    return {
      secret: existing.secret,
      signatureVersion: SIGNATURE_VERSION,
      signingSecretVersion: existing.client.signingSecretVersion || null,
      issuedAt: existing.client.signingSecretIssuedAt,
      rotatedAt: existing.client.signingSecretRotatedAt || null,
    };
  }

  const secret = newSigningSecret();
  const encrypted = encryptSigningSecret(secret);
  if (!encrypted) return null;

  const signingSecretVersion = newSigningSecretVersion();
  await registerClient({
    userId: context.userId,
    clientId: context.clientId,
    platform: context.platform,
    appVersion: context.appVersion,
    trustLevel: context.trustLevel,
    capabilities: context.capabilities,
    capabilitySource: context.capabilitySource,
  });

  const issuedAt = new Date();
  await requestSigningDb.athena_clients.updateMany({
    where: {
      userId: Number(context.userId),
      clientId: String(context.clientId),
      revokedAt: null,
    },
    data: {
      signingSecretEncrypted: encrypted,
      signingSecretVersion,
      signingSecretIssuedAt: issuedAt,
      signingSecretRotatedAt: issuedAt,
    },
  });

  return {
    secret,
    signatureVersion: SIGNATURE_VERSION,
    signingSecretVersion,
    issuedAt,
    rotatedAt: issuedAt,
  };
}

async function rotateSigningSecret({
  userId,
  clientId,
  actorClientId = null,
} = {}) {
  if (!userId || !clientId || clientId === "legacy") return null;
  const client = await getClientRecord({
    userId,
    clientId,
    includeRevoked: true,
  });
  if (!client) return null;
  if (client.revokedAt) return { client, revoked: true };

  const secret = newSigningSecret();
  const encrypted = encryptSigningSecret(secret);
  if (!encrypted) return null;

  const issuedAt = new Date();
  const signingSecretVersion = newSigningSecretVersion();
  const result = await requestSigningDb.athena_clients.updateMany({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      revokedAt: null,
    },
    data: {
      signingSecretEncrypted: encrypted,
      signingSecretVersion,
      signingSecretIssuedAt: issuedAt,
      signingSecretRotatedAt: issuedAt,
    },
  });
  if (!result.count) return null;

  return {
    client: {
      ...client,
      signingSecretVersion,
      signingSecretIssuedAt: issuedAt,
      signingSecretRotatedAt: issuedAt,
    },
    rotated: true,
    oldVersion: client.signingSecretVersion || null,
    newVersion: signingSecretVersion,
    issuedAt,
    rotatedAt: issuedAt,
    secret:
      actorClientId && String(actorClientId) === String(clientId)
        ? secret
        : null,
  };
}

async function rotateAllSigningSecrets({ userId, currentClientId } = {}) {
  if (!userId || !currentClientId || currentClientId === "legacy") {
    return { count: 0, currentClient: null, clients: [] };
  }
  const clients = await requestSigningDb.athena_clients.findMany({
    where: {
      userId: Number(userId),
      revokedAt: null,
    },
  });

  const rotated = [];
  let currentClient = null;
  for (const client of clients) {
    const result = await rotateSigningSecret({
      userId,
      clientId: client.clientId,
      actorClientId: currentClientId,
    });
    if (!result?.rotated) continue;
    rotated.push(result);
    if (client.clientId === currentClientId) currentClient = result;
  }

  return {
    count: rotated.length,
    currentClient,
    clients: rotated,
  };
}

async function claimNonce({ clientId, userId, nonce, requestId, timestampMs }) {
  await cleanupExpiredNonces();
  await auditNonceVolume({ clientId, userId });
  try {
    await requestSigningDb.athena_request_nonces.create({
      data: {
        clientId: String(clientId),
        userId: userId ? Number(userId) : null,
        nonce: String(nonce),
        requestId: requestId || null,
        timestamp: new Date(timestampMs),
        expiresAt: new Date(Date.now() + nonceTtlMs()),
      },
    });
    return true;
  } catch (error) {
    if (error?.code === "P2002") return false;
    throw error;
  }
}

async function verifySignatureParts({
  request,
  method,
  canonicalPath,
  bodyString = "",
  bodySha256Override = null,
  signed = {},
} = {}) {
  const context = getClientContext(request);
  const clientId = compactString(signed.clientId, 256);
  const requestId = compactString(signed.requestId, 256);
  const timestamp = compactString(signed.timestamp);
  const nonce = compactString(signed.nonce, 256);
  const bodySha256 = compactString(signed.bodySha256, 256);
  const signature = compactString(signed.signature, 1024);
  const signatureVersion = compactString(signed.signatureVersion, 96);
  const devicePublicKey = compactString(signed.devicePublicKey, 2048);
  const deviceKeyAlgorithm = compactString(signed.deviceKeyAlgorithm, 96);
  const hybridSignatureVersion = compactString(
    signed.hybridSignatureVersion,
    96
  );
  const pqSignature = compactString(signed.pqSignature, 8192);
  const pqPublicKey = compactString(signed.pqPublicKey, 4096);
  const pqKeyAlgorithm = compactString(signed.pqKeyAlgorithm, 96);

  const signatureSuite = cryptoSuite(signatureVersion, {
    purpose: PURPOSES.REQUEST_SIGNATURE,
  });
  if (
    !clientId ||
    !requestId ||
    !timestamp ||
    !nonce ||
    !bodySha256 ||
    !signature ||
    !signatureVersion
  ) {
    return signingFailure("missing_signature");
  }
  if (!signatureSuite) return signingFailure("unsupported_signature_suite");
  if (!suiteSupportsClient(signatureSuite, context.appVersion)) {
    return signingFailure("unsupported_signature_suite_for_client");
  }
  if (context.legacy || !context.userId) {
    return signingFailure("missing_authenticated_client");
  }
  if (clientId !== context.clientId) {
    return signingFailure("client_mismatch");
  }

  const timestampMs = parseTimestamp(timestamp);
  if (!timestampMs) return signingFailure("invalid_timestamp");
  if (Math.abs(Date.now() - timestampMs) > signatureWindowMs()) {
    return signingFailure("expired_timestamp");
  }

  const expectedBodyHash = bodySha256Override || sha256Base64Url(bodyString);
  if (!timingSafeEqualString(expectedBodyHash, bodySha256)) {
    return signingFailure("body_hash_mismatch");
  }

  const signingString = canonicalSigningString({
    method,
    canonicalPath,
    timestamp,
    nonce,
    requestId,
    clientId,
    bodySha256,
    prefix: signatureSuite.protocolPrefix,
  });

  if (signatureSuite.authentication === "device-bound") {
    const keyBinding = await ensureClientDevicePublicKey({
      userId: context.userId,
      clientId,
      context,
      publicKey: devicePublicKey,
      deviceKeyAlgorithm,
      allowPending:
        highRiskComparablePath(canonicalPath) ===
        "/client-identity/device-key-rotation/commit",
    });
    if (!keyBinding.ok) return signingFailure(keyBinding.reasonCode);
    if (
      !verifyDeviceSignature({
        publicKey: keyBinding.publicKey,
        signingString,
        signature,
        suite: signatureSuite,
      })
    ) {
      return signingFailure("signature_mismatch");
    }
    const client =
      keyBinding.client ||
      (await getClientRecord({
        userId: context.userId,
        clientId,
        includeRevoked: true,
      }));
    const pqRequired = iosHybridRequired(context, client, request);
    const pqSuite = cryptoSuite(pqKeyAlgorithm, {
      purpose: PURPOSES.REQUEST_SIGNATURE,
    });
    const hybridSuite = cryptoSuite(hybridSignatureVersion, {
      purpose: PURPOSES.REQUEST_SIGNATURE,
    });
    const pqHeaderPresent = Boolean(
      pqSignature || pqPublicKey || pqKeyAlgorithm || hybridSignatureVersion
    );
    const completePQEnvelope = Boolean(
      pqSignature && pqPublicKey && pqKeyAlgorithm && hybridSignatureVersion
    );
    if (pqHeaderPresent && !completePQEnvelope)
      return signingFailure("post_quantum_signature_incomplete");
    if (pqRequired && !completePQEnvelope)
      return signingFailure("post_quantum_signature_required");
    let postQuantumVerified = false;
    if (completePQEnvelope) {
      if (pqSuite?.suiteId !== SUITE_IDS.REQUEST_DEVICE_MLDSA65_V1)
        return signingFailure("unsupported_post_quantum_signature_suite");
      if (hybridSuite?.suiteId !== SUITE_IDS.DEVICE_HYBRID_P256_MLDSA65_V1)
        return signingFailure("unsupported_hybrid_signature_suite");
      if (client?.pqPublicKey && client.pqPublicKey !== pqPublicKey)
        return signingFailure("post_quantum_device_key_mismatch");
      let pqValid = false;
      try {
        pqValid = verifyWithCryptoSuite({
          suite: pqSuite,
          data: Buffer.from(signingString),
          publicKey: importMLDSA65PublicKey(pqPublicKey),
          signature: pqSignature,
        });
      } catch {}
      if (!pqValid) return signingFailure("post_quantum_signature_mismatch");
      if (!client?.pqPublicKey) {
        const bound = await requestSigningDb.athena_clients.updateMany({
          where: {
            userId: Number(context.userId),
            clientId: String(clientId),
            revokedAt: null,
            pqPublicKey: null,
          },
          data: {
            pqPublicKey,
            pqKeyAlgorithm: pqSuite.suiteId,
            pqPublicKeyParameterSet: pqSuite.parameterSet,
            pqPublicKeyOrigin: `client-asserted:${compactString(signed.pqKeyOrigin, 72) || "unknown"}`,
            pqPublicKeyHardwareProtection: `client-asserted:${compactString(signed.pqHardwareProtection, 72) || "not-attested"}`,
            attestationStatus: "unverified",
          },
        });
        if (bound.count !== 1) {
          const current = await getClientRecord({
            userId: context.userId,
            clientId,
            includeRevoked: true,
          });
          if (current?.pqPublicKey !== pqPublicKey)
            return signingFailure("post_quantum_device_key_mismatch");
        }
      }
      postQuantumVerified = true;
    }
    const attestationVerified = validDeviceAttestation(client);
    if (
      iosDeviceAttestationRequired(context, canonicalPath) &&
      !attestationVerified
    )
      return signingFailure("device_attestation_required");
    signed.deviceAttestationVerified = attestationVerified;
    signed.postQuantumVerified = postQuantumVerified;
  } else {
    const secretRecord = await clientSigningSecret({
      userId: context.userId,
      clientId,
    });
    if (secretRecord?.client?.revokedAt)
      return signingFailure("client_revoked");
    if (!secretRecord?.secret) return signingFailure("missing_signing_secret");

    const expectedSignature = hmacBase64Url(secretRecord.secret, signingString);
    if (!timingSafeEqualString(expectedSignature, signature)) {
      return signingFailure("signature_mismatch");
    }
  }

  const nonceClaimed = await claimNonce({
    clientId,
    userId: context.userId,
    nonce,
    requestId,
    timestampMs,
  });
  if (!nonceClaimed) return signingFailure("nonce_replay");

  return {
    ok: true,
    clientContext: context,
    requestId,
    signatureVersion,
    cryptoSuiteId: signatureSuite.suiteId,
    hybridSignatureVersion: hybridSignatureVersion || null,
    postQuantumVerified: signed.postQuantumVerified === true,
    deviceAttestationVerified: signed.deviceAttestationVerified === true,
  };
}

async function recordSigningAudit(request, result, metadata = {}) {
  const reasonCode = result?.ok ? "verified" : result?.reasonCode || "failed";
  try {
    await recordClientTrustCheckpoint(request, {
      action: "signed_high_risk_request",
      resourceType: "request",
      resourceId: request?.originalUrl || request?.url || null,
      outcome: result?.ok ? "verified" : "rejected",
      metadata: {
        ...metadata,
        signatureVersion: result?.signatureVersion || null,
        signatureResult: result?.ok ? "verified" : "failed",
        reasonCode,
        ...clientAuditMetadata(request),
      },
    });
  } catch {}
}

async function verifySignedRequest(request) {
  const canonicalPath = canonicalPathForRequest(request);
  const signed = requestSigningHeaders(request);
  return verifySignatureParts({
    request,
    method: request.method,
    canonicalPath,
    bodyString: request.rawBody || "",
    bodySha256Override: request.rawBodySha256 || null,
    signed,
  });
}

function identityCapabilityDescriptor(
  request,
  { transport = "http", signed = null, computedBodySha256 = null } = {}
) {
  const context = getClientContext(request);
  return {
    transport,
    method: transport === "websocket" ? "WS" : request.method,
    originalUrl: request?.originalUrl || request?.url || "/",
    computedBodySha256:
      computedBodySha256 ||
      request?.rawBodySha256 ||
      sha256Base64Url(request?.rawBody || ""),
    signed: signed || requestSigningHeaders(request),
    client: {
      clientId: context.clientId,
      platform: context.platform,
      appVersion: context.appVersion,
      requestId: context.requestId,
      trustLevel: context.trustLevel,
      capabilitySource: context.capabilitySource,
      capabilities: context.capabilities,
      surface: context.surface,
    },
  };
}

async function requireIdentityOwnedSignedHighRiskRequest(
  request,
  response,
  next
) {
  const canonicalPath = canonicalPathForRequest(request);
  if (
    !isHighRiskSignedRequest({ method: request.method, path: canonicalPath })
  ) {
    return next();
  }
  const identity = require("../authz/identityOperationsClient");
  const descriptor = identityCapabilityDescriptor(request);
  let result;
  try {
    const verified = await identity.verifyRequestSigningViaIdentity({
      request,
      descriptor,
      idempotencyKey: descriptor.signed?.nonce
        ? `identity-signature:${descriptor.signed.nonce}`
        : null,
    });
    result = verified?.result || signingFailure("identity_verification_failed");
  } catch {
    return response.status(503).json({
      success: false,
      error: "identity_capability_unavailable",
      retryable: true,
    });
  }

  if (
    result.ok &&
    deviceSignatureRequired() &&
    !isDeviceSignatureVersion(result.signatureVersion)
  ) {
    result = {
      ok: false,
      reasonCode: "device_signature_required",
      signatureVersion: result.signatureVersion,
    };
  }
  if (result.ok || signingWarnOnly()) {
    if (result.ok) request.signedRequest = result;
    return next();
  }
  const errorCode = signingErrorCode(result.reasonCode);
  if (errorCode === CLIENT_REVOKED_ERROR) {
    return response
      .status(403)
      .json({ success: false, error: CLIENT_REVOKED_ERROR });
  }
  const reauthenticationRequired = [
    "device_key_mismatch",
    "post_quantum_device_key_mismatch",
  ].includes(result.reasonCode);
  return response.status(401).json({
    success: false,
    error: errorCode,
    reason: result.reasonCode,
    ...(reauthenticationRequired
      ? { recovery: CLIENT_IDENTITY_REAUTH_RECOVERY }
      : {}),
  });
}

function ownerRequestFromDescriptor({ principal = {}, descriptor = {} } = {}) {
  const originalUrl = compactString(descriptor.originalUrl, 2048) || "/";
  const client = descriptor.client || {};
  const clientContext = {
    clientId: compactString(principal.clientId || client.clientId, 256),
    userId: principal.userId ? Number(principal.userId) : null,
    platform: compactString(client.platform, 32) || "web",
    appVersion: compactString(client.appVersion, 128),
    requestId: compactString(client.requestId, 256),
    trustLevel: compactString(client.trustLevel, 32) || "low",
    capabilitySource: compactString(client.capabilitySource, 32) || "unknown",
    capabilities:
      client.capabilities && typeof client.capabilities === "object"
        ? client.capabilities
        : null,
    surface: compactString(client.surface, 64),
    legacy: false,
  };
  return {
    method: compactString(descriptor.method, 16) || "POST",
    originalUrl,
    url: originalUrl,
    path: originalUrl.split("?")[0],
    clientContext,
  };
}

async function verifySignedDescriptorAsOwner({
  principal,
  descriptor = {},
} = {}) {
  if (!principal?.userId || !principal?.clientId) {
    return signingFailure("missing_authenticated_client");
  }
  const request = ownerRequestFromDescriptor({ principal, descriptor });
  const signed =
    descriptor.signed && typeof descriptor.signed === "object"
      ? { ...descriptor.signed }
      : {};
  const bodySha256Override = compactString(descriptor.computedBodySha256, 256);
  if (!bodySha256Override) return signingFailure("body_hash_missing");

  if (descriptor.transport === "websocket") {
    const candidates = canonicalWebSocketPathCandidates(request);
    let result;
    let canonicalPathMode = candidates[0].mode;
    for (const candidate of candidates) {
      result = await verifySignatureParts({
        request,
        method: "WS",
        canonicalPath: candidate.path,
        bodySha256Override,
        signed,
      });
      canonicalPathMode = candidate.mode;
      if (result.ok || result.reasonCode !== "signature_mismatch") break;
    }
    return { ...result, canonicalPathMode };
  }

  return verifySignatureParts({
    request,
    method: request.method,
    canonicalPath: canonicalPathForRequest(request),
    bodySha256Override,
    signed,
  });
}

async function appendSigningAuditAsOwner({
  principal,
  descriptor = {},
  result = {},
  metadata = {},
} = {}) {
  const request = ownerRequestFromDescriptor({ principal, descriptor });
  return recordSigningAudit(request, result, metadata);
}

async function requireSignedHighRiskRequest(request, response, next) {
  const canonicalPath = canonicalPathForRequest(request);
  if (
    !isHighRiskSignedRequest({
      method: request.method,
      path: canonicalPath,
    })
  ) {
    return next();
  }

  const result = await verifySignedRequest(request);
  await recordSigningAudit(request, result, { transport: "http" });
  if (
    result.ok &&
    deviceSignatureRequired() &&
    !isDeviceSignatureVersion(result.signatureVersion)
  ) {
    const rejected = {
      ok: false,
      reasonCode: "device_signature_required",
      signatureVersion: result.signatureVersion,
    };
    await recordSigningAudit(request, rejected, {
      transport: "http",
      policy: "device_signature_required",
    });
    return response
      .status(401)
      .json({ success: false, error: INVALID_SIGNATURE_ERROR });
  }
  if (result.ok || signingWarnOnly()) {
    if (!result.ok) {
      console.warn("[request-signing] Warn-only signature failure", {
        reasonCode: result.reasonCode,
        ...consoleAuditMetadata(request),
      });
    }
    if (result.ok) request.signedRequest = result;
    return next();
  }

  const errorCode = signingErrorCode(result.reasonCode);
  if (errorCode === CLIENT_REVOKED_ERROR) {
    return response
      .status(403)
      .json({ success: false, error: CLIENT_REVOKED_ERROR });
  }
  if (errorCode === INVALID_SIGNATURE_ERROR) {
    const reauthenticationRequired = [
      "device_key_mismatch",
      "post_quantum_device_key_mismatch",
    ].includes(result.reasonCode);
    if (reauthenticationRequired) {
      metrics.authClientIdentityRecoveryRequired.inc({
        reason: result.reasonCode,
      });
      emitSemanticEvent({
        eventType: "auth.client_identity.recovery_required",
        category: "auth",
        severity: "warning",
        outcome: "denied",
        subject: {
          type: "component",
          component: "request-signing",
          operation: "client-identity-verification",
        },
        stateTransition: {
          from: "authenticated",
          to: "recovery-required",
          reasonCode: result.reasonCode,
        },
        correlation: {
          requestId: request?.clientContext?.requestId || null,
          clientId: null,
        },
        metadata: {
          platform: request?.clientContext?.platform || "unknown",
        },
        sensitivity: "metadata_only",
      });
    }
    return response.status(401).json({
      success: false,
      error: INVALID_SIGNATURE_ERROR,
      reason: result.reasonCode,
      ...(reauthenticationRequired
        ? { recovery: CLIENT_IDENTITY_REAUTH_RECOVERY }
        : {}),
    });
  }

  return response
    .status(401)
    .json({ success: false, error: "invalid_signed_request" });
}

function parseSocketMessage(rawMessage) {
  const raw =
    typeof rawMessage === "string" ? rawMessage : rawMessage?.toString?.();
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== "object") {
    return { raw, payload: null, envelope: null, signed: false };
  }
  if (
    parsed.type === "athenaSignedMessage" &&
    cryptoSuite(parsed.signatureVersion, {
      purpose: PURPOSES.REQUEST_SIGNATURE,
    }) &&
    parsed.signed &&
    Object.prototype.hasOwnProperty.call(parsed, "payload")
  ) {
    return {
      raw,
      payload: parsed.payload,
      envelope: parsed,
      signed: true,
    };
  }
  return { raw, payload: parsed, envelope: null, signed: false };
}

async function verifySignedWebSocketMessage(request, rawMessage) {
  const parsed = parseSocketMessage(rawMessage);
  if (!parsed.signed) {
    return {
      ok: false,
      unsigned: true,
      payload: parsed.payload,
      rawMessage: parsed.raw,
      reasonCode: "missing_signature",
    };
  }

  const payloadString = JSON.stringify(parsed.payload ?? null);
  const signed = {
    ...parsed.envelope.signed,
    signatureVersion: parsed.envelope.signatureVersion,
  };
  const candidates = canonicalWebSocketPathCandidates(request);
  let result;
  let canonicalPathMode = candidates[0].mode;
  for (const candidate of candidates) {
    result = await verifySignatureParts({
      request,
      method: "WS",
      canonicalPath: candidate.path,
      bodyString: payloadString,
      signed,
    });
    canonicalPathMode = candidate.mode;
    if (result.ok || result.reasonCode !== "signature_mismatch") break;
  }
  await recordSigningAudit(request, result, {
    transport: "websocket",
    canonicalPathMode,
  });

  return {
    ...result,
    payload: parsed.payload,
    rawMessage: payloadString,
  };
}

module.exports = {
  SIGNATURE_VERSION,
  DEVICE_SIGNATURE_VERSION,
  CLIENT_REVOKED_ERROR,
  CLIENT_IDENTITY_REAUTH_RECOVERY,
  INVALID_SIGNATURE_ERROR,
  SIGNING_SECRET_ROTATED_ERROR,
  DEVICE_SIGNATURE_PREFIX,
  SIGNING_HEADERS,
  canonicalSigningString,
  canonicalPublicKey,
  deviceSignatureRequired,
  ensureClientSigningSecret,
  signingErrorCode,
  hmacBase64Url,
  isHighRiskSignedRequest,
  isDeviceSignatureVersion,
  identityCapabilityDescriptor,
  normalizeDeviceKeyAlgorithm,
  registerClientHybridKEMKey,
  requireSignedHighRiskRequest,
  requireIdentityOwnedSignedHighRiskRequest,
  rotateAllSigningSecrets,
  rotateSigningSecret,
  sha256Base64Url,
  signingWarnOnly,
  appendSigningAuditAsOwner,
  verifySignedDescriptorAsOwner,
  verifyDeviceSignature,
  verifySignedRequest,
  verifySignedWebSocketMessage,
  _hybridInternals: {
    iosDeviceAttestationRequired,
    iosHybridRequired,
    isDeviceAttestationBootstrapPath,
    nativeAppleMobileContext,
  },
};
