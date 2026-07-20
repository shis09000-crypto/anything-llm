const crypto = require("crypto");
const { contentHash } = require("./canonicalJson");

const PROFILE_FIELDS = new Set([
  "username",
  "displayName",
  "pfpFilename",
  "bio",
]);
const WORKSPACE_METADATA_FIELDS = new Set([
  "name",
  "chatProvider",
  "chatModel",
  "chatMode",
  "agentProvider",
  "agentModel",
  "openAiHistory",
  "similarityThreshold",
  "topN",
  "vectorSearchMode",
]);
const THREAD_METADATA_FIELDS = new Set(["name", "chatModel"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writableFieldsForKind(kind) {
  if (kind === "user-profile") return PROFILE_FIELDS;
  if (kind === "workspace-metadata") return WORKSPACE_METADATA_FIELDS;
  if (kind === "thread-metadata") return THREAD_METADATA_FIELDS;
  return null;
}

function validateProjectedPayload(kind, payload) {
  const writable = writableFieldsForKind(kind);
  if (!writable) return { payload, fields: [] };
  if (!isPlainObject(payload)) {
    return { error: "sync_v2_object_payload_required", fields: [] };
  }
  const fields = Object.keys(payload);
  if (!fields.length) return { error: "sync_v2_empty_mutation", fields };
  const unsupported = fields.filter((field) => !writable.has(field));
  if (unsupported.length) {
    return {
      error: "sync_v2_unsupported_fields",
      fields,
      unsupported,
    };
  }
  return {
    payload: Object.fromEntries(fields.map((field) => [field, payload[field]])),
    fields,
  };
}

function mergePatchPaths(value, prefix = "") {
  if (!isPlainObject(value)) return [prefix || "$"];
  const paths = [];
  for (const [key, entry] of Object.entries(value)) {
    if (["dirty", "updatedAt"].includes(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry) && Object.keys(entry).length) {
      paths.push(...mergePatchPaths(entry, path));
    } else {
      paths.push(path);
    }
  }
  return paths.length ? [...new Set(paths)].slice(0, 100) : [prefix || "$"];
}

function authoritativeChangedPaths(mutation = {}) {
  if (
    ["replace", "delete", "set-add", "set-remove"].includes(mutation.operation)
  )
    return ["$"];
  return mergePatchPaths(mutation.payload);
}

function mutationRequestHash(mutation = {}) {
  return contentHash(
    {
      nodeKey: String(mutation.nodeKey || ""),
      baseVersion: Number(mutation.baseVersion),
      operation: String(mutation.operation || ""),
      payload: mutation.payload,
    },
    { excludedKeys: new Set(), excludeSensitive: false }
  );
}

function mutationReceiptId(mutationId) {
  return `sync-v2:${crypto
    .createHash("sha256")
    .update(String(mutationId || ""), "utf8")
    .digest("hex")}`;
}

module.exports = {
  PROFILE_FIELDS,
  THREAD_METADATA_FIELDS,
  WORKSPACE_METADATA_FIELDS,
  authoritativeChangedPaths,
  isPlainObject,
  mutationReceiptId,
  mutationRequestHash,
  validateProjectedPayload,
  writableFieldsForKind,
};
