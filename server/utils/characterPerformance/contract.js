const crypto = require("crypto");
const { TRACK_ORDER } = require("../responsesRuntime/character/v2/constants");

const PACK_SCHEMA = "athena.character.performance_pack";
const PLAN_SCHEMA = "athena.character.performance_plan";
const PROTOCOL_VERSION = "1.0";
const ADAPTER = "mock.anatomy.v1";
const PRIMITIVES = Object.freeze([
  "face.region_state",
  "gaze.target",
  "body.motion",
  "limb.motion",
  "world.action",
  "speech.text",
]);

function performanceError(code, httpStatus = 400, details = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = httpStatus;
  if (details) error.details = details;
  return error;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
}

function digest(value, omittedPath = null) {
  const copy = structuredClone(value);
  if (omittedPath === "integrity.sha256" && copy.integrity) {
    delete copy.integrity.sha256;
    delete copy.integrity.signature;
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(copy)))
    .digest("hex");
}

function identifier(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function validatePack(pack, { production = false } = {}) {
  const findings = [];
  if (pack?.schema !== PACK_SCHEMA) findings.push("pack_schema_invalid");
  if (pack?.schema_version !== PROTOCOL_VERSION)
    findings.push("pack_version_invalid");
  if (pack?.adapter !== ADAPTER) findings.push("pack_adapter_unsupported");
  if (!/^\d+\.\d+\.\d+$/.test(String(pack?.version || "")))
    findings.push("pack_semver_invalid");
  if (!/^[a-f0-9]{64}$/.test(String(pack?.manifest_ref?.sha256 || "")))
    findings.push("pack_manifest_digest_invalid");
  if (!/^[a-f0-9]{64}$/.test(String(pack?.asset?.sha256 || "")))
    findings.push("pack_asset_digest_invalid");
  if (
    !String(pack?.asset?.asset_ref || "").startsWith("asset:") &&
    !String(pack?.asset?.asset_ref || "").startsWith("builtin:")
  )
    findings.push("pack_asset_ref_invalid");
  if (
    pack?.track_support?.length !== TRACK_ORDER.length ||
    TRACK_ORDER.some(
      (track, index) => pack.track_support[index]?.track !== track
    )
  )
    findings.push("pack_track_support_invalid");
  if (!Array.isArray(pack?.bindings) || pack.bindings.length < 1)
    findings.push("pack_bindings_required");
  const bindingIds = new Set();
  for (const binding of pack?.bindings || []) {
    if (!binding.binding_id || bindingIds.has(binding.binding_id))
      findings.push("pack_binding_id_invalid");
    bindingIds.add(binding.binding_id);
    if (!PRIMITIVES.includes(binding.primitive))
      findings.push("pack_binding_primitive_invalid");
    try {
      const pattern = new RegExp(binding.capability_pattern);
      if (!binding.capability_pattern.startsWith("^") || !pattern)
        findings.push("pack_binding_pattern_invalid");
    } catch {
      findings.push("pack_binding_pattern_invalid");
    }
    if (
      !Array.isArray(binding.tracks) ||
      binding.tracks.some((track) => !TRACK_ORDER.includes(track))
    )
      findings.push("pack_binding_tracks_invalid");
  }
  const fallbacks = pack?.fallbacks || {};
  for (const start of Object.keys(fallbacks)) {
    const seen = new Set();
    let current = start;
    for (let depth = 0; current && depth <= 4; depth += 1) {
      if (seen.has(current)) {
        findings.push("pack_fallback_cycle");
        break;
      }
      seen.add(current);
      current = fallbacks[current];
      if (depth === 4 && current) findings.push("pack_fallback_depth_exceeded");
    }
  }
  const observed = digest(pack, "integrity.sha256");
  if (pack?.integrity?.sha256 !== observed)
    findings.push("pack_digest_mismatch");
  if (production) {
    if (pack?.integrity?.signature_algorithm !== "ed25519")
      findings.push("pack_signature_required");
    if (!pack?.integrity?.key_id || !pack?.integrity?.signature)
      findings.push("pack_signature_material_required");
  }
  return { ok: findings.length === 0, findings, observedDigest: observed };
}

function semverTuple(value) {
  return String(value || "")
    .split(".")
    .map((entry) => Number(entry));
}

function semverAtLeast(actual, minimum) {
  const left = semverTuple(actual);
  const right = semverTuple(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function normalizeScope(value = {}) {
  const workspaceId = Number(value.workspace_id ?? value.workspaceId);
  const threadId = Number(value.thread_id ?? value.threadId);
  const ownerUserId = Number(value.owner_user_id ?? value.userId);
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1)
    throw performanceError("performance_workspace_scope_required");
  return {
    workspaceId,
    threadId: Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null,
    ownerUserId:
      Number.isSafeInteger(ownerUserId) && ownerUserId > 0 ? ownerUserId : null,
  };
}

function validateSessionRequest(body = {}) {
  if (!body.character_id || !body.character_instance_id)
    throw performanceError("performance_character_required");
  const client = body.client_profile;
  if (client?.adapter !== ADAPTER)
    throw performanceError("performance_adapter_unsupported", 409);
  if (!/^\d+\.\d+\.\d+$/.test(String(client?.runtime_version || "")))
    throw performanceError("performance_runtime_version_invalid");
  const supported = Array.isArray(client?.supported_primitives)
    ? [...new Set(client.supported_primitives)]
    : [];
  if (!PRIMITIVES.every((primitive) => supported.includes(primitive)))
    throw performanceError("performance_client_capabilities_incomplete", 409);
  return {
    characterId: String(body.character_id),
    characterInstanceId: String(body.character_instance_id),
    clientProfile: {
      adapter: ADAPTER,
      runtime_version: client.runtime_version,
      supported_primitives: supported,
      installed_assets: Array.isArray(client.installed_assets)
        ? client.installed_assets
        : [],
      reduced_motion: client.reduced_motion === true,
    },
    scope: normalizeScope(body.scope || body.athena || {}),
    conversationId: body.conversation_id || null,
  };
}

function validateFeedback(body = {}) {
  if (!Array.isArray(body.events) || body.events.length < 1)
    throw performanceError("performance_feedback_events_required");
  return body.events.map((event) => {
    if (
      !["started", "completed", "failed", "cancelled"].includes(event.status) ||
      !event.command_id ||
      !event.event_id
    )
      throw performanceError("performance_feedback_event_invalid");
    return {
      event_id: String(event.event_id),
      command_id: String(event.command_id),
      status: event.status,
      actual_start_ms: Number.isFinite(Number(event.actual_start_ms))
        ? Number(event.actual_start_ms)
        : null,
      actual_duration_ms: Number.isFinite(Number(event.actual_duration_ms))
        ? Number(event.actual_duration_ms)
        : null,
      error_code: event.error_code
        ? String(event.error_code).slice(0, 160)
        : null,
    };
  });
}

module.exports = {
  ADAPTER,
  PACK_SCHEMA,
  PLAN_SCHEMA,
  PRIMITIVES,
  PROTOCOL_VERSION,
  TRACK_ORDER,
  canonicalize,
  digest,
  identifier,
  normalizeScope,
  performanceError,
  semverAtLeast,
  validateFeedback,
  validatePack,
  validateSessionRequest,
};
