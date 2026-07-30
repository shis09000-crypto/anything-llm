import { getJson, postJson, putJson } from "@/lib/communication/apiClient";
import { getClientIdentity } from "@/lib/communication/clientIdentity";
import {
  VAULT_GRANT_HEADER,
  requestVaultAccessGrantWithReauthToken,
  requestVaultAccessGrantWithPassword,
} from "@/lib/communication/vaultClient";
import { getStoredAuthUser } from "@/utils/authUserStorage";
import {
  browserHybridEncoding,
  decapsulateForBrowser,
  encapsulateForBrowser,
  ensureBrowserHybridKeys,
  loadBrowserRoot,
  signBrowserRootPayload,
  storeBrowserRoot,
  VAULT_HYBRID_SUITE,
} from "./browserHybridKeys";

const ROOT_VERSION = "athena-user-root-key-envelope:v2";
const ROOT_MATERIAL_VERSION = "athena-user-root-key-material:v1";
const ROOT_DERIVATION_SUITE = "user-root-hkdf-sha256-v1";
const WRAP_VERSION = "athena-user-domain-key-wrap:v1";
const encoder = new TextEncoder();
const { base64Url, fromBase64Url } = browserHybridEncoding;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

async function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function hkdf({ material, salt, info }) {
  const key = await crypto.subtle.importKey("raw", material, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: typeof salt === "string" ? encoder.encode(salt) : salt,
      info: typeof info === "string" ? encoder.encode(info) : info,
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function standardBase64(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    ""
  );
  return btoa(binary);
}

function currentAuthUserId() {
  const user = getStoredAuthUser();
  const value = Number(user?.authUserId);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("shared_identity_unavailable");
  }
  return value;
}

async function requestRootVaultGrant(reauth = {}) {
  const normalized =
    typeof reauth === "string" ? { currentPassword: reauth } : reauth || {};
  const grant = normalized.reauthToken
    ? await requestVaultAccessGrantWithReauthToken({
        reauthToken: normalized.reauthToken,
      })
    : await requestVaultAccessGrantWithPassword({
        currentPassword: normalized.currentPassword,
      });
  if (!grant?.success || !grant?.vaultGrant) {
    throw new Error(grant?.error || "vault_reauth_failed");
  }
  return grant;
}

export async function browserUserRootStatus() {
  const registration = await ensureBrowserHybridKeys();
  await registerBrowserHybridDevice(registration);
  const { data } = await getJson("/vault/user-root-key", {
    signing: "required",
  });
  return data;
}

async function registerBrowserHybridDevice(registration) {
  const { data } = await postJson(
    "/client-identity/vault-kem-key",
    {
      suiteId: registration.kemSuiteId,
      keyGeneration: registration.keyGeneration,
      kemPublicKey: registration.kemPublicKey,
      p256PublicKey: registration.p256PublicKey,
      mlDSA65PublicKey: registration.mlDSA65PublicKey,
    },
    { signing: "required" }
  );
  if (!data?.success)
    throw new Error(data?.error || "hybrid_device_registration_failed");
  return data;
}

export async function initializeBrowserUserRoot(reauth) {
  const authUserId = currentAuthUserId();
  const registration = await ensureBrowserHybridKeys();
  await registerBrowserHybridDevice(registration);
  const status = await browserUserRootStatus();
  if (status?.initialized) {
    return {
      initialized: true,
      existing: true,
      rootEpoch: status.rootEpoch,
      rootKeyId: status.rootKeyId,
      localReady: Boolean(await loadBrowserRoot(authUserId, status.rootEpoch)),
    };
  }
  const grant = await requestRootVaultGrant(reauth);
  const { clientId } = getClientIdentity();
  const { data: challenge } = await postJson(
    "/vault/user-root-key/challenge",
    { purpose: "initialize", targetClientId: clientId },
    { signing: "required" }
  );
  const challengeData = challenge?.challengeData || challenge?.challenge;
  if (!challenge?.success || !challengeData) {
    throw new Error(challenge?.error || "user_root_challenge_failed");
  }
  const root = crypto.getRandomValues(new Uint8Array(32));
  const rootEpoch = Number(challenge.rootEpoch || 1);
  const rootKeyId = base64Url(await sha256(root));
  const material = {
    authUserId,
    derivationSuiteId: ROOT_DERIVATION_SUITE,
    rootEpoch,
    rootKeyId,
    userRootKey: standardBase64(root),
    version: ROOT_MATERIAL_VERSION,
  };
  const kem = await encapsulateForBrowser(registration.kemPublicKey);
  const challengeHash = base64Url(await sha256(fromBase64Url(challengeData)));
  const binding = [
    ROOT_VERSION,
    ROOT_DERIVATION_SUITE,
    VAULT_HYBRID_SUITE,
    String(authUserId),
    clientId,
    clientId,
    String(rootEpoch),
    rootKeyId,
    challenge.challengeId,
    challengeHash,
  ].join("\u0000");
  const wrappingKey = await hkdf({
    material: kem.sharedSecret,
    salt: "athena-user-root-envelope-kem:v1",
    info: `athena-user-root-envelope-info:v1\u0000${binding}`,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `athena-user-root-envelope-aad:v1\u0000${binding}`
        ),
      },
      wrappingKey,
      encoder.encode(canonicalJson(material))
    )
  );
  const createdAt = new Date().toISOString();
  const unsigned = {
    authUserId,
    challenge: challengeData,
    challengeId: challenge.challengeId,
    challengeSHA256: challengeHash,
    createdAt,
    derivationSuiteId: ROOT_DERIVATION_SUITE,
    encapsulatedKey: kem.encapsulatedKey,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    materialType: "user-root-key",
    mlDSA65PublicKey: registration.mlDSA65PublicKey,
    p256PublicKey: registration.p256PublicKey,
    rootEpoch,
    rootKeyId,
    sealedRootKey: base64Url(new Uint8Array([...iv, ...ciphertext])),
    sourceClientId: clientId,
    sourceKeyGeneration: registration.keyGeneration,
    targetClientId: clientId,
    targetKEMPublicKey: registration.kemPublicKey,
    targetKeyGeneration: registration.keyGeneration,
    transportSuiteId: VAULT_HYBRID_SUITE,
    version: ROOT_VERSION,
  };
  const signatures = await signBrowserRootPayload(canonicalJson(unsigned));
  const envelope = { ...unsigned, ...signatures };
  const { data: result } = await postJson(
    "/vault/user-root-key/initialize",
    { rootEpoch, challengeId: challenge.challengeId, envelope },
    {
      signing: "required",
      headers: { [VAULT_GRANT_HEADER]: grant.vaultGrant },
    }
  );
  if (!result?.success || result.rootKeyId !== rootKeyId) {
    throw new Error(result?.error || "user_root_initialize_failed");
  }
  await storeBrowserRoot(authUserId, rootEpoch, material);
  root.fill(0);
  return {
    initialized: true,
    existing: false,
    rootEpoch,
    rootKeyId,
    localReady: true,
  };
}

