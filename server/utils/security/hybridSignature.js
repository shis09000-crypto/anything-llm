const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  cryptoSuite,
  registeredCryptoSuite,
  signatureBufferEncoding,
  signWithCryptoSuite,
  supportsNodeSignatureSuite,
  verifyWithCryptoSuite,
} = require("./cryptoSuiteRegistry");
const { observeVerificationFailure } = require("./cryptoObservability");

const HYBRID_SIGNATURE_ENVELOPE_FORMAT = "athena-hybrid-signature:v1";
const MAX_SIGNATURES = 8;

function compact(value, max = 256) {
  const result = String(value || "").trim();
  return result ? result.slice(0, max) : null;
}

function readPrivateFile(filePath, label) {
  const target = path.resolve(String(filePath || ""));
  const stat = fs.statSync(target);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    const error = new Error(`${label}_private_key_permissions_unsafe`);
    error.code = "HYBRID_SIGNATURE_PRIVATE_KEY_PERMISSIONS_UNSAFE";
    throw error;
  }
  return fs.readFileSync(target, "utf8");
}

function loadKeyDescriptor({
  suiteId,
  purpose,
  keyId,
  privateKeyFile = null,
  publicKeyFile = null,
  privateKey = null,
  publicKey = null,
  keyOrigin = "external-key-provider",
  hardwareProtection = "provider-asserted",
} = {}) {
  const suite = cryptoSuite(suiteId, { purpose });
  if (!suite) throw new Error("hybrid_signature_suite_unavailable");
  const resolvedPrivateKey = privateKeyFile
    ? readPrivateFile(privateKeyFile, compact(keyId) || suiteId)
    : privateKey;
  const resolvedPublicKey = publicKeyFile
    ? fs.readFileSync(path.resolve(publicKeyFile), "utf8")
    : publicKey ||
      (resolvedPrivateKey ? crypto.createPublicKey(resolvedPrivateKey) : null);
  if (!resolvedPrivateKey || !resolvedPublicKey || !compact(keyId)) {
    const error = new Error("hybrid_signature_key_incomplete");
    error.code = "HYBRID_SIGNATURE_KEY_INCOMPLETE";
    throw error;
  }
  if (!supportsNodeSignatureSuite(suite)) {
    const error = new Error("hybrid_signature_runtime_unavailable");
    error.code = "HYBRID_SIGNATURE_RUNTIME_UNAVAILABLE";
    throw error;
  }
  return {
    suite,
    keyId: compact(keyId),
    privateKey: resolvedPrivateKey,
    publicKey: resolvedPublicKey,
    keyOrigin: compact(keyOrigin) || "unknown",
    hardwareProtection: compact(hardwareProtection) || "unknown",
  };
}

function exportedPublicKey(key) {
  const object = key?.type === "public" ? key : crypto.createPublicKey(key);
  return object.export({ format: "der", type: "spki" }).toString("base64");
}

function signatureFamily(suite) {
  if (suite?.pqAlgorithm) return "post-quantum";
  return "classical";
}

function signHybridEnvelope({ data, signers, policy, now = new Date() } = {}) {
  const normalizedPolicy = {
    threshold: Math.max(Number(policy?.threshold) || 1, 1),
    classicalRequired: policy?.classicalRequired !== false,
    pqRequired: policy?.pqRequired === true,
  };
  if (
    !Array.isArray(signers) ||
    !signers.length ||
    signers.length > MAX_SIGNATURES
  )
    throw new Error("hybrid_signature_signers_invalid");
  const signatures = signers.map((signer) => {
    const encoded = signatureBufferEncoding(signer.suite);
    if (!encoded) throw new Error("hybrid_signature_encoding_invalid");
    return {
      suiteId: signer.suite.suiteId,
      keyId: signer.keyId,
      publicKey: exportedPublicKey(signer.publicKey),
      signature: signWithCryptoSuite({
        suite: signer.suite,
        data,
        privateKey: signer.privateKey,
      }).toString(encoded),
      family: signatureFamily(signer.suite),
      parameterSet: signer.suite.parameterSet,
      keyOrigin: signer.keyOrigin,
      hardwareProtection: signer.hardwareProtection,
      signedAt: now.toISOString(),
    };
  });
  if (normalizedPolicy.threshold > signatures.length)
    throw new Error("hybrid_signature_threshold_unsatisfied");
  if (
    normalizedPolicy.classicalRequired &&
    !signatures.some((entry) => entry.family === "classical")
  )
    throw new Error("hybrid_signature_classical_component_missing");
  if (
    normalizedPolicy.pqRequired &&
    !signatures.some((entry) => entry.family === "post-quantum")
  )
    throw new Error("hybrid_signature_pq_component_missing");
  return {
    format: HYBRID_SIGNATURE_ENVELOPE_FORMAT,
    policy: normalizedPolicy,
    signatures,
  };
}

