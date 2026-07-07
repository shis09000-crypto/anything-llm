const {
  authSessionFingerprintFromRequest,
} = require("../../utils/authz/vaultAccessGrants");
const {
  issueSensitiveSession,
  sensitiveSessionTokenFromRequest,
  validateSensitiveSessionForRequest,
} = require("../../utils/authz/sensitiveSessions");
const { getClientContext } = require("../../utils/clientIdentity");
const {
  readerDebugGrantIdFromRequest,
  validateReaderDebugAccessGrantForRequest,
} = require("../../utils/devControl/readerDebugAccess");

const READER_STREAM_CACHE_CONTROL = "private, max-age=604800, no-transform";
const READER_SENSITIVE_STREAM_CACHE_CONTROL =
  "private, no-store, max-age=0, must-revalidate, no-transform";

function readerSensitiveOwnerScope(workspace) {
  return workspace?.readerStandalone
    ? "reader:standalone"
    : `workspace:${workspace?.slug || "unknown"}:reader`;
}

function readerSensitiveResourceId(workspace, readerDocumentId) {
  const owner =
    workspace?.readerStorageSegment ||
    workspace?.slug ||
    (workspace?.readerStandalone ? "standalone" : "unknown");
  return `${owner}:${readerDocumentId}`;
}

function readerSensitiveSessionForResponse(
  request,
  response,
  workspace,
  readerDocumentId,
  method = "reader-document-open"
) {
  const userId = Number(response?.locals?.user?.id || 0);
  const context = getClientContext(request);
  if (!userId || !context?.clientId) return null;
  return issueSensitiveSession({
    userId,
    clientId: context.clientId,
    resourceType: "reader_document",
    resourceId: readerSensitiveResourceId(workspace, readerDocumentId),
    ownerScope: readerSensitiveOwnerScope(workspace),
    method,
    requestId:
      request?.signedRequest?.requestId ||
      context.requestId ||
      request?.communicationRequestId ||
      null,
    sessionFingerprint: authSessionFingerprintFromRequest(request),
  });
}

function validateReaderContentAccess({
  request,
  response,
  workspace,
  readerDocumentId,
  endpoint,
}) {
  const token = sensitiveSessionTokenFromRequest(request);
  const userId = Number(response?.locals?.user?.id || 0);
  const context = getClientContext(request);
  const expectedResourceId = readerSensitiveResourceId(
    workspace,
    readerDocumentId
  );
  const expectedOwnerScope = readerSensitiveOwnerScope(workspace);
  if (token) {
    const result = validateSensitiveSessionForRequest(request, {
      userId,
      clientId: context?.clientId,
      resourceType: "reader_document",
      resourceId: expectedResourceId,
      ownerScope: expectedOwnerScope,
      heartbeat: true,
    });
    if (result.ok)
      return { ...result, via: "sensitive-session", present: true };
  }

  const debugGrant = validateReaderDebugAccessGrantForRequest(
    request,
    response,
    {
      workspaceSlug: workspace?.readerStandalone ? null : workspace?.slug,
      readerDocumentId,
      endpoint,
    }
  );
  if (debugGrant.ok)
    return { ...debugGrant, via: "dev-control-debug-grant", present: true };

  const reason = token
    ? "invalid_sensitive_session"
    : debugGrant.present
      ? debugGrant.reason || "invalid_debug_grant"
      : "missing_reader_content_access";
  console.warn("[ReaderSensitiveGate] denied", {
    reason,
    endpoint,
    route: request?.route?.path || request?.path || null,
    readerDocumentId,
    workspaceSlug: workspace?.readerStandalone ? null : workspace?.slug || null,
    standalone: workspace?.readerStandalone === true,
    tokenPresent: !!token,
    debugGrantPresent: !!readerDebugGrantIdFromRequest(request),
    userId: userId || null,
    clientIdPresent: !!context?.clientId,
    requestId:
      request?.signedRequest?.requestId ||
      context?.requestId ||
      request?.communicationRequestId ||
      null,
  });
  return {
    ok: false,
    error: "sensitive_session_required",
    reason,
    present: false,
  };
}

function readerStreamCacheControlForRequest(request) {
  return sensitiveSessionTokenFromRequest(request) ||
    readerDebugGrantIdFromRequest(request)
    ? READER_SENSITIVE_STREAM_CACHE_CONTROL
    : READER_STREAM_CACHE_CONTROL;
}

module.exports = {
  readerSensitiveOwnerScope,
  readerSensitiveResourceId,
  readerSensitiveSessionForResponse,
  readerStreamCacheControlForRequest,
  validateReaderContentAccess,
};
