function positiveId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error("sync_node_invalid_id");
  return parsed;
}

function encodeSegment(value) {
  return encodeURIComponent(String(value || "global"));
}

function decodeSegment(value) {
  return decodeURIComponent(String(value || "global"));
}

const STARTUP_PREFERENCE_POLICIES = Object.freeze({
  "preferences.appearance": {
    hydration: "eager",
    hydrationTier: "boot-critical",
    costClass: "small",
  },
  "recent.navigation": {
    hydration: "eager",
    hydrationTier: "navigation",
    costClass: "small",
  },
  "workspace.order": {
    hydration: "eager",
    hydrationTier: "navigation",
    costClass: "small",
  },
  "ios.drawer.pins": {
    hydration: "eager",
    hydrationTier: "navigation",
    costClass: "small",
  },
});

function preferenceNodePolicy(namespace) {
  return (
    STARTUP_PREFERENCE_POLICIES[String(namespace)] || {
      hydration: "lazy",
      hydrationTier: "route",
      // Preference namespaces are extensible and their values are not bounded
      // by the registry. Treat unknown/screen-specific values as potentially
      // linear so they cannot silently expand the startup envelope.
      costClass: "linear",
    }
  );
}

const nodeKeys = Object.freeze({
  userProfile: (userId) => `users/${positiveId(userId)}/profile`,
  userPreferences: (userId, namespace, scope = "global") =>
    `users/${positiveId(userId)}/preferences/${encodeSegment(
      namespace
    )}/${encodeSegment(scope)}`,
  userWorkspacesIndex: (userId) =>
    `users/${positiveId(userId)}/workspaces/index`,
  userSecurityClients: (userId) =>
    `users/${positiveId(userId)}/security/clients`,
  userSecuritySessions: (userId) =>
    `users/${positiveId(userId)}/security/sessions`,
  userSecurityPasskeys: (userId) =>
    `users/${positiveId(userId)}/security/passkeys`,
  userSecurityPolicies: (userId) =>
    `users/${positiveId(userId)}/security/policies`,
  userMemory: (userId, kind) =>
    `users/${positiveId(userId)}/memory/${encodeSegment(kind)}`,
  userNotifications: (userId) => `users/${positiveId(userId)}/notifications`,
  userEntitlements: (userId) => `users/${positiveId(userId)}/entitlements`,
  userIntegrations: (userId) => `users/${positiveId(userId)}/integrations`,
  workspaceMetadata: (workspaceId) =>
    `workspaces/${positiveId(workspaceId)}/metadata`,
  workspaceMembers: (workspaceId) =>
    `workspaces/${positiveId(workspaceId)}/members`,
  workspacePermissions: (workspaceId) =>
    `workspaces/${positiveId(workspaceId)}/permissions`,
  workspaceThreadsIndex: (workspaceId) =>
    `workspaces/${positiveId(workspaceId)}/threads/index`,
  workspaceDomain: (workspaceId, domain) =>
    `workspaces/${positiveId(workspaceId)}/${encodeSegment(domain)}`,
  threadMetadata: (threadId) => `threads/${positiveId(threadId)}/metadata`,
  threadMessages: (threadId) => `threads/${positiveId(threadId)}/messages`,
  threadDomain: (threadId, domain) =>
    `threads/${positiveId(threadId)}/${encodeSegment(domain)}`,
});

