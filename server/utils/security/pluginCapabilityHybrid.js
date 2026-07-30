const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  loadKeyDescriptor,
  signHybridEnvelope,
  verifyHybridEnvelope,
} = require("./hybridSignature");
const { PURPOSES, SUITE_IDS } = require("./cryptoSuiteRegistry");

const CAPABILITY_HYBRID_POLICY = Object.freeze({
  threshold: 2,
  classicalRequired: true,
  pqRequired: true,
});

function value(input, fallback = "") {
  return String(input || fallback).trim();
}

function keySettings(env = process.env) {
  return {
    ed25519: {
      suiteId: SUITE_IDS.PLUGIN_CAPABILITY_ED25519_V2,
      keyId: value(
        env.ATHENA_PLUGIN_CAPABILITY_ED25519_KEY_ID,
        "plugin-capability-ed25519-primary"
      ),
      privateKeyFile: value(
        env.ATHENA_PLUGIN_CAPABILITY_ED25519_PRIVATE_KEY_FILE
      ),
      publicKeyFile: value(
        env.ATHENA_PLUGIN_CAPABILITY_ED25519_PUBLIC_KEY_FILE
      ),
    },
    mlDSA65: {
      suiteId: SUITE_IDS.PLUGIN_CAPABILITY_MLDSA65_V2,
      keyId: value(
        env.ATHENA_PLUGIN_CAPABILITY_MLDSA65_KEY_ID,
        "plugin-capability-mldsa65-primary"
      ),
      privateKeyFile: value(
        env.ATHENA_PLUGIN_CAPABILITY_MLDSA65_PRIVATE_KEY_FILE
      ),
      publicKeyFile: value(
        env.ATHENA_PLUGIN_CAPABILITY_MLDSA65_PUBLIC_KEY_FILE
      ),
    },
  };
}

function loadCapabilitySigners({ env = process.env } = {}) {
  const settings = keySettings(env);
  return [settings.ed25519, settings.mlDSA65].map((entry) =>
    loadKeyDescriptor({
      ...entry,
      purpose: PURPOSES.PLUGIN_CAPABILITY,
      keyOrigin: "external-capability-signing-provider",
      hardwareProtection: value(
        env.ATHENA_PLUGIN_CAPABILITY_HARDWARE_PROTECTION,
        "provider-asserted"
      ),
    })
  );
}

function trustedKey(entry) {
  if (!entry.publicKeyFile) {
    const error = new Error("plugin_capability_public_key_missing");
    error.code = "PLUGIN_CAPABILITY_PUBLIC_KEY_MISSING";
    throw error;
  }
  const publicKey = crypto.createPublicKey(
    fs.readFileSync(path.resolve(entry.publicKeyFile), "utf8")
  );
  return {
    suiteId: entry.suiteId,
    keyId: entry.keyId,
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
}

function loadCapabilityTrustedKeys({ env = process.env } = {}) {
  const settings = keySettings(env);
  return [trustedKey(settings.ed25519), trustedKey(settings.mlDSA65)];
}

function signCapabilityEnvelope(
  data,
  { env = process.env, signers = null, now = new Date() } = {}
) {
  return signHybridEnvelope({
    data,
    signers: signers || loadCapabilitySigners({ env }),
    policy: CAPABILITY_HYBRID_POLICY,
    now,
  });
}

function verifyCapabilityEnvelope(
  data,
  envelope,
  { env = process.env, trustedKeys = null } = {}
) {
  return verifyHybridEnvelope({
    data,
    envelope,
    purpose: PURPOSES.PLUGIN_CAPABILITY,
    trustedKeys: trustedKeys || loadCapabilityTrustedKeys({ env }),
    requirePolicy: CAPABILITY_HYBRID_POLICY,
  });
}

module.exports = {
  CAPABILITY_HYBRID_POLICY,
  keySettings,
  loadCapabilitySigners,
  loadCapabilityTrustedKeys,
  signCapabilityEnvelope,
  verifyCapabilityEnvelope,
};
