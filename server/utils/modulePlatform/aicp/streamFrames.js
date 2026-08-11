const { canonicalJson, sha256 } = require("../canonical");

const STREAM_FRAME_SCHEMA = "athena.aicp.stream-frame";
const STREAM_FRAME_VERSION = "1.1";
const FRAME_TYPES = new Set([
  "open",
  "data",
  "checkpoint",
  "heartbeat",
  "terminal",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function createStreamFrame({
  streamId,
  sequence,
  type,
  payload = null,
  cursor = null,
  terminalStatus = null,
} = {}) {
  const frame = {
    schema: STREAM_FRAME_SCHEMA,
    schemaVersion: STREAM_FRAME_VERSION,
    streamId: String(streamId || ""),
    sequence: Number(sequence),
    type: String(type || ""),
    cursor: cursor === null ? null : String(cursor),
    terminalStatus: terminalStatus === null ? null : String(terminalStatus),
    payload,
    payloadHash: sha256(canonicalJson(payload)),
  };
  const validation = validateStreamFrame(frame, { skipLifecycle: true });
  if (!validation.valid) {
    const error = new Error("aicp_stream_frame_invalid");
    error.code = "AICP_STREAM_FRAME_INVALID";
    error.findings = validation.findings;
    throw error;
  }
  return frame;
}

function validateStreamFrame(
  value = {},
  { previous = null, skipLifecycle = false } = {}
) {
  const findings = [];
  if (value.schema !== STREAM_FRAME_SCHEMA) findings.push("schema_invalid");
  if (value.schemaVersion !== STREAM_FRAME_VERSION)
    findings.push("schema_version_invalid");
  if (!String(value.streamId || "")) findings.push("stream_id_missing");
  if (!Number.isInteger(value.sequence) || value.sequence < 0)
    findings.push("sequence_invalid");
  if (!FRAME_TYPES.has(value.type)) findings.push("type_invalid");
  if (value.type === "terminal") {
    if (!TERMINAL_STATUSES.has(value.terminalStatus))
      findings.push("terminal_status_invalid");
  } else if (value.terminalStatus !== null) findings.push("terminal_status_unexpected");
  if (sha256(canonicalJson(value.payload)) !== value.payloadHash)
    findings.push("payload_hash_mismatch");
  if (previous) {
    if (previous.streamId !== value.streamId) findings.push("stream_id_mismatch");
    if (value.sequence !== previous.sequence + 1) findings.push("sequence_gap");
    if (previous.type === "terminal") findings.push("frame_after_terminal");
  } else if (!skipLifecycle && (value.type !== "open" || value.sequence !== 0))
    findings.push("open_frame_required");
  return { valid: findings.length === 0, findings };
}

class AicpStreamSequence {
  constructor(streamId) {
    this.streamId = String(streamId);
    this.previous = null;
    this.terminalCount = 0;
  }

  accept(frame) {
    const validation = validateStreamFrame(frame, { previous: this.previous });
    if (!validation.valid) return validation;
    if (frame.type === "terminal") this.terminalCount += 1;
    if (this.terminalCount > 1)
      return { valid: false, findings: ["terminal_duplicate"] };
    this.previous = frame;
    return validation;
  }

  complete() {
    return this.previous?.type === "terminal" && this.terminalCount === 1;
  }
}

module.exports = {
  AicpStreamSequence,
  FRAME_TYPES,
  STREAM_FRAME_SCHEMA,
  STREAM_FRAME_VERSION,
  TERMINAL_STATUSES,
  createStreamFrame,
  validateStreamFrame,
};
