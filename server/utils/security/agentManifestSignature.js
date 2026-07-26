const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonicalJson } = require("../syncV2/canonicalJson");
const {
  PURPOSES,
  SUITE_IDS,
  cryptoSuite,
  signWithCryptoSuite,
  supportsNodeSignatureSuite,
  verifyWithCryptoSuite,
} = require("./cryptoSuiteRegistry");

const AGENT_MANIFEST_SIGNATURE_FORMAT = "athena-agent-manifest-signature:v1";
const SUITE = cryptoSuite(SUITE_IDS.AGENT_REGISTRY_MLDSA65_V1, {
  purpose: PURPOSES.AGENT_REGISTRY,
});

function payload(value) {
  return Buffer.from(
    canonicalJson(value, { excludedKeys: new Set(), excludeSensitive: false })
  );
}

function keyFiles(env = process.env) {
  return {
    keyId: String(
      env.ATHENA_AGENT_MLDSA65_KEY_ID || "agent-registry-mldsa65-primary"
    ),
    privateKeyFile: String(
      env.ATHENA_AGENT_MLDSA65_PRIVATE_KEY_FILE || ""
    ).trim(),
    publicKeyFile: String(
      env.ATHENA_AGENT_MLDSA65_PUBLIC_KEY_FILE || ""
    ).trim(),
  };
}

function loadKeys({ env = process.env, privateKeyRequired = false } = {}) {
  if (!SUITE || !supportsNodeSignatureSuite(SUITE))
    throw new Error("agent_mldsa65_runtime_unavailable");
  const settings = keyFiles(env);
  if (
    !settings.publicKeyFile ||
    (privateKeyRequired && !settings.privateKeyFile)
  )
    throw new Error("agent_mldsa65_key_files_missing");
  let privateKey = null;
  if (privateKeyRequired) {
    const stat = fs.statSync(path.resolve(settings.privateKeyFile));
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("agent_mldsa65_private_key_permissions_unsafe");
    privateKey = fs.readFileSync(path.resolve(settings.privateKeyFile), "utf8");
  }
  const publicKey = fs.readFileSync(
    path.resolve(settings.publicKeyFile),
    "utf8"
  );
  return { ...settings, privateKey, publicKey };
}

function signAgentManifest(
  value,
  { env = process.env, now = new Date() } = {}
) {
  const keys = loadKeys({ env, privateKeyRequired: true });
  const publicKey = crypto.createPublicKey(keys.publicKey);
  return {
    format: AGENT_MANIFEST_SIGNATURE_FORMAT,
    suiteId: SUITE.suiteId,
    keyId: keys.keyId,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    payloadSha256: crypto
      .createHash("sha256")
      .update(payload(value))
      .digest("hex"),
    signature: signWithCryptoSuite({
      suite: SUITE,
      data: payload(value),
      privateKey: keys.privateKey,
    }).toString("base64"),
    signedAt: now.toISOString(),
  };
}

function verifyAgentManifest(value, envelope, { env = process.env } = {}) {
  try {
    if (
      envelope?.format !== AGENT_MANIFEST_SIGNATURE_FORMAT ||
      envelope?.suiteId !== SUITE.suiteId
    )
      return {
        valid: false,
        reason: "agent_manifest_signature_format_invalid",
      };
    const keys = loadKeys({ env, privateKeyRequired: false });
    if (envelope.keyId !== keys.keyId)
      return { valid: false, reason: "agent_manifest_key_untrusted" };
    const trusted = crypto.createPublicKey(keys.publicKey);
    const trustedDer = trusted
      .export({ format: "der", type: "spki" })
      .toString("base64");
    if (envelope.publicKey !== trustedDer)
      return { valid: false, reason: "agent_manifest_key_untrusted" };
    const body = payload(value);
    if (
      envelope.payloadSha256 !==
      crypto.createHash("sha256").update(body).digest("hex")
    )
      return { valid: false, reason: "agent_manifest_payload_hash_mismatch" };
    const valid = verifyWithCryptoSuite({
      suite: SUITE,
      data: body,
      publicKey: trusted,
      signature: envelope.signature,
    });
    return { valid, reason: valid ? null : "agent_manifest_signature_invalid" };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

function agentSignatureRequired(env = process.env) {
  if (env.ATHENA_EXTERNAL_AGENT_MLDSA_REQUIRED === "false") return false;
  if (env.ATHENA_EXTERNAL_AGENT_MLDSA_REQUIRED === "true") return true;
  return env.NODE_ENV === "production";
}

module.exports = {
  AGENT_MANIFEST_SIGNATURE_FORMAT,
  agentSignatureRequired,
  signAgentManifest,
  verifyAgentManifest,
};
