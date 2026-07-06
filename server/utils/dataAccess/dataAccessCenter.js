const { ReaderDataAuthority } = require("../../models/readerDataAuthority");
const {
  accessAuditEnvelope,
  assertUserScope,
  compactOwnerScope,
  isStaleRevision,
  userStateNamespaceSummary,
} = require("./dataAccessPolicy");
const {
  sanitizeReaderLibraryItems,
  sanitizeReaderLibraryPatch,
} = require("./readerLibraryPolicy");
const {
  assertMigrationCompliance,
  dataAccessMode,
  recordBypassAccess,
  resetForTests: resetMigrationGuardForTests,
  runtimeBypassSnapshot,
  scanBypassAccess,
} = require("./dataAccessMigrationGuard");

const MAX_RECENT_OPERATIONS = 80;

const repositoryLoaders = {
  adminSystem: () => require("../../repositories/adminSystemRepository"),
  agentSkillWhitelist: () =>
    require("../../repositories/agentSkillWhitelistRepository"),
  accountDeletion: () =>
    require("../../repositories/accountDeletionRepository"),
  authIdentity: () => require("../../repositories/authIdentityRepository"),
  clientIdentity: () => require("../../repositories/clientIdentityRepository"),
  crypto: () => require("../../repositories/cryptoRepository"),
  document: () => require("../../repositories/documentRepository"),
  documentEmbeddingBatch: () =>
    require("../../repositories/documentEmbeddingBatchRepository"),
  documentIndexStatus: () =>
    require("../../repositories/documentIndexStatusRepository"),
  documentVector: () => require("../../repositories/documentVectorRepository"),
  embedChat: () => require("../../repositories/embedChatRepository"),
  eventLog: () => require("../../repositories/eventLogRepository"),
  externalCommunication: () =>
    require("../../repositories/externalCommunicationRepository"),
  knowledgeGraph: () => require("../../repositories/knowledgeGraphRepository"),
  quiz: () => require("../../repositories/quizRepository"),
  readerLibrary: () => require("../../repositories/readerLibraryRepository"),
  requestSigning: () => require("../../repositories/requestSigningRepository"),
  sensitiveData: () => require("../../repositories/sensitiveDataRepository"),
  slashCommandPreset: () =>
    require("../../repositories/slashCommandPresetRepository"),
  systemPromptVariable: () =>
    require("../../repositories/systemPromptVariableRepository"),
  systemPatrol: () => require("../../repositories/systemPatrolRepository"),
  telemetry: () => require("../../repositories/telemetryRepository"),
  user: () => require("../../repositories/userRepository"),
  userMemory: () => require("../../repositories/userMemoryRepository"),
  userState: () => require("../../repositories/userStateRepository"),
  workspace: () => require("../../repositories/workspaceRepository"),
  workspaceAgentInvocation: () =>
    require("../../repositories/workspaceAgentInvocationRepository"),
  workspaceChat: () => require("../../repositories/workspaceChatRepository"),
  workspaceChatCompaction: () =>
    require("../../repositories/workspaceChatCompactionRepository"),
  workspaceOverview: () =>
    require("../../repositories/workspaceOverviewRepository"),
  workspaceParsedFile: () =>
    require("../../repositories/workspaceParsedFileRepository"),
  workspaceThread: () =>
    require("../../repositories/workspaceThreadRepository"),
  vault: () => require("../../repositories/vaultRepository"),
};

const repositoryExports = {
  adminSystem: "AdminSystemRepository",
  agentSkillWhitelist: "AgentSkillWhitelistRepository",
  accountDeletion: "AccountDeletionRepository",
  authIdentity: "AuthIdentityRepository",
  clientIdentity: "ClientIdentityRepository",
  crypto: "CryptoRepository",
  document: "DocumentRepository",
  documentEmbeddingBatch: "DocumentEmbeddingBatchRepository",
  documentIndexStatus: "DocumentIndexStatusRepository",
  documentVector: "DocumentVectorRepository",
  embedChat: "EmbedChatRepository",
  eventLog: "EventLogRepository",
  externalCommunication: "ExternalCommunicationRepository",
  knowledgeGraph: "KnowledgeGraphRepository",
  quiz: "QuizRepository",
  readerLibrary: "ReaderLibraryRepository",
  requestSigning: "RequestSigningRepository",
  sensitiveData: "SensitiveDataRepository",
  slashCommandPreset: "SlashCommandPresetRepository",
  systemPromptVariable: "SystemPromptVariableRepository",
  systemPatrol: "SystemPatrolRepository",
  telemetry: "TelemetryRepository",
  user: "UserRepository",
  userMemory: "UserMemoryRepository",
  userState: "UserStateRepository",
  workspace: "WorkspaceRepository",
  workspaceAgentInvocation: "WorkspaceAgentInvocationRepository",
  workspaceChat: "WorkspaceChatRepository",
  workspaceChatCompaction: "WorkspaceChatCompactionRepository",
  workspaceOverview: "WorkspaceOverviewRepository",
  workspaceParsedFile: "WorkspaceParsedFileRepository",
  workspaceThread: "WorkspaceThreadRepository",
  vault: "VaultRepository",
};

