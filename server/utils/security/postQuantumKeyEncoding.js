const crypto = require("crypto");

const MLDSA65_PUBLIC_KEY_BYTES = 1952;
const MLDSA65_SPKI_PREFIX = Buffer.from(
  "308207b2300b0609608648016503040312038207a100",
  "hex"
);

function mlDSA65PublicKey(rawBase64Url) {
  const raw = Buffer.from(String(rawBase64Url || ""), "base64url");
  if (raw.length !== MLDSA65_PUBLIC_KEY_BYTES)
    throw new Error("invalid_mldsa65_public_key");
  return crypto.createPublicKey({
    key: Buffer.concat([MLDSA65_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

module.exports = {
  MLDSA65_PUBLIC_KEY_BYTES,
  MLDSA65_SPKI_PREFIX,
  mlDSA65PublicKey,
};
