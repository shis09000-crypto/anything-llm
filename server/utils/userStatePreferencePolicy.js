const fs = require("fs");
const path = require("path");
const { storagePath } = require("./environment");
const {
  getAuthorizedFileBackedResource,
  getAuthorizedWorkspace,
  getAuthorizedWorkspaceThread,
} = require("./authz/resourceAccess");
const {
  USER_STATE_NAMESPACE_POLICIES,
  namespacePolicy,
  sanitizeValue,
} = require("./dataAccess/dataAccessPolicy");
const { safeJsonParse } = require("./http");

const DEFAULT_SCOPE = "global";
const MAX_STATE_BYTES = 256 * 1024;
const MAX_DRAFT_BYTES = 64 * 1024;

const USER_STATE_MERGE_POLICIES = Object.freeze({
  "chat.draft": "version-merge",
  "thread.read-state": "monotonic-cursor",
  "ios.drawer.pins": "set-replace",
  "workspace.order": "ordered-replace",
});

const USER_STATE_NAMESPACES = new Set(
  Object.keys(USER_STATE_NAMESPACE_POLICIES)
);

const GLOBAL_NAMESPACES = new Set([
  "recent.navigation",
  "preferences.appearance",
  "workspace.order",
  "reader.progress",
  "reader.library",
  "crypto.ui",
  "ios.drawer.pins",
]);

function requiresAppleNativeAudience(namespace = "") {
  return namespace === "ios.drawer.pins";
}

function isAppleNativeClient(request, response) {
  const context = request?.clientContext || response?.locals?.clientContext;
  return ["ios", "ipad"].includes(
    String(context?.platform || "").toLowerCase()
  );
}

function valueSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function compactString(value = "", max = 512) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function finiteInteger(value, fallback = null) {
  const next = Number(value);
  return Number.isSafeInteger(next) && next >= 0 ? next : fallback;
}

function sanitizeLegacyDraftEnvelope(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.encrypted !== true || value.encryptedText?.encrypted !== true)
    return null;
  const encryptedText = value.encryptedText;
  const allowed = {
    encrypted: true,
    cryptoVersion: compactString(encryptedText.cryptoVersion, 64),
    algorithm: compactString(encryptedText.algorithm, 64),
    keyId: compactString(encryptedText.keyId, 128),
    namespace: compactString(encryptedText.namespace, 512),
    iv: compactString(encryptedText.iv, 128),
    ciphertext: compactString(encryptedText.ciphertext, MAX_DRAFT_BYTES),
  };
  if (!allowed.iv || !allowed.ciphertext) return null;
  return {
    encrypted: true,
    cryptoVersion: compactString(value.cryptoVersion, 64),
    encryptedText: allowed,
    workspaceSlug: value.workspaceSlug
      ? compactString(value.workspaceSlug, 128)
      : null,
    threadSlug: value.threadSlug ? compactString(value.threadSlug, 128) : null,
    expiresAt: finiteInteger(value.expiresAt),
  };
}

function sanitizeChatDraftValue(value = null) {
  const legacy = sanitizeLegacyDraftEnvelope(value);
  if (legacy) return legacy;
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    text: String(source.text || "").slice(0, MAX_DRAFT_BYTES),
    workspaceSlug: source.workspaceSlug
      ? compactString(source.workspaceSlug, 128)
      : null,
    threadSlug: source.threadSlug
      ? compactString(source.threadSlug, 128)
      : null,
    expiresAt: finiteInteger(source.expiresAt),
  };
}

function sanitizeThreadReadState(value = null) {
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    cursor: finiteInteger(source.cursor, 0),
    ...(finiteInteger(source.messageId) === null
      ? {}
      : { messageId: finiteInteger(source.messageId) }),
  };
}

function sanitizeUserStateValue(namespace, value) {
  if (namespace === "chat.draft") return sanitizeChatDraftValue(value);
  if (namespace === "thread.read-state") return sanitizeThreadReadState(value);
  return sanitizeValue(value);
}

function userStateMergePolicy(namespace) {
  return USER_STATE_MERGE_POLICIES[String(namespace)] || "version-merge";
}

function parseScopedValue(scope = DEFAULT_SCOPE) {
  const parts = String(scope || DEFAULT_SCOPE).split(":");
  return { kind: parts[0] || DEFAULT_SCOPE, parts };
}

