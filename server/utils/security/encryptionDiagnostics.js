const crypto = require("crypto");
const {
  communicationDiagnosticsSnapshot,
  recordCommunicationDiagnostic,
} = require("../../middleware/communicationMetrics");
const { health: keyCustodyHealth } = require("./keyCustody");

const DIAGNOSTIC_RECORDED = Symbol.for("athena.encryptionDiagnosticRecorded");

function fingerprint(value) {
  if (value === null || value === undefined || value === "") return null;
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest("hex")
    .slice(0, 12);
}

function encryptionKeyState() {
  const keyState = keyCustodyHealth();
  return {
    configured: keyState.ok === true,
    validFormat: keyState.ok === true,
    fingerprint: keyState.fingerprint || null,
    keyId: keyState.keyId || null,
    providerType: keyState.providerType || null,
    source: keyState.source || null,
    error: keyState.error || null,
  };
}

function encryptionErrorCode(error) {
  if (error?.name === "EncryptionConfigError") return "encryption_config_error";
  if (error?.name === "EncryptionFormatError") return "encryption_format_error";
  if (error?.name === "EncryptionOperationError")
    return "encryption_operation_error";
  if (error?.message === "document_store_domain_mismatch")
    return "document_store_domain_mismatch";
  if (error instanceof SyntaxError) return "document_store_payload_parse_error";
  return "encryption_unknown_error";
}

function recordEncryptionBlock({
  error,
  operation = "decrypt-secret",
  domain = "secret-store",
  resource = null,
  payload = null,
} = {}) {
  if (error?.[DIAGNOSTIC_RECORDED]) return null;

  const event = recordCommunicationDiagnostic({
    subsystem: "encryption",
    severity: "blocker",
    operation,
    domain,
    errorCode: encryptionErrorCode(error),
    resourceFingerprint: fingerprint(resource),
    payloadFingerprint: fingerprint(payload),
    keyFingerprint: encryptionKeyState().fingerprint,
    blocked: true,
  });

  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      Object.defineProperty(error, DIAGNOSTIC_RECORDED, {
        value: true,
        enumerable: false,
      });
    } catch {}
  }
  return event;
}

function encryptionDiagnosticsSnapshot({ limit = 100 } = {}) {
  const events = communicationDiagnosticsSnapshot({
    subsystem: "encryption",
    limit,
  });
  const aggregate = {};
  for (const event of events) {
    const key = [event.domain, event.operation, event.errorCode]
      .map((value) => value || "unknown")
      .join(":");
    aggregate[key] = (aggregate[key] || 0) + 1;
  }

  return {
    keyState: encryptionKeyState(),
    totalBlocked: events.filter((event) => event.blocked).length,
    aggregate,
    events,
  };
}

module.exports = {
  encryptionDiagnosticsSnapshot,
  encryptionErrorCode,
  encryptionKeyState,
  fingerprint,
  recordEncryptionBlock,
};