function verifyHybridEnvelope({
  data,
  envelope,
  purpose,
  trustedKeys = null,
  requirePolicy = null,
} = {}) {
  const findings = [];
  if (
    envelope?.format !== HYBRID_SIGNATURE_ENVELOPE_FORMAT ||
    !Array.isArray(envelope?.signatures) ||
    envelope.signatures.length < 1 ||
    envelope.signatures.length > MAX_SIGNATURES
  ) {
    return {
      valid: false,
      validSignatures: 0,
      findings: ["hybrid_envelope_invalid"],
    };
  }
  const threshold = Number(envelope.policy?.threshold);
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 1 ||
    threshold > envelope.signatures.length
  )
    findings.push("hybrid_threshold_invalid");
  const seenKeys = new Set();
  const validFamilies = new Set();
  let validSignatures = 0;
  for (const signature of envelope.signatures) {
    const identity = `${signature.suiteId}:${signature.keyId}`;
    if (seenKeys.has(identity)) {
      findings.push("hybrid_duplicate_signer");
      continue;
    }
    seenKeys.add(identity);
    const suite = cryptoSuite(signature.suiteId, { purpose });
    if (!suite) {
      const registered = registeredCryptoSuite(signature.suiteId, { purpose });
      observeVerificationFailure(
        "unknown_suite",
        registered ? signatureFamily(registered).replace("-", "_") : "unknown"
      );
      findings.push(`hybrid_suite_invalid:${signature.suiteId}`);
      continue;
    }
    const family = signatureFamily(suite);
    if (signature.family !== family) {
      findings.push(`hybrid_family_mismatch:${signature.keyId}`);
      continue;
    }
    if (signature.parameterSet !== suite.parameterSet) {
      findings.push(`hybrid_parameter_set_mismatch:${signature.keyId}`);
      continue;
    }
    const trusted = !trustedKeys
      ? null
      : trustedKeys.find(
          (entry) =>
            entry.keyId === signature.keyId &&
            entry.suiteId === signature.suiteId &&
            entry.publicKey === signature.publicKey
        );
    if (trusted?.expiresAt && Date.parse(trusted.expiresAt) <= Date.now()) {
      observeVerificationFailure("expired_key_id", family.replace("-", "_"));
      findings.push(`hybrid_key_expired:${signature.keyId}`);
      continue;
    }
    if (trustedKeys && !trusted) {
      observeVerificationFailure("untrusted_key", family.replace("-", "_"));
      findings.push(`hybrid_key_untrusted:${signature.keyId}`);
      continue;
    }
    let valid = false;
    try {
      valid = verifyWithCryptoSuite({
        suite,
        data,
        publicKey: crypto.createPublicKey({
          key: Buffer.from(signature.publicKey, "base64"),
          format: "der",
          type: "spki",
        }),
        signature: signature.signature,
      });
    } catch {
      observeVerificationFailure(
        "corrupt_public_key",
        family.replace("-", "_")
      );
      findings.push(`hybrid_key_or_signature_invalid:${signature.keyId}`);
      continue;
    }
    if (!valid) {
      findings.push(`hybrid_signature_invalid:${signature.keyId}`);
      continue;
    }
    validSignatures += 1;
    validFamilies.add(family);
  }
  const effective = {
    classicalRequired:
      requirePolicy?.classicalRequired ??
      envelope.policy?.classicalRequired !== false,
    pqRequired:
      requirePolicy?.pqRequired ?? envelope.policy?.pqRequired === true,
  };
  if (validSignatures < threshold)
    findings.push("hybrid_threshold_unsatisfied");
  if (effective.classicalRequired && !validFamilies.has("classical"))
    findings.push("hybrid_classical_component_missing");
  if (effective.pqRequired && !validFamilies.has("post-quantum"))
    findings.push("hybrid_pq_component_missing");
  if (requirePolicy?.pqRequired && envelope.policy?.pqRequired !== true)
    observeVerificationFailure("policy_downgrade", "hybrid");
  if (requirePolicy?.pqRequired && envelope.policy?.pqRequired !== true)
    findings.push("hybrid_policy_downgrade_detected");
  if (
    Number.isSafeInteger(requirePolicy?.threshold) &&
    threshold < requirePolicy.threshold
  ) {
    observeVerificationFailure("policy_downgrade", "hybrid");
    findings.push("hybrid_threshold_downgrade_detected");
  }
  return { valid: findings.length === 0, validSignatures, findings };
}

module.exports = {
  HYBRID_SIGNATURE_ENVELOPE_FORMAT,
  loadKeyDescriptor,
  signHybridEnvelope,
  signatureFamily,
  verifyHybridEnvelope,
};
