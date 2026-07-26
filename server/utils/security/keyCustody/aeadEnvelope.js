const crypto = require("crypto");

const DEFAULT_ALGORITHM = "aes-256-gcm";

function assertKey(key) {
  const material = Buffer.from(key);
  if (material.length !== 32) {
    throw new Error("key_custody_aead_key_invalid");
  }
  return material;
}

function sealJsonEnvelope({
  key,
  aad,
  payload,
  version,
  algorithm = DEFAULT_ALGORITHM,
}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, assertKey(key), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    version,
    algorithm,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function openJsonEnvelope({
  key,
  aad,
  envelope,
  version,
  algorithm = DEFAULT_ALGORITHM,
}) {
  if (envelope?.version !== version || envelope?.algorithm !== algorithm) {
    throw new Error("key_custody_aead_envelope_invalid");
  }
  const decipher = crypto.createDecipheriv(
    algorithm,
    assertKey(key),
    Buffer.from(envelope.iv, "base64url")
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  );
}

module.exports = {
  openJsonEnvelope,
  sealJsonEnvelope,
};
