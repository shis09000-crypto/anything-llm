const crypto = require("crypto");
const fs = require("fs");
const { stableJson } = require("./contracts");

let developmentKeyPair = null;

function decodePem(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .trim();
}

function signingKeys(env = process.env) {
  const readKey = (value, file) => {
    if (value) return decodePem(value);
    if (!file) return "";
    return decodePem(fs.readFileSync(String(file), "utf8"));
  };
  const privateKey = readKey(
    env.ATHENA_LOCAL_RUNTIME_SIGNING_PRIVATE_KEY,
    env.ATHENA_LOCAL_RUNTIME_SIGNING_PRIVATE_KEY_FILE
  );
  const publicKey = readKey(
    env.ATHENA_LOCAL_RUNTIME_SIGNING_PUBLIC_KEY,
    env.ATHENA_LOCAL_RUNTIME_SIGNING_PUBLIC_KEY_FILE
  );
  if (privateKey && publicKey)
    return { privateKey, publicKey, ephemeral: false };
  if (env.NODE_ENV === "production") {
    throw Object.assign(new Error("local_runtime_signing_key_missing"), {
      code: "local_runtime_signing_key_missing",
      httpStatus: 503,
    });
  }
  if (!developmentKeyPair)
    developmentKeyPair = crypto.generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
  return { ...developmentKeyPair, ephemeral: true };
}

function issueCapabilityAssertion(payload, { env = process.env } = {}) {
  const keys = signingKeys(env);
  const assertion = {
    version: "athena.local-runtime.capability.v1",
    issuer: "athena-local-runtime-center",
    issuedAt: new Date().toISOString(),
    ...payload,
  };
  return {
    algorithm: "Ed25519",
    keyId: String(
      env.ATHENA_LOCAL_RUNTIME_SIGNING_KEY_ID || "local-runtime-v1"
    ),
    payload: assertion,
    signature: crypto
      .sign(null, Buffer.from(stableJson(assertion)), keys.privateKey)
      .toString("base64url"),
  };
}

function verifyCapabilityAssertion(assertion, publicKey) {
  if (!assertion?.payload || !assertion?.signature) return false;
  return crypto.verify(
    null,
    Buffer.from(stableJson(assertion.payload)),
    decodePem(publicKey),
    Buffer.from(assertion.signature, "base64url")
  );
}

module.exports = {
  issueCapabilityAssertion,
  signingKeys,
  verifyCapabilityAssertion,
};