function standaloneReaderMetadata(readerDocumentId = null) {
  if (!readerDocumentId || !/^[a-zA-Z0-9_-]{8,128}$/.test(readerDocumentId))
    return null;
  const root = path.resolve(
    storagePath("reader-documents"),
    "__global_reader__",
    readerDocumentId
  );
  const metadataPath = path.join(root, "metadata.json");
  if (!metadataPath.startsWith(path.resolve(storagePath("reader-documents"))))
    return null;
  try {
    if (!fs.existsSync(metadataPath)) return null;
    return safeJsonParse(fs.readFileSync(metadataPath, "utf8"), null);
  } catch {
    return null;
  }
}

function sanitizedStateInput(state = {}) {
  const baseVersion = Number(state.baseVersion);
  const namespace = compactString(state.namespace, 96);
  return {
    namespace,
    scope: compactString(state.scope || DEFAULT_SCOPE, 512) || DEFAULT_SCOPE,
    version: compactString(state.version || "1", 32) || "1",
    value: sanitizeUserStateValue(namespace, state.value ?? null),
    ...(Number.isInteger(baseVersion) && baseVersion >= 0
      ? { baseVersion }
      : {}),
    changedPaths: Array.isArray(state.changedPaths)
      ? state.changedPaths
          .map((path) => compactString(path, 256))
          .filter(Boolean)
      : ["value"],
    mutationId: compactString(state.mutationId, 160) || null,
  };
}

async function validateUserStateScope({
  request,
  response,
  namespace,
  scope = DEFAULT_SCOPE,
} = {}) {
  if (!USER_STATE_NAMESPACES.has(namespace)) {
    return { ok: false, status: 400, error: "invalid_namespace" };
  }

  if (
    requiresAppleNativeAudience(namespace) &&
    !isAppleNativeClient(request, response)
  ) {
    return { ok: false, status: 404, error: "state_namespace_unavailable" };
  }

  const maxBytes =
    namespace === "chat.draft" ? MAX_DRAFT_BYTES : MAX_STATE_BYTES;
  if (scope === DEFAULT_SCOPE && GLOBAL_NAMESPACES.has(namespace)) {
    return { ok: true, scope };
  }

  const parsed = parseScopedValue(scope);
  if (parsed.kind === "workspace") {
    const workspaceSlug = parsed.parts[1];
    const workspace = await getAuthorizedWorkspace({
      request,
      response,
      workspaceSlug,
    });
    return workspace
      ? { ok: true, scope }
      : { ok: false, status: 404, error: "state_scope_not_found" };
  }

  if (parsed.kind === "thread") {
    const workspaceSlug = parsed.parts[1];
    const threadSlug = parsed.parts[2];
    const { thread } = await getAuthorizedWorkspaceThread({
      request,
      response,
      workspaceSlug,
      threadSlug,
    });
    return thread
      ? { ok: true, scope }
      : { ok: false, status: 404, error: "state_scope_not_found" };
  }

  if (parsed.kind === "reader") {
    const readerDocumentId = parsed.parts[1];
    const metadata = standaloneReaderMetadata(readerDocumentId);
    const access = await getAuthorizedFileBackedResource({
      request,
      response,
      metadata,
      resourceType: "standalone_reader_document",
      resourceId: readerDocumentId,
    });
    return access
      ? { ok: true, scope }
      : { ok: false, status: 404, error: "state_scope_not_found" };
  }

  if (namespace === "chat.draft" && scope === DEFAULT_SCOPE) {
    return { ok: true, scope };
  }

  void maxBytes;
  return { ok: false, status: 400, error: "invalid_scope" };
}

async function validateUserStateInput({ request, response, state } = {}) {
  const input = sanitizedStateInput(state);
  const scopeResult = await validateUserStateScope({
    request,
    response,
    namespace: input.namespace,
    scope: input.scope,
  });
  if (!scopeResult.ok) return scopeResult;

  const maxBytes =
    input.namespace === "chat.draft" ? MAX_DRAFT_BYTES : MAX_STATE_BYTES;
  if (valueSize(input.value) > maxBytes) {
    return { ok: false, status: 413, error: "state_value_too_large" };
  }

  return { ok: true, state: input };
}

function parseNamespaceFilter(value = null) {
  if (!value) return null;
  const namespaces = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => USER_STATE_NAMESPACES.has(item));
  return namespaces.length ? [...new Set(namespaces)] : null;
}

module.exports = {
  DEFAULT_SCOPE,
  USER_STATE_MERGE_POLICIES,
  USER_STATE_NAMESPACES,
  namespacePolicy,
  parseNamespaceFilter,
  requiresAppleNativeAudience,
  sanitizeUserStateValue,
  userStateMergePolicy,
  validateUserStateInput,
  validateUserStateScope,
};