const stats = {
  total: 0,
  failed: 0,
  byDomain: {},
  byAccessType: {},
  byClassification: {},
  recent: [],
};

function increment(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function recordOperation({
  domain,
  operation,
  accessType,
  ownerScope = null,
  success,
  durationMs,
  error = null,
}) {
  const audit = accessAuditEnvelope({
    domain,
    operation,
    accessType,
    ownerScope,
  });
  stats.total += 1;
  if (!success) stats.failed += 1;
  increment(stats.byDomain, domain);
  increment(stats.byAccessType, accessType);
  increment(stats.byClassification, audit.classification);
  stats.recent.unshift({
    at: new Date().toISOString(),
    domain,
    operation,
    accessType,
    classification: audit.classification,
    ownerScope: compactOwnerScope(ownerScope),
    success,
    durationMs,
    errorCode: error?.code || null,
    errorMessage: error?.message ? String(error.message).slice(0, 160) : null,
  });
  stats.recent = stats.recent.slice(0, MAX_RECENT_OPERATIONS);
}

async function runAccess({
  domain,
  operation,
  accessType = "read",
  ownerScope = null,
  fn,
}) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    recordOperation({
      domain,
      operation,
      accessType,
      ownerScope,
      success: true,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    recordOperation({
      domain,
      operation,
      accessType,
      ownerScope,
      success: false,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

function readerOwnerScope(userId) {
  return { userId: assertUserScope(userId, "reader-library.ownerScope") };
}

function repositoryModule(domain) {
  const loader = repositoryLoaders[domain];
  if (!loader) {
    const error = new Error(`Unknown data access repository domain: ${domain}`);
    error.code = "DATA_ACCESS_REPOSITORY_NOT_FOUND";
    throw error;
  }
  return loader();
}

function repositoryObject(domain) {
  const module = repositoryModule(domain);
  const exportName = repositoryExports[domain];
  const repository = module?.[exportName];
  if (!repository) {
    const error = new Error(
      `Repository export not found for domain: ${domain}`
    );
    error.code = "DATA_ACCESS_REPOSITORY_EXPORT_NOT_FOUND";
    throw error;
  }
  return repository;
}

function storageAdapterRegistry() {
  return require("../../providers/storage/storageAdapterRegistry")
    .StorageAdapterRegistry;
}

function clauseScope(clause = {}) {
  if (!clause || typeof clause !== "object") return null;
  return {
    id: clause.id,
    slug: clause.slug,
    workspaceId: clause.workspaceId || clause.workspace_id,
    userId: clause.userId || clause.user_id,
    threadId: clause.threadId || clause.thread_id,
    docId: clause.docId,
    filePath: clause.filePath,
  };
}

function workspaceScopeFromArgs(method, args = []) {
  if (method === "new") return { name: args[0], creatorId: args[1] };
  if (method === "update") return { id: args[0] };
  if (method === "_update") return { id: args[0] };
  if (method === "workspaceUsers") return { workspaceId: args[0] };
  if (method === "updateUsers") return { workspaceId: args[0] };
  if (method === "promptHistory") return { workspaceId: args[0]?.workspaceId };
  if (method === "deleteAllPromptHistory")
    return { workspaceId: args[0]?.workspaceId };
  if (method === "deletePromptHistory")
    return { workspaceId: args[0]?.workspaceId, id: args[0]?.id };
  return clauseScope(args[0]);
}

function workspaceThreadScopeFromArgs(method, args = []) {
  if (method === "new") {
    return {
      workspaceId: args[0]?.id,
      workspaceSlug: args[0]?.slug,
      userId: args[1],
      threadType: args[2]?.thread_type,
    };
  }
  if (method === "update") {
    return {
      id: args[0]?.id,
      slug: args[0]?.slug,
      workspaceId: args[0]?.workspace_id,
    };
  }
  if (method === "withLastChatActivity") {
    return {
      count: Array.isArray(args[0]) ? args[0].length : 0,
      workspaceId: args[1],
      userId: args[2],
    };
  }
  if (method === "ensureDefaultThreads" || method === "ensureOverviewThread") {
    return {
      workspaceId: args[0]?.id,
      workspaceSlug: args[0]?.slug,
      userId: args[1],
    };
  }
  if (method === "moveToWorkspace") {
    const options = args[0] || {};
    return {
      threadId: options.thread?.id,
      sourceWorkspaceId: options.sourceWorkspace?.id,
      targetWorkspaceId: options.targetWorkspace?.id,
    };
  }
  if (
    method === "markTitleGenerationPending" ||
    method === "markTitleGenerationFailed" ||
    method === "titleMetadataSchemaReady"
  ) {
    return { threadId: args[0], scope: args[1] };
  }
  if (method === "updateAutomaticTitle") {
    return { threadId: args[0]?.threadId, workspaceId: args[0]?.workspaceId };
  }
  return clauseScope(args[0]);
}

function documentScopeFromArgs(method, args = []) {
  if (method === "forWorkspace") return { workspaceId: args[0] };
  if (method === "addDocuments") {
    return {
      workspaceId: args[0]?.id,
      workspaceSlug: args[0]?.slug,
      userId: args[2],
      count: Array.isArray(args[1]) ? args[1].length : 0,
    };
  }
  if (method === "removeDocuments") {
    return {
      workspaceId: args[0]?.id,
      workspaceSlug: args[0]?.slug,
      userId: args[2],
      count: Array.isArray(args[1]) ? args[1].length : 0,
    };
  }
  if (method === "update") return { id: args[0] };
  if (method === "count") return clauseScope(args[0]);
  return clauseScope(args[0]);
}

function documentVectorScopeFromArgs(method, args = []) {
  if (method === "bulkInsert") {
    return {
      count: Array.isArray(args[0]) ? args[0].length : 0,
      docIds: Array.isArray(args[0])
        ? [...new Set(args[0].map((row) => row.docId).filter(Boolean))]
            .slice(0, 12)
            .join(",")
        : null,
    };
  }
  if (method === "deleteForWorkspace") return { workspaceId: args[0] };
  if (method === "deleteIds") {
    return { count: Array.isArray(args[0]) ? args[0].length : 0 };
  }
  return clauseScope(args[0]);
}

function workspaceChatScopeFromArgs(method, args = []) {
  if (method === "new") {
    const options = args[0] || {};
    return {
      workspaceId: options.workspaceId,
      userId: options.user?.id,
      threadId: options.threadId,
      apiSessionId: options.apiSessionId,
    };
  }
  if (
    method === "forWorkspaceByUser" ||
    method === "forWorkspaceByApiSessionId"
  ) {
    return { workspaceId: args[0], userId: args[1], apiSessionId: args[1] };
  }
  if (method === "forWorkspace") return { workspaceId: args[0] };
  if (method === "markHistoryInvalid") {
    return { workspaceId: args[0], userId: args[1]?.id };
  }
  if (method === "markThreadHistoryInvalid") {
    return { workspaceId: args[0], userId: args[1]?.id, threadId: args[2] };
  }
  if (method === "updateFeedbackScore" || method === "_update") {
    return { chatId: args[0] };
  }
  if (method === "bulkCreate") {
    return { count: Array.isArray(args[0]) ? args[0].length : 0 };
  }
  if (method === "upsert") {
    const data = args[1] || {};
    return {
      chatId: args[0],
      workspaceId: data.workspaceId,
      userId: data.user?.id,
      threadId: data.threadId,
      apiSessionId: data.apiSessionId,
    };
  }
  return clauseScope(args[0]);
}

function documentIndexStatusScopeFromArgs(method, args = []) {
  if (method === "forWorkspace") return { workspaceId: args[0] };
  if (method === "forFilePaths") {
    return {
      fileCount: Array.isArray(args[0]) ? args[0].length : 0,
      workspaceId: args[1],
    };
  }
  return clauseScope(args[0]);
}

function parsedFileScopeFromArgs(method, args = []) {
  if (method === "moveToDocumentsAndEmbed") {
    return {
      userId: args[0]?.id,
      fileId: args[1],
      workspaceId: args[2]?.id,
      workspaceSlug: args[2]?.slug,
    };
  }
  if (method === "getContextMetadataAndLimits") {
    return {
      workspaceId: args[0]?.id,
      workspaceSlug: args[0]?.slug,
      threadId: args[1]?.id,
      userId: args[2]?.id,
    };
  }
  if (method === "getContextFiles") {
    return {
      workspaceId: args[0]?.id,
      workspaceSlug: args[0]?.slug,
      threadId: args[1]?.id,
      userId: args[2]?.id,
    };
  }
  if (method === "totalTokenCount") return clauseScope(args[0]);
  return clauseScope(args[0]);
}

function userScopeFromArgs(method, args = []) {
  if (method === "create") {
    return { username: args[0]?.username, originEnv: args[0]?.originEnv };
  }
  if (method === "update" || method === "_update") return { userId: args[0] };
  if (method === "canSendChat") return { userId: args[0]?.id };
  return clauseScope(args[0]);
}

function userMemoryScopeFromArgs(method, args = []) {
  if (method === "memoryOwnerIdFromSessionUser")
    return { userId: args[0]?.id, authUserId: args[0]?.authUserId };
  return { userId: args[0], memoryId: args[1] };
}

function workspaceAgentInvocationScopeFromArgs(method, args = []) {
  if (method === "new") {
    const options = args[0] || {};
    return {
      workspaceId: options.workspace?.id,
      workspaceSlug: options.workspace?.slug,
      userId: options.user?.id,
      threadId: options.thread?.id,
    };
  }
  if (method === "close") return { invocationUuid: args[0] };
  return clauseScope(args[0]);
}

function workspaceChatCompactionScopeFromArgs(method, args = []) {
  const scope = args[0] || {};
  return {
    workspaceId: scope.workspace_id || scope.workspaceId,
    userId: scope.user_id,
    threadId: scope.thread_id,
    apiSessionId: scope.api_session_id,
  };
}

function slashCommandPresetScopeFromArgs(method, args = []) {
  if (method === "create" || method === "getUserPresets")
    return { userId: args[0] };
  if (method === "update" || method === "delete") return { presetId: args[0] };
  return clauseScope(args[0]);
}

function systemPromptVariableScopeFromArgs(method, args = []) {
  if (method === "get") return { key: args[0] };
  if (method === "getAll") return { userId: args[0] };
  if (method === "create")
    return { key: args[0]?.key, userId: args[0]?.userId };
  if (method === "update" || method === "delete") return { id: args[0] };
  if (method === "expandSystemPromptVariables")
    return { userId: args[1], workspaceId: args[2] };
  return clauseScope(args[0]);
}

function agentSkillWhitelistScopeFromArgs(method, args = []) {
  if (method === "get" || method === "clearSingleUserWhitelist")
    return { userId: args[0] };
  return { skillName: args[0], userId: args[1] };
}

function embedChatScopeFromArgs(method, args = []) {
  if (method === "new") {
    const options = args[0] || {};
    return { embedId: options.embedId, sessionId: options.sessionId };
  }
  if (method === "forEmbedByUser" || method === "markHistoryInvalid")
    return { embedId: args[0], sessionId: args[1] };
  return clauseScope(args[0]);
}

function externalCommunicationScopeFromArgs(method, args = []) {
  return { type: args[0], operation: method };
}

function repositoryBoundaryScopeFromArgs(method, args = []) {
  return {
    operation: method,
    firstArg:
      args[0] && typeof args[0] === "object"
        ? clauseScope(args[0])
        : args[0] === undefined
          ? null
          : String(args[0]).slice(0, 120),
  };
}

function userStateScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  if (method === "upsertMany") {
    return {
      userId: options.userId,
      namespaces: Array.isArray(options.states)
        ? options.states.map((state) => state.namespace).join(",")
        : null,
      count: Array.isArray(options.states) ? options.states.length : 0,
    };
  }
  return {
    userId: options.userId,
    namespace: options.namespace,
    scope: options.scope,
    namespaces: Array.isArray(options.namespaces)
      ? options.namespaces.join(",")
      : null,
  };
}

function authIdentityScopeFromArgs(method, args = []) {
  if (method === "findById") return { authUserId: args[0] };
  if (method === "findByLoginIdentifier") return { identifier: args[0] };
  if (method === "ensureShadowUser") return { authUserId: args[0]?.id };
  if (method === "shadowForAuthUser") return { authUserId: args[0]?.id };
  if (method === "authForShadowUser") return { userId: args[0]?.id };
  return clauseScope(args[0]);
}

function adminSystemScopeFromArgs(method, args = []) {
  if (method === "get" || method === "getSetting" || method === "deleteSetting")
    return { label: args[0]?.label || args[0] };
  if (method === "getValueOrFallback")
    return { label: args[0]?.label, fallback: args[1] };
  if (method === "updateSettings" || method === "_updateSettings") {
    return {
      labels: Object.keys(args[0] || {})
        .slice(0, 20)
        .join(","),
    };
  }
  if (method === "eventLogs")
    return { event: args[0]?.event, userId: args[0]?.userId };
  if (method === "deleteEventLogs") return clauseScope(args[0]);
  if (method === "patrolRun") return { mode: args[0]?.mode };
  return clauseScope(args[0]);
}

function cryptoScopeFromArgs(method, args = []) {
  if (method === "recentEvents") return { limit: args[0]?.limit };
  return { provider: "gate", resource: method };
}

function vaultScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  return {
    userId: options.userId,
    itemId: options.itemId,
    itemType: options.itemType,
  };
}

function sensitiveDataScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  return {
    userId: options.userId,
    clientId: options.clientId,
    resourceType: options.resourceType,
  };
}

function makeRepositoryMethod({
  domain,
  method,
  accessType = "read",
  ownerScope,
}) {
  return (...args) =>
    runAccess({
      domain,
      operation: method,
      accessType,
      ownerScope:
        typeof ownerScope === "function"
          ? ownerScope(method, args)
          : ownerScope,
      fn: async () => {
        const repository = repositoryObject(domain);
        const target = repository[method];
        if (typeof target !== "function") {
          const error = new Error(
            `Repository method not found: ${domain}.${method}`
          );
          error.code = "DATA_ACCESS_REPOSITORY_METHOD_NOT_FOUND";
          throw error;
        }
        return await target.apply(repository, args);
      },
    });
}

function makeRepositoryFacade(domain, methods = {}, ownerScope) {
  return Object.fromEntries(
    Object.entries(methods).map(([method, accessType]) => [
      method,
      makeRepositoryMethod({ domain, method, accessType, ownerScope }),
    ])
  );
}

const readerLibrary = {
  listLibrary(options = {}) {
    const userId = assertUserScope(options.userId, "listLibrary");
    return runAccess({
      domain: "reader-library",
      operation: "listLibrary",
      accessType: "read",
      ownerScope: { userId },
      fn: () => ReaderDataAuthority.listLibrary({ ...options, userId }),
    });
  },

  bootstrap(options = {}) {
    const userId = assertUserScope(options.userId, "bootstrap");
    return runAccess({
      domain: "reader-library",
      operation: "bootstrap",
      accessType: "write",
      ownerScope: { userId },
      fn: () =>
        ReaderDataAuthority.bootstrap({
          ...options,
          userId,
          bookshelf: sanitizeReaderLibraryItems(options.bookshelf || []),
          categories: sanitizeReaderLibraryItems(options.categories || []),
        }),
    });
  },

  patchItem(options = {}) {
    const userId = assertUserScope(options.userId, "patchItem");
    return runAccess({
      domain: "reader-library",
      operation: "patchItem",
      accessType: "write",
      ownerScope: { userId, itemId: options.itemId },
      fn: () =>
        ReaderDataAuthority.patchItem({
          ...options,
          userId,
          patch: sanitizeReaderLibraryPatch(options.patch || {}),
        }),
    });
  },

  softDeleteItem(options = {}) {
    const userId = assertUserScope(options.userId, "softDeleteItem");
    return runAccess({
      domain: "reader-library",
      operation: "softDeleteItem",
      accessType: "write",
      ownerScope: { userId, itemId: options.itemId },
      fn: () => ReaderDataAuthority.softDeleteItem({ ...options, userId }),
    });
  },

  restoreItem(options = {}) {
    const userId = assertUserScope(options.userId, "restoreItem");
    return runAccess({
      domain: "reader-library",
      operation: "restoreItem",
      accessType: "write",
      ownerScope: { userId, itemId: options.itemId },
      fn: () => ReaderDataAuthority.restoreItem({ ...options, userId }),
    });
  },

  patchCategory(options = {}) {
    const userId = assertUserScope(options.userId, "patchCategory");
    return runAccess({
      domain: "reader-library",
      operation: "patchCategory",
      accessType: "write",
      ownerScope: { userId, categoryId: options.categoryId },
      fn: () =>
        ReaderDataAuthority.patchCategory({
          ...options,
          userId,
          patch: sanitizeReaderLibraryPatch(options.patch || {}),
        }),
    });
  },

  reconcileCatalog(options = {}) {
    const userId = assertUserScope(options.userId, "reconcileCatalog");
    return runAccess({
      domain: "reader-library",
      operation: "reconcileCatalog",
      accessType: "maintenance",
      ownerScope: { userId, workspaceSlug: options.workspaceSlug },
      fn: () =>
        ReaderDataAuthority.reconcileCatalog({
          ...options,
          userId,
          documents: sanitizeReaderLibraryItems(options.documents || []),
        }),
    });
  },

  snapshot(options = {}) {
    const userId = assertUserScope(options.userId, "snapshot");
    return runAccess({
      domain: "reader-library",
      operation: "snapshot",
      accessType: "read",
      ownerScope: { userId },
      fn: () => ReaderDataAuthority.snapshot({ ...options, userId }),
    });
  },
};

const workspace = makeRepositoryFacade(
  "workspace",
  {
    get: "read",
    getWithUser: "read",
    _findFirst: "read",
    _findMany: "read",
    where: "read",
    whereWithUser: "read",
    whereWithUsers: "read",
    workspaceUsers: "read",
    promptHistory: "read",
    supportsNativeToolCalling: "read",
    isAgentCommandAvailable: "read",
    new: "write",
    update: "write",
    _update: "write",
    updateUsers: "write",
    trackChange: "write",
    deleteAllPromptHistory: "write",
    deletePromptHistory: "write",
    upsert: "write",
    delete: "write",
    count: "read",
  },
  workspaceScopeFromArgs
);

const workspaceThread = {
  ...makeRepositoryFacade(
    "workspaceThread",
    {
      withLastChatActivity: "read",
      ensureDefaultThreads: "write",
      ensureOverviewThread: "write",
      get: "read",
      where: "read",
      new: "write",
      update: "write",
      moveToWorkspace: "write",
      delete: "write",
      markTitleGenerationPending: "write",
      markTitleGenerationFailed: "write",
      updateAutomaticTitle: "write",
      titleMetadataSchemaReady: "read",
    },
    workspaceThreadScopeFromArgs
  ),
  get THREAD_TYPES() {
    return repositoryObject("workspaceThread").THREAD_TYPES;
  },
  get THREAD_CREATED_FROM() {
    return repositoryObject("workspaceThread").THREAD_CREATED_FROM;
  },
  get defaultName() {
    return repositoryObject("workspaceThread").defaultName;
  },
  get defaultChatName() {
    return repositoryObject("workspaceThread").defaultChatName;
  },
  get overviewName() {
    return repositoryObject("workspaceThread").overviewName;
  },
  withDisplayTitle(thread = null) {
    return repositoryObject("workspaceThread").withDisplayTitle(thread);
  },
  isOverviewThread(thread = null) {
    return repositoryObject("workspaceThread").isOverviewThread(thread);
  },
  sortForDisplay(threads = []) {
    return repositoryObject("workspaceThread").sortForDisplay(threads);
  },
};

const workspaceChat = makeRepositoryFacade(
  "workspaceChat",
  {
    forWorkspaceByUser: "read",
    forWorkspaceByApiSessionId: "read",
    forWorkspace: "read",
    get: "read",
    where: "read",
    whereMetadata: "read",
    count: "read",
    whereWithData: "read",
    new: "write",
    markHistoryInvalid: "write",
    markThreadHistoryInvalid: "write",
    markThreadHistoryInvalidV2: "write",
    delete: "write",
    updateFeedbackScore: "write",
    _update: "write",
    bulkCreate: "write",
    upsert: "write",
  },
  workspaceChatScopeFromArgs
);

const document = makeRepositoryFacade(
  "document",
  {
    get: "read",
    where: "read",
    forWorkspace: "read",
    count: "read",
    content: "read",
    contentByDocPath: "read",
    addDocuments: "write",
    removeDocuments: "write",
    update: "write",
    _updateAll: "write",
    delete: "write",
  },
  documentScopeFromArgs
);

const documentVector = makeRepositoryFacade(
  "documentVector",
  {
    where: "read",
    bulkInsert: "write",
    deleteForWorkspace: "write",
    deleteIds: "write",
    delete: "write",
  },
  documentVectorScopeFromArgs
);

const documentIndexStatus = {
  ...makeRepositoryFacade(
    "documentIndexStatus",
    {
      where: "read",
      forWorkspace: "read",
      forFilePaths: "read",
      manualUpdate: "write",
      upsertPending: "write",
      markIndexing: "write",
      markIndexed: "write",
      markFailed: "write",
      markDeleted: "write",
    },
    documentIndexStatusScopeFromArgs
  ),
  get statuses() {
    return repositoryObject("documentIndexStatus").statuses;
  },
  get validStatuses() {
    return repositoryObject("documentIndexStatus").validStatuses;
  },
};

const workspaceParsedFile = makeRepositoryFacade(
  "workspaceParsedFile",
  {
    get: "read",
    where: "read",
    getContextFiles: "read",
    getContextMetadataAndLimits: "read",
    totalTokenCount: "read",
    create: "write",
    delete: "write",
    moveToDocumentsAndEmbed: "write",
  },
  parsedFileScopeFromArgs
);

const user = makeRepositoryFacade(
  "user",
  {
    get: "read",
    _get: "read",
    where: "read",
    _where: "read",
    count: "read",
    canSendChat: "read",
    create: "write",
    update: "write",
    _update: "write",
    delete: "write",
  },
  userScopeFromArgs
);

const userMemory = {
  ...makeRepositoryFacade(
    "userMemory",
    {
      createCandidate: "write",
      createSensitiveMemory: "write",
      saveActiveMemory: "write",
      rebuildUserProfile: "write",
      overview: "read",
      blocks: "read",
      sensitive: "read",
      revealSensitive: "read",
      updateActiveMemory: "write",
      deleteActiveMemory: "write",
      archives: "read",
    },
    userMemoryScopeFromArgs
  ),
  get categories() {
    return repositoryObject("userMemory").categories;
  },
  get labels() {
    return repositoryObject("userMemory").labels;
  },
  get descriptions() {
    return repositoryObject("userMemory").descriptions;
  },
  get maskedText() {
    return repositoryObject("userMemory").maskedText;
  },
  get schemaInitError() {
    return repositoryObject("userMemory").schemaInitError;
  },
  get ownerRequiredError() {
    return repositoryObject("userMemory").ownerRequiredError;
  },
  memoryOwnerIdFromSessionUser(sessionUser = {}) {
    return repositoryObject("userMemory").memoryOwnerIdFromSessionUser(
      sessionUser
    );
  },
  isMemorySchemaMissingError(error = null) {
    return repositoryObject("userMemory").isMemorySchemaMissingError(error);
  },
};

const workspaceAgentInvocation = {
  ...makeRepositoryFacade(
    "workspaceAgentInvocation",
    {
      close: "write",
      new: "write",
      get: "read",
      getWithWorkspace: "read",
      delete: "write",
      where: "read",
    },
    workspaceAgentInvocationScopeFromArgs
  ),
  parseAgents(promptString = "") {
    return repositoryObject("workspaceAgentInvocation").parseAgents(
      promptString
    );
  },
};

const workspaceChatCompaction = {
  ...makeRepositoryFacade(
    "workspaceChatCompaction",
    {
      ensureTable: "maintenance",
      latest: "read",
      create: "write",
      where: "read",
      deleteForScope: "write",
    },
    workspaceChatCompactionScopeFromArgs
  ),
  get SUMMARY_FORMAT() {
    return repositoryObject("workspaceChatCompaction").SUMMARY_FORMAT;
  },
  get CAPSULE_FORMAT() {
    return repositoryObject("workspaceChatCompaction").CAPSULE_FORMAT;
  },
  normalizeScope(scope = {}) {
    return repositoryObject("workspaceChatCompaction").normalizeScope(scope);
  },
  scopeWhere(scope = {}, alias = "") {
    return repositoryObject("workspaceChatCompaction").scopeWhere(scope, alias);
  },
  chatScopeWhere(scope = {}, alias = "") {
    return repositoryObject("workspaceChatCompaction").chatScopeWhere(
      scope,
      alias
    );
  },
};

const slashCommandPreset = {
  ...makeRepositoryFacade(
    "slashCommandPreset",
    {
      get: "read",
      where: "read",
      create: "write",
      getUserPresets: "read",
      update: "write",
      delete: "write",
    },
    slashCommandPresetScopeFromArgs
  ),
  formatCommand(command = "") {
    return repositoryObject("slashCommandPreset").formatCommand(command);
  },
};

const systemPromptVariable = {
  ...makeRepositoryFacade(
    "systemPromptVariable",
    {
      get: "read",
      getAll: "read",
      create: "write",
      update: "write",
      delete: "write",
      expandSystemPromptVariables: "read",
      _checkVariableKey: "read",
    },
    systemPromptVariableScopeFromArgs
  ),
  get VALID_TYPES() {
    return repositoryObject("systemPromptVariable").VALID_TYPES;
  },
  get DEFAULT_VARIABLES() {
    return repositoryObject("systemPromptVariable").DEFAULT_VARIABLES;
  },
};

const agentSkillWhitelist = {
  ...makeRepositoryFacade(
    "agentSkillWhitelist",
    {
      get: "read",
      add: "write",
      isWhitelisted: "read",
      clearSingleUserWhitelist: "write",
    },
    agentSkillWhitelistScopeFromArgs
  ),
  get SINGLE_USER_LABEL() {
    return repositoryObject("agentSkillWhitelist").SINGLE_USER_LABEL;
  },
  _getLabel(userId = null) {
    return repositoryObject("agentSkillWhitelist")._getLabel(userId);
  },
};

const embedChat = {
  ...makeRepositoryFacade(
    "embedChat",
    {
      new: "write",
      forEmbedByUser: "read",
      markHistoryInvalid: "write",
      get: "read",
      delete: "write",
      where: "read",
      whereWithEmbedAndWorkspace: "read",
      count: "read",
    },
    embedChatScopeFromArgs
  ),
  filterSources(chats = []) {
    return repositoryObject("embedChat").filterSources(chats);
  },
};

const externalCommunication = {
  ...makeRepositoryFacade(
    "externalCommunication",
    {
      get: "read",
      upsert: "write",
      updateConfig: "write",
      delete: "write",
    },
    externalCommunicationScopeFromArgs
  ),
  get supportedTypes() {
    return repositoryObject("externalCommunication").supportedTypes;
  },
};

function repositoryBoundaryFacade(domain) {
  return {
    get db() {
      return repositoryObject(domain).db;
    },
    get model() {
      return repositoryObject(domain).model;
    },
    get workspace() {
      return repositoryObject(domain).workspace;
    },
    get workspaceChats() {
      return repositoryObject(domain).workspaceChats;
    },
    get workspaceThread() {
      return repositoryObject(domain).workspaceThread;
    },
    get authIdentity() {
      return repositoryObject(domain).authIdentity;
    },
    get nodeSupplement() {
      return repositoryObject(domain).nodeSupplement;
    },
    get systemSettings() {
      return repositoryObject(domain).systemSettings;
    },
    get embeddingBatchJob() {
      return repositoryObject(domain).embeddingBatchJob;
    },
    get workspaceDocuments() {
      return repositoryObject(domain).workspaceDocuments;
    },
    get workspaceKnowledgeProfile() {
      return repositoryObject(domain).workspaceKnowledgeProfile;
    },
    get bookStructureAnalysis() {
      return repositoryObject(domain).bookStructureAnalysis;
    },
    get workspaceSupplement() {
      return repositoryObject(domain).workspaceSupplement;
    },
    get workspaceVisualAsset() {
      return repositoryObject(domain).workspaceVisualAsset;
    },
    get workspaceOverviewNarrative() {
      return repositoryObject(domain).workspaceOverviewNarrative;
    },
    raw(operation = "raw", fn) {
      return runAccess({
        domain,
        operation,
        accessType: "raw",
        ownerScope: repositoryBoundaryScopeFromArgs(operation, []),
        fn,
      });
    },
  };
}

const accountDeletion = repositoryBoundaryFacade("accountDeletion");
const clientIdentity = repositoryBoundaryFacade("clientIdentity");
const documentEmbeddingBatch = repositoryBoundaryFacade(
  "documentEmbeddingBatch"
);
const knowledgeGraph = repositoryBoundaryFacade("knowledgeGraph");
const quiz = repositoryBoundaryFacade("quiz");
const requestSigning = repositoryBoundaryFacade("requestSigning");
const systemPatrol = repositoryBoundaryFacade("systemPatrol");
const workspaceOverview = repositoryBoundaryFacade("workspaceOverview");

const userState = {
  ...makeRepositoryFacade(
    "userState",
    {
      where: "read",
      upsertMany: "write",
      delete: "write",
    },
    userStateScopeFromArgs
  ),
  namespacePolicy(namespace) {
    return repositoryObject("userState").namespacePolicy(namespace);
  },
  namespaceSummary() {
    return repositoryObject("userState").namespaceSummary();
  },
};

const authIdentity = {
  ...makeRepositoryFacade(
    "authIdentity",
    {
      describeSyncPolicy: "read",
      findById: "read",
      findByLoginIdentifier: "read",
      shadowForAuthUser: "read",
      authForShadowUser: "read",
      canLoginInCurrentEnvAsync: "read",
      ensureShadowUser: "write",
      repairPasswordFromLocalShadow: "write",
    },
    authIdentityScopeFromArgs
  ),
};

const adminSystem = {
  ...makeRepositoryFacade(
    "adminSystem",
    {
      diagnosticSummary: "read",
      get: "read",
      getSetting: "read",
      getValueOrFallback: "read",
      getSettingValue: "read",
      listSettings: "read",
      currentSettings: "read",
      currentSettingsForSections: "read",
      isOnboardingComplete: "read",
      markOnboardingComplete: "write",
      allowPublicRegistration: "read",
      currentLogoFilename: "read",
      agent_sql_connections: "read",
      getFeatureFlags: "read",
      updateSettings: "write",
      _updateSettings: "write",
      syncDefaultSystemPromptToWorkspaces: "write",
      isMultiUserMode: "read",
      deleteSetting: "write",
      eventLogs: "read",
      eventLogCount: "read",
      deleteEventLogs: "write",
      patrolStatus: "read",
      patrolRun: "maintenance",
      patrolGetRun: "read",
      patrolPreviewRepair: "read",
      patrolConfirmRepair: "write",
      snapshot: "read",
    },
    adminSystemScopeFromArgs
  ),
  get saneDefaultSystemPrompt() {
    return repositoryObject("adminSystem").saneDefaultSystemPrompt;
  },
  get publicFields() {
    return repositoryObject("adminSystem").publicFields;
  },
  effectiveDefaultSystemPrompt(prompt) {
    return repositoryObject("adminSystem").effectiveDefaultSystemPrompt(prompt);
  },
};

const crypto = makeRepositoryFacade(
  "crypto",
  {
    configStatus: "read",
    hubStatus: "read",
    loadingProgress: "read",
    recentEvents: "read",
    snapshot: "read",
  },
  cryptoScopeFromArgs
);

const vault = makeRepositoryFacade(
  "vault",
  {
    listItems: "read",
    list: "read",
    getItem: "read",
    getEnvelope: "read",
    createOrUpdateItem: "write",
    createOrUpdateEnvelope: "write",
    deleteItem: "write",
    softDelete: "write",
    snapshot: "read",
  },
  vaultScopeFromArgs
);

const sensitiveData = makeRepositoryFacade(
  "sensitiveData",
  {
    classify: "read",
    sessionSnapshot: "read",
    revokeSessions: "write",
    snapshot: "read",
  },
  sensitiveDataScopeFromArgs
);

const DataAccessCenter = {
  domains: Object.freeze(Object.keys(repositoryLoaders).sort()),
  adminSystem,
  agentSkillWhitelist,
  accountDeletion,
  authIdentity,
  clientIdentity,
  crypto,
  document,
  documentEmbeddingBatch,
  documentIndexStatus,
  documentVector,
  embedChat,
  externalCommunication,
  knowledgeGraph,
  quiz,
  readerLibrary,
  requestSigning,
  sensitiveData,
  slashCommandPreset,
  get storage() {
    return storageAdapterRegistry();
  },
  systemPromptVariable,
  systemPatrol,
  user,
  userMemory,
  userState,
  vault,
  workspace,
  workspaceAgentInvocation,
  workspaceChat,
  workspaceChatCompaction,
  workspaceOverview,
  workspaceParsedFile,
  workspaceThread,
  ownerScopes: {
    readerLibrary: readerOwnerScope,
  },
  policy: {
    isStaleRevision,
    userStateNamespaces: userStateNamespaceSummary,
  },

  repository(domain) {
    return repositoryModule(domain);
  },

  repositoryObject(domain) {
    return repositoryObject(domain);
  },

  async run(options = {}) {
    return runAccess(options);
  },

  bypassAudit(options = {}) {
    return scanBypassAccess(options);
  },

  assertMigrationCompliance(options = {}) {
    return assertMigrationCompliance(options);
  },

  recordBypassAccess(options = {}) {
    return recordBypassAccess(options);
  },

  snapshot({ includeBypassAudit = false, bypassAuditOptions = {} } = {}) {
    const base = {
      domains: this.domains,
      mode: dataAccessMode(),
      total: stats.total,
      failed: stats.failed,
      byDomain: { ...stats.byDomain },
      byAccessType: { ...stats.byAccessType },
      byClassification: { ...stats.byClassification },
      recent: stats.recent.slice(0, MAX_RECENT_OPERATIONS),
      runtimeBypass: runtimeBypassSnapshot(),
    };
    if (includeBypassAudit) {
      base.bypassAudit = scanBypassAccess(bypassAuditOptions);
    }
    return base;
  },

  resetForTests() {
    stats.total = 0;
    stats.failed = 0;
    stats.byDomain = {};
    stats.byAccessType = {};
    stats.byClassification = {};
    stats.recent = [];
    resetMigrationGuardForTests();
  },
};

module.exports = { DataAccessCenter };