async function openTransportEnvelope(envelope) {
  const sharedSecret = await decapsulateForBrowser(envelope.encapsulatedKey);
  const binding = {
    authUserId: envelope.authUserId,
    domain: envelope.domain,
    domainKeyVersion: envelope.domainKeyVersion,
    resourceId: envelope.resourceId,
    resourceType: envelope.resourceType,
    rootEpoch: envelope.rootEpoch,
    rootKeyId: envelope.rootKeyId,
    targetClientId: envelope.targetClientId,
    targetKEMPublicKey: envelope.targetKEMPublicKey,
    targetKeyGeneration: envelope.targetKeyGeneration,
  };
  const info = await sha256(
    `athena-user-domain-material-info:v1\u0000${canonicalJson(binding)}`
  );
  const wrappingKey = await hkdf({
    material: sharedSecret,
    salt: "athena-user-domain-material-kem:v1",
    info,
  });
  const combined = fromBase64Url(envelope.sealedKeyMaterial);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: combined.slice(0, 12),
        additionalData: encoder.encode(
          `athena-user-domain-material-aad:v1\u0000${canonicalJson(binding)}`
        ),
      },
      wrappingKey,
      combined.slice(12)
    )
  );
}

async function wrapDomainMaterial(material, root, record) {
  const rootBytes = Uint8Array.from(atob(root.userRootKey), (character) =>
    character.charCodeAt(0)
  );
  const salt = await sha256(
    `athena-user-root-salt:v1\u0000${root.authUserId}\u0000${root.rootEpoch}`
  );
  const domainKey = await hkdf({
    material: rootBytes,
    salt,
    info: `athena-user-root-domain:v1\u0000${ROOT_DERIVATION_SUITE}\u0000${record.domain}`,
  });
  const binding = {
    algorithm: "aes-256-gcm",
    authUserId: root.authUserId,
    domain: record.domain,
    domainKeyVersion: record.domainKeyVersion,
    resourceId: record.resourceId,
    resourceType: record.resourceType,
    rootEpoch: root.rootEpoch,
    rootKeyId: root.rootKeyId,
    version: WRAP_VERSION,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(canonicalJson(binding)),
      },
      domainKey,
      material
    )
  );
  return {
    ...binding,
    iv: base64Url(iv),
    ciphertext: base64Url(combined.slice(0, -16)),
    authTag: base64Url(combined.slice(-16)),
    keyCommitment: base64Url(await sha256(material)),
  };
}

export async function migrateBrowserUserDomainWraps(reauth) {
  const authUserId = currentAuthUserId();
  const status = await browserUserRootStatus();
  if (!status?.initialized) throw new Error("user_root_not_initialized");
  const root = await loadBrowserRoot(authUserId, status.rootEpoch);
  if (!root || root.rootKeyId !== status.rootKeyId) {
    throw new Error("browser_root_material_unavailable");
  }
  const grant = await requestRootVaultGrant(reauth);
  const { data } = await getJson(
    "/vault/user-domain-wraps?status=pending&limit=200&includeEnvelope=false",
    { signing: "required" }
  );
  const pending = data?.wraps || [];
  let completed = 0;
  let failed = 0;
  for (const record of pending) {
    try {
      const { data: prepared } = await postJson(
        `/vault/user-domain-wraps/${encodeURIComponent(record.id)}/prepare`,
        {},
        {
          signing: "required",
          headers: { [VAULT_GRANT_HEADER]: grant.vaultGrant },
        }
      );
      const material = await openTransportEnvelope(prepared.envelope);
      const envelope = await wrapDomainMaterial(material, root, record);
      const { data: result } = await putJson(
        `/vault/user-domain-wraps/${encodeURIComponent(record.id)}`,
        { envelope },
        { signing: "required" }
      );
      if (!result?.success) throw new Error(result?.error || "wrap_failed");
      material.fill(0);
      completed += 1;
    } catch {
      failed += 1;
    }
  }
  return { discovered: pending.length, completed, failed };
}