const definitions = [
  {
    kind: "user-profile",
    pattern: /^users\/(\d+)\/profile$/,
    ownerType: "user",
    visibility: "user",
    hydrationTier: "boot-critical",
    payloadMode: "apply-payload",
    costClass: "small",
  },
  {
    kind: "user-preferences",
    pattern: /^users\/(\d+)\/preferences\/([^/]+)\/([^/]+)$/,
    ownerType: "user",
    visibility: "user",
    payloadMode: "apply-payload",
  },
  {
    kind: "user-workspaces-index",
    pattern: /^users\/(\d+)\/workspaces\/index$/,
    ownerType: "user",
    visibility: "user",
    hydrationTier: "navigation",
    payloadMode: "apply-payload",
    costClass: "indexed",
  },
  {
    kind: "user-security-clients",
    pattern: /^users\/(\d+)\/security\/clients$/,
    ownerType: "user",
    visibility: "user",
    verifiedCacheOnly: true,
    consistency: "version-hash",
    hydration: "lazy",
    hydrationTier: "route",
    payloadMode: "security-revalidate",
    costClass: "indexed",
  },
  ...["sessions", "passkeys", "policies"].map((domain) => ({
    kind: `user-security-${domain}`,
    pattern: new RegExp(`^users\\/(\\d+)\\/security\\/${domain}$`),
    ownerType: "user",
    visibility: "user",
    verifiedCacheOnly: true,
    consistency: domain === "sessions" ? "event-cursor" : "version-hash",
    hydration: domain === "policies" ? "eager" : "lazy",
    hydrationTier: domain === "policies" ? "boot-critical" : "route",
    payloadMode: "security-revalidate",
    costClass: domain === "policies" ? "small" : "indexed",
  })),
  ...["candidates", "structured", "persona"].map((domain) => ({
    kind: `user-memory-${domain}`,
    pattern: new RegExp(`^users\\/(\\d+)\\/memory\\/${domain}$`),
    ownerType: "user",
    visibility: "user",
    consistency: domain === "candidates" ? "event-cursor" : "version-hash",
    hydration: "lazy",
    hydrationTier: domain === "candidates" ? "background" : "route",
    payloadMode: domain === "candidates" ? "invalidate-only" : "apply-payload",
    costClass: domain === "structured" ? "linear" : "indexed",
  })),
  ...["notifications", "entitlements", "integrations"].map((domain) => ({
    kind: `user-${domain}`,
    pattern: new RegExp(`^users\\/(\\d+)\\/${domain}$`),
    ownerType: "user",
    visibility: "user",
    consistency: domain === "notifications" ? "event-cursor" : "version-hash",
    verifiedCacheOnly: domain === "entitlements",
    hydration: domain === "entitlements" ? "eager" : "lazy",
    hydrationTier:
      domain === "entitlements"
        ? "boot-critical"
        : domain === "notifications"
          ? "background"
          : "route",
    payloadMode:
      domain === "entitlements"
        ? "security-revalidate"
        : domain === "notifications"
          ? "invalidate-only"
          : "apply-payload",
    costClass: "small",
  })),
  {
    kind: "workspace-metadata",
    pattern: /^workspaces\/(\d+)\/metadata$/,
    ownerType: "workspace",
    visibility: "workspace",
    hydrationTier: "navigation",
    payloadMode: "apply-payload",
    costClass: "small",
  },
  ...[
    "documents",
    "document-status",
    "cognition",
    "agents",
    "meetings",
    "tasks",
    "workflows",
  ].map((domain) => ({
    kind: `workspace-${domain}`,
    pattern: new RegExp(`^workspaces\\/(\\d+)\\/${domain}$`),
    ownerType: "workspace",
    visibility: "workspace",
    consistency: [
      "cognition",
      "agents",
      "meetings",
      "tasks",
      "workflows",
      "document-status",
    ].includes(domain)
      ? "event-cursor"
      : "version-hash",
    hydration: "lazy",
    hydrationTier: "background",
    payloadMode: domain === "documents" ? "apply-payload" : "invalidate-only",
    costClass: domain === "documents" ? "linear" : "indexed",
  })),
  {
    kind: "workspace-members",
    pattern: /^workspaces\/(\d+)\/members$/,
    ownerType: "workspace",
    visibility: "workspace",
    verifiedCacheOnly: true,
    hydration: "lazy",
    hydrationTier: "route",
    payloadMode: "security-revalidate",
    costClass: "linear",
  },
  {
    kind: "workspace-permissions",
    pattern: /^workspaces\/(\d+)\/permissions$/,
    ownerType: "workspace",
    visibility: "workspace",
    verifiedCacheOnly: true,
    hydration: "lazy",
    hydrationTier: "route",
    payloadMode: "security-revalidate",
    costClass: "linear",
  },
  {
    kind: "workspace-threads-index",
    pattern: /^workspaces\/(\d+)\/threads\/index$/,
    ownerType: "workspace",
    visibility: "workspace",
    // The authorized projection contains private and shared threads, so users
    // can legitimately see different lists for the same workspace route.
    consistency: "version-only",
    hydrationTier: "navigation",
    payloadMode: "apply-payload",
    costClass: "linear",
  },
  {
    kind: "thread-metadata",
    pattern: /^threads\/(\d+)\/metadata$/,
    ownerType: "thread",
    visibility: "thread",
    hydration: "lazy",
    hydrationTier: "route",
    payloadMode: "apply-payload",
    costClass: "small",
  },
  {
    kind: "thread-messages",
    pattern: /^threads\/(\d+)\/messages$/,
    ownerType: "thread",
    visibility: "thread",
    consistency: "event-cursor",
    hydration: "lazy",
    hydrationTier: "route",
    payloadMode: "invalidate-only",
    costClass: "indexed",
  },
  ...["read-state", "drafts", "attachments"].map((domain) => ({
    kind: `thread-${domain}`,
    pattern: new RegExp(`^threads\\/(\\d+)\\/${domain}$`),
    ownerType: "thread",
    visibility: "thread",
    hydration: "lazy",
    consistency:
      domain === "read-state"
        ? "monotonic-cursor"
        : domain === "drafts"
          ? "version-merge"
          : "event-cursor",
    hydrationTier: "route",
    payloadMode: domain === "drafts" ? "apply-payload" : "invalidate-only",
    costClass: "small",
  })),
];

function classifyNodeKey(nodeKey) {
  const normalized = String(nodeKey || "").trim();
  for (const definition of definitions) {
    const match = normalized.match(definition.pattern);
    if (!match) continue;
    const ownerId = positiveId(match[1]);
    const namespace =
      definition.kind === "user-preferences" ? decodeSegment(match[2]) : null;
    const policy =
      definition.kind === "user-preferences"
        ? { ...definition, ...preferenceNodePolicy(namespace) }
        : definition;
    const hydration = policy.hydration || "eager";
    return {
      ...policy,
      consistency: policy.consistency || "version-hash",
      hydration,
      hydrationTier:
        policy.hydrationTier || (hydration === "lazy" ? "route" : "navigation"),
      payloadMode:
        policy.payloadMode ||
        (policy.verifiedCacheOnly ? "security-revalidate" : "apply-payload"),
      costClass: policy.costClass || "small",
      materializeOnManifest:
        policy.materializeOnManifest ?? hydration !== "lazy",
      nodeKey: normalized,
      ownerId,
      namespace,
      scope:
        definition.kind === "user-preferences" ? decodeSegment(match[3]) : null,
    };
  }
  return null;
}

function parentKeyFor(nodeKey) {
  const parts = String(nodeKey || "").split("/");
  if (parts.length <= 2) return null;
  return parts.slice(0, -1).join("/");
}

module.exports = {
  classifyNodeKey,
  definitions,
  nodeKeys,
  parentKeyFor,
  preferenceNodePolicy,
};
