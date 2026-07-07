const SENSITIVE_FIELD_KEY =
  /(token|secret|credential|authorization|cookie|apiKey|api_key|originalUrl|pagePreviewUrl|previewPdfUrl|thumbnailUrl|absolutePath|localPath|content|text|rawText|pdfContent|documentContent|buffer|dataUrl|fileContent|signedUrl|downloadUrl)/i;

const DATA_ACCESS_CLASSIFICATIONS = Object.freeze({
  public: "public",
  internal: "internal",
  user: "user",
  sensitive: "sensitive",
  secret: "secret",
  ephemeral: "ephemeral",
});

const DOMAIN_CLASSIFICATIONS = Object.freeze({
  accountDeletion: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  adminSystem: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  agentSkillWhitelist: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  authIdentity: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  clientIdentity: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  communityHub: DATA_ACCESS_CLASSIFICATIONS.internal,
  crypto: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  document: DATA_ACCESS_CLASSIFICATIONS.user,
  documentEmbeddingBatch: DATA_ACCESS_CLASSIFICATIONS.internal,
  documentIndexStatus: DATA_ACCESS_CLASSIFICATIONS.internal,
  documentSyncQueue: DATA_ACCESS_CLASSIFICATIONS.internal,
  documentSyncRun: DATA_ACCESS_CLASSIFICATIONS.internal,
  documentVector: DATA_ACCESS_CLASSIFICATIONS.internal,
  embedChat: DATA_ACCESS_CLASSIFICATIONS.user,
  embedConfig: DATA_ACCESS_CLASSIFICATIONS.user,
  eventLog: DATA_ACCESS_CLASSIFICATIONS.internal,
  externalCommunication: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  knowledgeGraph: DATA_ACCESS_CLASSIFICATIONS.user,
  mobile: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  nodeSupplement: DATA_ACCESS_CLASSIFICATIONS.user,
  quiz: DATA_ACCESS_CLASSIFICATIONS.user,
  readerLibrary: DATA_ACCESS_CLASSIFICATIONS.user,
  "reader-library": DATA_ACCESS_CLASSIFICATIONS.user,
  requestSigning: DATA_ACCESS_CLASSIFICATIONS.secret,
  scheduledJob: DATA_ACCESS_CLASSIFICATIONS.internal,
  sensitiveData: DATA_ACCESS_CLASSIFICATIONS.secret,
  slashCommandPreset: DATA_ACCESS_CLASSIFICATIONS.user,
  systemPatrol: DATA_ACCESS_CLASSIFICATIONS.internal,
  systemPromptVariable: DATA_ACCESS_CLASSIFICATIONS.user,
  telemetry: DATA_ACCESS_CLASSIFICATIONS.internal,
  user: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  userMemory: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  userState: DATA_ACCESS_CLASSIFICATIONS.user,
  vault: DATA_ACCESS_CLASSIFICATIONS.secret,
  wechatGatewayThread: DATA_ACCESS_CLASSIFICATIONS.sensitive,
  workspace: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceAgentInvocation: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceOverview: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceChat: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceChatCompaction: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceMindMap: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceParsedFile: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceSuggestedMessage: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceSupplement: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceThread: DATA_ACCESS_CLASSIFICATIONS.user,
  workspaceVisualAsset: DATA_ACCESS_CLASSIFICATIONS.user,
});

const USER_STATE_NAMESPACE_POLICIES = Object.freeze({
  "recent.navigation": {
    authority: "preference",
    description: "Last visited workspace/thread hints.",
  },
  "preferences.appearance": {
    authority: "preference",
    description: "Theme and visual preferences.",
  },
  "workspace.layout": {
    authority: "preference",
    description: "Workspace layout preferences.",
  },
  "workspace.order": {
    authority: "preference",
    description: "Workspace ordering preference only.",
  },
  "reader.progress": {
    authority: "progress",
    description: "Reader progress and last-position memory.",
  },
  "reader.library": {
    authority: "bootstrap-cache",
    businessAuthority: false,
    description:
      "Legacy reader shelf cache. May bootstrap DB once, but must not decide membership.",
  },
  "chat.draft": {
    authority: "draft",
    description: "Temporary draft state.",
  },
  "crypto.ui": {
    authority: "preference",
    description: "Crypto UI preferences only.",
  },
});

function compactString(value = "", max = 1024) {
  const next = String(value || "");
  return next.length > max ? next.slice(0, max) : next;
}

function compactOwnerScope(ownerScope = {}) {
  if (!ownerScope || typeof ownerScope !== "object") return null;
  return Object.fromEntries(
    Object.entries(ownerScope)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  );
}

function sanitizeValue(value, depth = 0) {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") return null;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_FIELD_KEY.test(key))
      .map(([key, item]) => [key, sanitizeValue(item, depth + 1)])
  );
}

