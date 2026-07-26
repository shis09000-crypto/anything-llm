#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  releaseEvidenceSigners,
  signReleaseEvidence,
} = require("../utils/security/releaseEvidence");

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name, envName = null) {
  const value = argument(name) || (envName ? process.env[envName] : null);
  if (!String(value || "").trim()) throw new Error(`${name.slice(2)}_required`);
  return String(value).trim();
}

function writeAtomic(target, value) {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) throw new Error("evidence_output_exists");
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o755 });
  const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o644 });
    const descriptor = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.linkSync(temporary, resolved);
    fs.unlinkSync(temporary);
    const directory = fs.openSync(path.dirname(resolved), "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function main() {
  if (!process.argv.includes("--execute"))
    throw new Error("explicit_execute_required");
  const inputFile = path.resolve(required("--input"));
  const outputFile = path.resolve(required("--output"));
  const evidence = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const expectedProfile = argument("--profile");
  if (expectedProfile && evidence.profile !== expectedProfile)
    throw new Error("evidence_profile_mismatch");
  const signers = releaseEvidenceSigners({
    ed25519KeyId: required("--ed25519-key-id", "ATHENA_RELEASE_ED25519_KEY_ID"),
    ed25519PrivateKeyFile: required(
      "--ed25519-private-key",
      "ATHENA_RELEASE_ED25519_PRIVATE_KEY_FILE"
    ),
    ed25519PublicKeyFile:
      argument("--ed25519-public-key") ||
      process.env.ATHENA_RELEASE_ED25519_PUBLIC_KEY_FILE ||
      null,
    mlDSA65KeyId: required("--mldsa65-key-id", "ATHENA_RELEASE_MLDSA65_KEY_ID"),
    mlDSA65PrivateKeyFile: required(
      "--mldsa65-private-key",
      "ATHENA_RELEASE_MLDSA65_PRIVATE_KEY_FILE"
    ),
    mlDSA65PublicKeyFile:
      argument("--mldsa65-public-key") ||
      process.env.ATHENA_RELEASE_MLDSA65_PUBLIC_KEY_FILE ||
      null,
    keyOrigin: argument("--key-origin") || "external-release-key-provider",
    hardwareProtection:
      argument("--hardware-protection") || "provider-asserted",
  });
  const signed = signReleaseEvidence({ evidence, signers });
  writeAtomic(outputFile, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(
    JSON.stringify({
      success: true,
      profile: signed.profile,
      environment: signed.environment,
      output: outputFile,
      signatureCount: signed.signatureEnvelope.signatures.length,
      threshold: signed.signatureEnvelope.policy.threshold,
    })
  );
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({ success: false, error: error.code || error.message })
  );
  process.exitCode = 1;
}
