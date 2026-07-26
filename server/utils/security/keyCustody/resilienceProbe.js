const crypto = require("crypto");

const PROBE_SALT = Buffer.from("athena-pq-resilience-kem-v1");
const PROBE_INFO = Buffer.from("vault-envelope");
const DEFAULT_CONTEXT = Buffer.from("vault-device:resilience:epoch:1");

function probeBuffer(value, name, minimum = 1) {
  const result = Buffer.from(value || []);
  if (result.length < minimum) {
    const error = new Error(`pq_resilience_${name}_invalid`);
    error.code = "PQ_RESILIENCE_PROBE_INPUT_INVALID";
    throw error;
  }
  return result;
}

function deriveResilienceProbeKey(sharedKey) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      probeBuffer(sharedKey, "shared_key", 16),
      PROBE_SALT,
      PROBE_INFO,
      32
    )
  );
}

function sealResilienceProbe(
  key,
  {
    plaintext = Buffer.from("athena-pq-resilience-secret"),
    context = DEFAULT_CONTEXT,
  } = {}
) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    probeBuffer(key, "aead_key", 32),
    iv
  );
  const additionalData = probeBuffer(context, "aead_context");
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([
    cipher.update(probeBuffer(plaintext, "plaintext")),
    cipher.final(),
  ]);
  return {
    iv,
    ciphertext,
    tag: cipher.getAuthTag(),
    context: additionalData,
  };
}

function openResilienceProbe(key, envelope, context = envelope?.context) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    probeBuffer(key, "aead_key", 32),
    probeBuffer(envelope?.iv, "aead_iv", 12)
  );
  decipher.setAAD(probeBuffer(context, "aead_context"));
  decipher.setAuthTag(probeBuffer(envelope?.tag, "aead_tag", 16));
  return Buffer.concat([
    decipher.update(probeBuffer(envelope?.ciphertext, "ciphertext")),
    decipher.final(),
  ]);
}

module.exports = {
  deriveResilienceProbeKey,
  openResilienceProbe,
  sealResilienceProbe,
};