function sanitizePatch(patch = {}) {
  return sanitizeValue(patch) || {};
}

function sanitizeItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => sanitizePatch(item));
}

function fieldClassification(key = "") {
  const text = String(key || "");
  if (SENSITIVE_FIELD_KEY.test(text)) return DATA_ACCESS_CLASSIFICATIONS.secret;
  if (/session|grant|reauth|vault|private|sensitive/i.test(text))
    return DATA_ACCESS_CLASSIFICATIONS.sensitive;
  if (/user|owner|workspace|thread|reader|document|chat/i.test(text))
    return DATA_ACCESS_CLASSIFICATIONS.user;
  return DATA_ACCESS_CLASSIFICATIONS.internal;
}

function domainClassification(domain = "") {
  return (
    DOMAIN_CLASSIFICATIONS[String(domain)] ||
    DATA_ACCESS_CLASSIFICATIONS.internal
  );
}

function sensitiveFieldSummary(value = {}, depth = 0, prefix = "") {
  if (!value || typeof value !== "object" || depth > 4) return [];
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
  return entries.flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const classification = fieldClassification(key);
    const current =
      classification === DATA_ACCESS_CLASSIFICATIONS.secret ||
      classification === DATA_ACCESS_CLASSIFICATIONS.sensitive
        ? [{ path, classification }]
        : [];
    return [
      ...current,
      ...(entry && typeof entry === "object"
        ? sensitiveFieldSummary(entry, depth + 1, path)
        : []),
    ];
  });
}

function revisionEnvelope(record = {}) {
  return {
    revision:
      record.revision ??
      record.mutationVersion ??
      record.version ??
      record.updatedAt ??
      record.lastUpdatedAt ??
      null,
    tombstone:
      Boolean(record.tombstone) ||
      Boolean(record.deleted) ||
      Boolean(record.deletedAt) ||
      record.status === "deleted",
  };
}

function accessAuditEnvelope({
  domain,
  operation,
  accessType = "read",
  ownerScope = null,
  payload = null,
} = {}) {
  const sensitiveFields = sensitiveFieldSummary(payload || {});
  return {
    domain,
    operation,
    accessType,
    classification:
      sensitiveFields.length > 0
        ? sensitiveFields.some(
            (field) =>
              field.classification === DATA_ACCESS_CLASSIFICATIONS.secret
          )
          ? DATA_ACCESS_CLASSIFICATIONS.secret
          : DATA_ACCESS_CLASSIFICATIONS.sensitive
        : domainClassification(domain),
    ownerScope: compactOwnerScope(ownerScope),
    sensitiveFields: sensitiveFields.slice(0, 20),
    revision:
      payload && typeof payload === "object" ? revisionEnvelope(payload) : null,
  };
}

function assertUserScope(userId, operation = "operation") {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId) || numericUserId <= 0) {
    const error = new Error(`DataAccessCenter ${operation} requires a userId.`);
    error.code = "DATA_ACCESS_USER_SCOPE_REQUIRED";
    throw error;
  }
  return numericUserId;
}

function namespacePolicy(namespace = "") {
  return USER_STATE_NAMESPACE_POLICIES[String(namespace)] || null;
}

function isUserStateBusinessAuthority(namespace = "") {
  const policy = namespacePolicy(namespace);
  return policy?.businessAuthority === true;
}

function userStateNamespaceSummary() {
  return Object.fromEntries(
    Object.entries(USER_STATE_NAMESPACE_POLICIES).map(([namespace, policy]) => [
      namespace,
      {
        authority: policy.authority,
        businessAuthority: policy.businessAuthority === true,
        description: policy.description,
      },
    ])
  );
}

function revisionValue(value = null) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : String(value);
}

function isStaleRevision({ currentRevision = null, incomingRevision = null }) {
  const current = revisionValue(currentRevision);
  const incoming = revisionValue(incomingRevision);
  if (current === null || incoming === null) return false;
  if (typeof current === "number" && typeof incoming === "number")
    return incoming < current;
  return String(incoming) < String(current);
}

module.exports = {
  DATA_ACCESS_CLASSIFICATIONS,
  DOMAIN_CLASSIFICATIONS,
  SENSITIVE_FIELD_KEY,
  USER_STATE_NAMESPACE_POLICIES,
  accessAuditEnvelope,
  assertUserScope,
  compactOwnerScope,
  compactString,
  domainClassification,
  fieldClassification,
  isStaleRevision,
  isUserStateBusinessAuthority,
  namespacePolicy,
  revisionEnvelope,
  sanitizeItems,
  sanitizePatch,
  sanitizeValue,
  sensitiveFieldSummary,
  userStateNamespaceSummary,
};
