const crypto = require("crypto");
const { Agent } = require("undici");
const {
  ClientIdentityRepository,
} = require("../../repositories/clientIdentityRepository");
const {
  clientSecuritySyncReady,
  recordClientNodeChange,
} = require("../clientIdentity");
const { canonicalJson } = require("../syncV2/canonicalJson");
const { loadServiceIdentity } = require("./serviceIdentity");

const PROVIDER = "apple-app-attest";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTESTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTESTATION_OBJECT_BYTES = 64 * 1024;

function environment(env = process.env) {
  return String(env.APP_ENV || env.NODE_ENV || "development")
    .trim()
    .toLowerCase();
}

function deviceAttestationMode(env = process.env) {
  const mode = String(env.ATHENA_DEVICE_ATTESTATION_MODE || "off")
    .trim()
    .toLowerCase();
  return new Set(["off", "observe", "required"]).has(mode) ? mode : "off";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function boundedString(value, maxLength) {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function validBase64Url(value, maxBytes) {
  const normalized = boundedString(value, Math.ceil((maxBytes * 4) / 3) + 8);
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) return null;
  try {
    const decoded = Buffer.from(normalized, "base64url");
    if (
      decoded.length === 0 ||
      decoded.length > maxBytes ||
      decoded.toString("base64url") !== normalized
    )
      return null;
    return normalized;
  } catch {
    return null;
  }
}

function deviceKeyBindingHash(client = {}) {
  return sha256(
    canonicalJson(
      {
        clientId: client.clientId || null,
        publicKey: client.publicKey || null,
        publicKeyAlgorithm: client.publicKeyAlgorithm || null,
        pqPublicKey: client.pqPublicKey || null,
        pqKeyAlgorithm: client.pqKeyAlgorithm || null,
        hybridKemPublicKey: client.hybridKemPublicKey || null,
        hybridKemSuiteId: client.hybridKemSuiteId || null,
        vaultSigningP256PublicKey: client.vaultSigningP256PublicKey || null,
        vaultSigningMLDSA65PublicKey:
          client.vaultSigningMLDSA65PublicKey || null,
        vaultSigningSuiteId: client.vaultSigningSuiteId || null,
      },
      { excludedKeys: new Set(), excludeSensitive: false }
    )
  );
}

function hasAttestableDeviceKeys(client = {}) {
  return Boolean(
    client.publicKey &&
      client.pqPublicKey &&
      client.hybridKemPublicKey &&
      client.vaultSigningP256PublicKey &&
      client.vaultSigningMLDSA65PublicKey
  );
}

function validDeviceAttestation(client = null, env = process.env) {
  if (!client || client.attestationStatus !== "verified") return false;
  if (client.attestationProvider !== PROVIDER) return false;
  if (client.attestationEnvironment !== environment(env)) return false;
  const expiresAt =
    client.attestationExpiresAt instanceof Date
      ? client.attestationExpiresAt.getTime()
      : Date.parse(client.attestationExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function issueDeviceAttestationChallenge({ userId, clientId } = {}) {
  const db = ClientIdentityRepository.db;
  const client = await db.athena_clients.findFirst({
    where: {
      userId: Number(userId),
      clientId: String(clientId),
      revokedAt: null,
    },
  });
  if (!client) throw new Error("client_not_found");
  if (!hasAttestableDeviceKeys(client))
    throw new Error("device_attestation_key_binding_incomplete");
  const challengeId = `att_${crypto.randomUUID()}`;
  const challenge = crypto.randomBytes(32).toString("base64url");
  const keyBindingHash = deviceKeyBindingHash(client);
  const clientDataHash = sha256(
    canonicalJson(
      { challengeId, challenge, keyBindingHash },
      { excludedKeys: new Set(), excludeSensitive: false }
    )
  );
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db.$transaction(async (tx) => {
    await tx.athena_device_attestation_challenges.deleteMany({
      where: {
        userId: Number(userId),
        clientId: String(clientId),
      },
    });
    await tx.athena_device_attestation_challenges.create({
      data: {
        id: challengeId,
        userId: Number(userId),
        clientId: String(clientId),
        provider: PROVIDER,
        clientDataHash,
        keyBindingHash,
        expiresAt,
      },
    });
  });
  return {
    provider: PROVIDER,
    verificationType: client.attestationKeyIdHash ? "assertion" : "attestation",
    challengeId,
    challenge,
    clientDataHash,
    keyBindingHash,
    expiresAt: expiresAt.toISOString(),
  };
}

function brokerAgent(env = process.env) {
  const identity = loadServiceIdentity("api", { env, required: true });
  return new Agent({
    connect: {
      ca: identity.ca,
      cert: identity.cert,
      key: identity.key,
      servername: identity.serverName,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
}

async function verifyWithAttestationBroker(
  payload,
  { env = process.env, fetchImpl = fetch } = {}
) {
  const endpoint = String(env.ATHENA_APP_ATTEST_VERIFIER_URL || "").trim();
  if (!endpoint) throw new Error("device_attestation_verifier_unconfigured");
  const url = new URL(endpoint);
  const production = environment(env) === "production";
  if (url.username || url.password)
    throw new Error("device_attestation_verifier_credentials_forbidden");
  if (production && url.protocol !== "https:")
    throw new Error("device_attestation_verifier_tls_required");
  const dispatcher = url.protocol === "https:" ? brokerAgent(env) : null;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const contentLength = Number(
      response.headers?.get?.("content-length") || 0
    );
    if (contentLength > 32 * 1024)
      throw new Error("device_attestation_verifier_response_too_large");
    const text = await response.text();
    if (Buffer.byteLength(text) > 32 * 1024)
      throw new Error("device_attestation_verifier_response_too_large");
    if (!response.ok) throw new Error("device_attestation_verifier_rejected");
    const result = JSON.parse(text);
    if (result?.verified !== true)
      throw new Error("device_attestation_invalid");
    return result;
  } finally {
    await dispatcher?.close();
  }
}

async function completeDeviceAttestation(
  {
    userId,
    clientId,
    challengeId,
    keyId,
    attestationObject,
    assertionObject,
    appId,
  } = {},
  options = {}
) {
  const db = ClientIdentityRepository.db;
  const normalizedKeyId = boundedString(keyId, 1024);
  const normalizedAppId = boundedString(appId, 512);
  const normalizedObject = validBase64Url(
    attestationObject || assertionObject,
    MAX_ATTESTATION_OBJECT_BYTES
  );
  const verificationType = attestationObject
    ? "attestation"
    : assertionObject
      ? "assertion"
      : null;
  if (
    !normalizedKeyId ||
    !normalizedObject ||
    !normalizedAppId ||
    !verificationType ||
    Boolean(attestationObject) === Boolean(assertionObject)
  )
    throw new Error("device_attestation_payload_invalid");
  const expectedAppId = String(
    options.env?.ATHENA_APP_ATTEST_APP_ID || ""
  ).trim();
  if (
    (environment(options.env) === "production" ||
      deviceAttestationMode(options.env) === "required") &&
    !expectedAppId
  )
    throw new Error("device_attestation_app_id_unconfigured");
  if (expectedAppId && normalizedAppId !== expectedAppId)
    throw new Error("device_attestation_app_id_mismatch");
  const [challenge, client] = await Promise.all([
    db.athena_device_attestation_challenges.findUnique({
      where: { id: String(challengeId) },
    }),
    db.athena_clients.findFirst({
      where: {
        userId: Number(userId),
        clientId: String(clientId),
        revokedAt: null,
      },
    }),
  ]);
  if (
    !challenge ||
    challenge.userId !== Number(userId) ||
    challenge.clientId !== String(clientId)
  )
    throw new Error("device_attestation_challenge_invalid");
  if (!client || deviceKeyBindingHash(client) !== challenge.keyBindingHash)
    throw new Error("device_attestation_key_binding_changed");
  const attestationKeyIdHash = sha256(normalizedKeyId);
  if (challenge.status === "consumed") {
    if (
      client.attestationKeyIdHash === attestationKeyIdHash &&
      validDeviceAttestation(client, options.env)
    ) {
      return {
        provider: PROVIDER,
        status: "verified",
        attestedAt: new Date(client.attestedAt).toISOString(),
        expiresAt: new Date(client.attestationExpiresAt).toISOString(),
        assertionCounter: Math.max(0, Number(client.attestationCounter) || 0),
        idempotentReplay: true,
      };
    }
    throw new Error("device_attestation_challenge_replayed");
  }
  if (
    challenge.status !== "pending" ||
    Date.parse(challenge.expiresAt) <= Date.now()
  )
    throw new Error("device_attestation_challenge_invalid");
  if (
    client.attestationKeyIdHash &&
    client.attestationKeyIdHash !== attestationKeyIdHash
  )
    throw new Error("device_attestation_key_rotation_required");
  if (
    (client.attestationKeyIdHash && verificationType !== "assertion") ||
    (!client.attestationKeyIdHash && verificationType !== "attestation")
  )
    throw new Error("device_attestation_verification_type_mismatch");
  const result = await verifyWithAttestationBroker(
    {
      provider: PROVIDER,
      challengeId: challenge.id,
      clientId: client.clientId,
      clientDataHash: challenge.clientDataHash,
      keyBindingHash: challenge.keyBindingHash,
      keyId: normalizedKeyId,
      verificationType,
      ...(verificationType === "attestation"
        ? { attestationObject: normalizedObject }
        : { assertionObject: normalizedObject }),
      appId: normalizedAppId,
      environment: environment(options.env),
    },
    options
  );
  if (
    result.keyId !== normalizedKeyId ||
    result.appId !== normalizedAppId ||
    result.environment !== environment(options.env) ||
    result.clientDataHash !== challenge.clientDataHash ||
    result.keyBindingHash !== challenge.keyBindingHash
  )
    throw new Error("device_attestation_verifier_binding_mismatch");
  const now = new Date();
  const brokerExpiry = Date.parse(result.expiresAt);
  const expiresAt = new Date(
    Math.min(
      Number.isFinite(brokerExpiry)
        ? brokerExpiry
        : now.getTime() + MAX_ATTESTATION_TTL_MS,
      now.getTime() + MAX_ATTESTATION_TTL_MS
    )
  );
  if (expiresAt.getTime() <= now.getTime())
    throw new Error("device_attestation_expired");
  const counter = Math.min(
    2_147_483_647,
    Math.max(0, Math.trunc(Number(result.assertionCounter) || 0))
  );
  if (
    verificationType === "assertion" &&
    counter <= Math.max(0, Number(client.attestationCounter) || 0)
  )
    throw new Error("device_attestation_counter_not_advanced");
  const syncReady = await clientSecuritySyncReady({
    userId,
    maintainShadow: true,
  });
  const apply = async (tx) => {
    const consumed = await tx.athena_device_attestation_challenges.updateMany({
      where: {
        id: challenge.id,
        status: "pending",
        expiresAt: { gt: now },
      },
      data: { status: "consumed", consumedAt: now },
    });
    if (consumed.count !== 1)
      throw new Error("device_attestation_challenge_replayed");
    const updated = await tx.athena_clients.updateMany({
      where: {
        id: client.id,
        revokedAt: null,
        publicKey: client.publicKey,
        pqPublicKey: client.pqPublicKey,
        hybridKemPublicKey: client.hybridKemPublicKey,
      },
      data: {
        attestationProvider: PROVIDER,
        attestationKeyIdHash,
        attestationStatus: "verified",
        attestationEnvironment: environment(options.env),
        attestationCounter: counter,
        attestedAt: now,
        attestationExpiresAt: expiresAt,
      },
    });
    if (updated.count !== 1)
      throw new Error("device_attestation_key_binding_changed");
    if (syncReady) {
      await recordClientNodeChange(tx, {
        userId,
        eventType: "client.device_attestation_verified",
        changedPaths: [
          `clients.${String(clientId)}.attestationProvider`,
          `clients.${String(clientId)}.attestationStatus`,
          `clients.${String(clientId)}.attestedAt`,
          `clients.${String(clientId)}.attestationExpiresAt`,
        ],
        payloadHint: {
          operation: "device-attestation-verify",
          clientId: String(clientId),
          provider: PROVIDER,
        },
        originClientId: clientId,
      });
    }
    return {
      provider: PROVIDER,
      status: "verified",
      attestedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      assertionCounter: counter,
    };
  };
  return syncReady ? db.$transaction(apply) : apply(db);
}

module.exports = {
  CHALLENGE_TTL_MS,
  MAX_ATTESTATION_TTL_MS,
  MAX_ATTESTATION_OBJECT_BYTES,
  PROVIDER,
  completeDeviceAttestation,
  deviceAttestationMode,
  deviceKeyBindingHash,
  hasAttestableDeviceKeys,
  issueDeviceAttestationChallenge,
  validDeviceAttestation,
  verifyWithAttestationBroker,
};
