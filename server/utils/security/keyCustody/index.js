const { createKeyProvider, SERVER_DATA_PURPOSE } = require("./providers");
const crypto = require("crypto");

let provider = null;
let runtimeActiveKey = null;

function keyProvider() {
  if (!provider) provider = createKeyProvider();
  return provider;
}

function resetKeyProviderForTests(next = null) {
  provider = next;
  runtimeActiveKey = null;
}

function resolveActiveKey(purpose = SERVER_DATA_PURPOSE) {
  if (purpose !== SERVER_DATA_PURPOSE) {
    throw new Error(`Unsupported key purpose: ${purpose}`);
  }
  return runtimeActiveKey || keyProvider().resolveActiveKey(purpose);
}

function resolveKey(keyId, purpose = SERVER_DATA_PURPOSE) {
  if (purpose !== SERVER_DATA_PURPOSE) {
    throw new Error(`Unsupported key purpose: ${purpose}`);
  }
  if (runtimeActiveKey?.keyId === keyId) return runtimeActiveKey;
  return keyProvider().resolveKey(keyId, purpose);
}

function setRuntimeActiveKey(descriptor = null) {
  if (
    descriptor &&
    descriptor.purpose &&
    descriptor.purpose !== SERVER_DATA_PURPOSE
  ) {
    throw new Error(`Unsupported key purpose: ${descriptor.purpose}`);
  }
  runtimeActiveKey = descriptor || null;
  return runtimeActiveKey;
}

function clearRuntimeActiveKey() {
  runtimeActiveKey = null;
}

function generatePendingKey(purpose = SERVER_DATA_PURPOSE) {
  const activeProvider = keyProvider();
  if (typeof activeProvider.generatePendingKey !== "function") {
    const error = new Error("key_provider_read_only");
    error.code = "KEY_PROVIDER_READ_ONLY";
    throw error;
  }
  return activeProvider.generatePendingKey(purpose);
}

function keyState(keyId, purpose = SERVER_DATA_PURPOSE) {
  if (purpose !== SERVER_DATA_PURPOSE) {
    throw new Error(`Unsupported key purpose: ${purpose}`);
  }
  const activeProvider = keyProvider();
  if (typeof activeProvider.keyState === "function") {
    return activeProvider.keyState(keyId, purpose);
  }
  const descriptor = resolveKey(keyId, purpose);
  return descriptor
    ? {
        keyId: descriptor.keyId,
        status: descriptor.status,
        materialPresent: Boolean(descriptor.material),
      }
    : null;
}

function activateKey(keyId, purpose = SERVER_DATA_PURPOSE) {
  const activeProvider = keyProvider();
  if (typeof activeProvider.activateKey !== "function") {
    const error = new Error("key_provider_read_only");
    error.code = "KEY_PROVIDER_READ_ONLY";
    throw error;
  }
  const activated = activeProvider.activateKey(keyId, purpose);
  // Rotation changes both the durable provider selection and the runtime write
  // authority. Keeping an older registry-derived override here would make this
  // process continue encrypting new values with the previous key until restart.
  setRuntimeActiveKey(activated);
  return activated;
}

function retireKey(
  keyId,
  purpose = SERVER_DATA_PURPOSE,
  retirementProof = null,
  closureProof = null
) {
  const {
    assertPlatformKeyRetirementProof,
  } = require("../userDomainRetirementGuard");
  const { assertKeyClosureRetirementProof } = require("../keyClosure");
  assertPlatformKeyRetirementProof(retirementProof, keyId);
  assertKeyClosureRetirementProof(closureProof, keyId);
  const activeProvider = keyProvider();
  if (typeof activeProvider.retireKey !== "function") {
    const error = new Error("key_provider_read_only");
    error.code = "KEY_PROVIDER_READ_ONLY";
    throw error;
  }
  return activeProvider.retireKey(keyId, purpose);
}

function health() {
  return keyProvider().health();
}

function verifyKeyCustodyRoundTrip(keyId = null) {
  const descriptor = keyId ? resolveKey(keyId) : resolveActiveKey();
  if (!descriptor?.material) throw new Error("key_custody_key_unavailable");
  const recovered = resolveKey(descriptor.keyId);
  if (!recovered?.material?.equals(descriptor.material)) {
    throw new Error("key_custody_recovery_lookup_failed");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", recovered.material, iv);
  const ciphertext = Buffer.concat([
    cipher.update("athena-key-custody-probe"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    recovered.material,
    iv
  );
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  if (plaintext.toString("utf8") !== "athena-key-custody-probe") {
    throw new Error("key_custody_round_trip_failed");
  }
  return {
    keyId: descriptor.keyId,
    status: descriptor.status || null,
    providerType: descriptor.providerType,
    roundTrip: true,
  };
}

module.exports = {
  activateKey,
  clearRuntimeActiveKey,
  generatePendingKey,
  health,
  keyProvider,
  keyState,
  resetKeyProviderForTests,
  resolveActiveKey,
  resolveKey,
  retireKey,
  setRuntimeActiveKey,
  verifyKeyCustodyRoundTrip,
};
