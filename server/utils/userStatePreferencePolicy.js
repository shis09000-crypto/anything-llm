const fs = require("fs");
const path = require("path");
const { storagePath } = require("./environment");
const {
  getAuthorizedFileBackedResource,
  getAuthorizedWorkspace,
  getAuthorizedWorkspaceThread,
} = require("./authz/resourceAccess");
const { safeJsonParse } = require("./http");

const DEFAULT_SCOPE = "global";
const MAX_STATE_BYTES = 256 * 1024;
const MAX_DRAFT_BYTES = 64 * 1024;

const USER_STATE_NAMESPACES = new Set([
  "recent.navigation",
  "preferences.appearance",
  "workspace.layout",
  "workspace.order",
  "reader.progress",
  "reader.library",
  "chat.draft",
  "crypto.ui",
]);

const GLOBAL_NAMESPACES = new Set([
  "recent.navigation",
  "preferences.appearance",
  "workspace.order",
  "reader.progress",
  "reader.library",
  "crypto.ui",
]);

function valueSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function compactString(value = "", max = 512) {
  return String(value || "")
    .trim()
    .slice(0, max);
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
  return {
    namespace: compactString(state.namespace, 96),
    scope: compactString(state.scope || DEFAULT_SCOPE, 512) || DEFAULT_SCOPE,
    version: compactString(state.version || "1", 32) || "1",
    value: state.value ?? null,
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
  USER_STATE_NAMESPACES,
  parseNamespaceFilter,
  validateUserStateInput,
  validateUserStateScope,
};
