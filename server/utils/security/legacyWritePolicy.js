const fs = require("fs");
const path = require("path");
const { storagePath } = require("../environment");

const LEGACY_WRITE_POLICY_FORMAT = "athena-legacy-write-policy:v1";

function policyPath() {
  return storagePath("security", "key-closure", "legacy-write-policy.json");
}

function readLegacyWritePolicy() {
  const filePath = policyPath();
  if (!fs.existsSync(filePath)) {
    return {
      format: LEGACY_WRITE_POLICY_FORMAT,
      legacyWritesClosed: false,
      closedAt: null,
      keyId: null,
      evidenceHash: null,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (parsed?.format !== LEGACY_WRITE_POLICY_FORMAT)
    throw new Error("legacy_write_policy_format_invalid");
  return parsed;
}

function legacyWritesClosed() {
  return readLegacyWritePolicy().legacyWritesClosed === true;
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function closeLegacyWrites({ keyId, evidenceHash, now = new Date() } = {}) {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(String(keyId || "")))
    throw new Error("legacy_write_policy_key_id_invalid");
  if (!/^[a-f0-9]{64}$/.test(String(evidenceHash || "")))
    throw new Error("legacy_write_policy_evidence_hash_invalid");
  const current = readLegacyWritePolicy();
  if (current.legacyWritesClosed) return current;
  const next = {
    format: LEGACY_WRITE_POLICY_FORMAT,
    legacyWritesClosed: true,
    closedAt: now.toISOString(),
    keyId,
    evidenceHash,
  };
  writePrivateJson(policyPath(), next);
  return next;
}

function assertLegacyEnvelopeWriteAllowed(value = null) {
  const isLegacyEnvelope =
    process.env.ATHENA_SECRET_ENVELOPE_VERSION === "v1" ||
    (typeof value === "string" && value.startsWith("enc:v1:"));
  if (isLegacyEnvelope && legacyWritesClosed()) {
    const error = new Error("legacy_secret_writes_closed");
    error.code = "LEGACY_SECRET_WRITES_CLOSED";
    throw error;
  }
}

module.exports = {
  LEGACY_WRITE_POLICY_FORMAT,
  assertLegacyEnvelopeWriteAllowed,
  closeLegacyWrites,
  legacyWritesClosed,
  policyPath,
  readLegacyWritePolicy,
};
