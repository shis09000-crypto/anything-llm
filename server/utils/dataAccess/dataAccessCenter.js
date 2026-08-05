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
const api = require("@opentelemetry/api");
const {
  withOperationSpan,
  correlationCoverage,
  currentOperationContext,
} = require("../observability/operationContext");
const { requirementsForJourney } = require("../observability/goldenJourneys");
const { metrics } = require("../observability/metrics");

const MAX_RECENT_OPERATIONS = 80;

const repositoryLoaders = {
  adminSystem: () => require("../../repositories/adminSystemRepository"),
  aiGovernance: () => require("../../repositories/aiGovernanceRepository"),
  athenaMutationReceipt: () =>
    require("../../repositories/athenaMutationReceiptRepository"),
  agentSkillWhitelist: () =>
    require("../../repositories/agentSkillWhitelistRepository"),
  accountDeletion: () =>
    require("../../repositories/accountDeletionRepository"),
  authIdentity: () => require("../../repositories/authIdentityRepository"),
  browserPlane: () => require("../../repositories/browserPlaneRepository"),
  clientIdentity: () => require("../../repositories/clientIdentityRepository"),
  communityHub: () => require("../../repositories/communityHubRepository"),
  contentObject: () => require("../../repositories/contentObjectRepository"),
  crypto: () => require("../../repositories/cryptoRepository"),
  document: () => require("../../repositories/documentRepository"),
  documentEmbeddingBatch: () =>
    require("../../repositories/documentEmbeddingBatchRepository"),
  embedConfig: () => require("../../repositories/embedConfigRepository"),
  documentIndexStatus: () =>
    require("../../repositories/documentIndexStatusRepository"),
  documentSyncQueue: () =>
    require("../../repositories/documentSyncQueueRepository"),
  documentSyncRun: () =>
    require("../../repositories/documentSyncRunRepository"),
  documentVector: () => require("../../repositories/documentVectorRepository"),
  embedChat: () => require("../../repositories/embedChatRepository"),
  eventLog: () => require("../../repositories/eventLogRepository"),
  externalCommunication: () =>
    require("../../repositories/externalCommunicationRepository"),
  chatStreamRun: () => require("../../repositories/chatStreamRunRepository"),
  agentRun: () => require("../../repositories/agentRunRepository"),
  toolInvocation: () => require("../../repositories/toolInvocationRepository"),
  knowledgeGraph: () => require("../../repositories/knowledgeGraphRepository"),
  iosPushToken: () => require("../../repositories/iosPushTokenRepository"),
  mobile: () => require("../../repositories/mobileRepository"),
  nodeSupplement: () => require("../../repositories/nodeSupplementRepository"),
  operationsAction: () =>
    require("../../repositories/operationsActionRepository"),
  quiz: () => require("../../repositories/quizRepository"),
  readerLibrary: () => require("../../repositories/readerLibraryRepository"),
  readerWorkerJob: () =>
    require("../../repositories/readerWorkerJobRepository"),
  requestSigning: () => require("../../repositories/requestSigningRepository"),
  retention: () => require("../../repositories/retentionRepository"),
  runtimeLifecycle: () =>
    require("../../repositories/runtimeLifecycleRepository"),
  scheduledJob: () => require("../../repositories/scheduledJobRepository"),
  securityKey: () => require("../../repositories/securityKeyRepository"),
  sensitiveData: () => require("../../repositories/sensitiveDataRepository"),
  slashCommandPreset: () =>
    require("../../repositories/slashCommandPresetRepository"),
  systemPromptVariable: () =>
    require("../../repositories/systemPromptVariableRepository"),
  systemPatrol: () => require("../../repositories/systemPatrolRepository"),
  syncEvent: () => require("../../repositories/syncEventRepository"),
  syncV2: () => require("../../repositories/syncV2Repository"),
  telemetry: () => require("../../repositories/telemetryRepository"),
  user: () => require("../../repositories/userRepository"),
  userMemory: () => require("../../repositories/userMemoryRepository"),
  userState: () => require("../../repositories/userStateRepository"),
  wechatGatewayThread: () =>
    require("../../repositories/wechatGatewayThreadRepository"),
  workspace: () => require("../../repositories/workspaceRepository"),
  workspaceAgentInvocation: () =>
    require("../../repositories/workspaceAgentInvocationRepository"),
  workspaceChat: () => require("../../repositories/workspaceChatRepository"),
  workspaceChatCompaction: () =>
    require("../../repositories/workspaceChatCompactionRepository"),
  workspaceCognition: () =>
    require("../../repositories/workspaceCognitionRepository"),
  workspaceMeetingDelegate: () =>
    require("../../repositories/workspaceMeetingDelegateRepository"),
  workspaceMindMap: () =>
    require("../../repositories/workspaceMindMapRepository"),
  workspaceOverview: () =>
    require("../../repositories/workspaceOverviewRepository"),
  workspaceParsedFile: () =>
    require("../../repositories/workspaceParsedFileRepository"),
  workspaceSuggestedMessage: () =>
    require("../../repositories/workspaceSuggestedMessageRepository"),
  workspaceSupplement: () =>
    require("../../repositories/workspaceSupplementRepository"),
  workspaceVisualAsset: () =>
    require("../../repositories/workspaceVisualAssetRepository"),
  workspaceThread: () =>
    require("../../repositories/workspaceThreadRepository"),
  vault: () => require("../../repositories/vaultRepository"),
};

const repositoryExports = {
  adminSystem: "AdminSystemRepository",
  aiGovernance: "AIGovernanceRepository",
  athenaMutationReceipt: "AthenaMutationReceiptRepository",
  agentSkillWhitelist: "AgentSkillWhitelistRepository",
  accountDeletion: "AccountDeletionRepository",
  authIdentity: "AuthIdentityRepository",
  browserPlane: "BrowserPlaneRepository",
  clientIdentity: "ClientIdentityRepository",
  communityHub: "CommunityHubRepository",
  contentObject: "ContentObjectRepository",
  crypto: "CryptoRepository",
  document: "DocumentRepository",
  documentEmbeddingBatch: "DocumentEmbeddingBatchRepository",
  embedConfig: "EmbedConfigRepository",
  documentIndexStatus: "DocumentIndexStatusRepository",
  documentSyncQueue: "DocumentSyncQueueRepository",
  documentSyncRun: "DocumentSyncRunRepository",
  documentVector: "DocumentVectorRepository",
  embedChat: "EmbedChatRepository",
  eventLog: "EventLogRepository",
  externalCommunication: "ExternalCommunicationRepository",
  chatStreamRun: "ChatStreamRunRepository",
  agentRun: "AgentRunRepository",
  toolInvocation: "ToolInvocationRepository",
  knowledgeGraph: "KnowledgeGraphRepository",
  iosPushToken: "IOSPushTokenRepository",
  mobile: "MobileRepository",
  nodeSupplement: "NodeSupplementRepository",
  operationsAction: "OperationsActionRepository",
  quiz: "QuizRepository",
  readerLibrary: "ReaderLibraryRepository",
  readerWorkerJob: "ReaderWorkerJobRepository",
  requestSigning: "RequestSigningRepository",
  retention: "RetentionRepository",
  runtimeLifecycle: "RuntimeLifecycleRepository",
  scheduledJob: "ScheduledJobRepository",
  securityKey: "SecurityKeyRepository",
  sensitiveData: "SensitiveDataRepository",
  slashCommandPreset: "SlashCommandPresetRepository",
  systemPromptVariable: "SystemPromptVariableRepository",
  systemPatrol: "SystemPatrolRepository",
  syncEvent: "SyncEventRepository",
  syncV2: "SyncV2Repository",
  telemetry: "TelemetryRepository",
  user: "UserRepository",
  userMemory: "UserMemoryRepository",
  userState: "UserStateRepository",
  wechatGatewayThread: "WeChatGatewayThreadRepository",
  workspace: "WorkspaceRepository",
  workspaceAgentInvocation: "WorkspaceAgentInvocationRepository",
  workspaceChat: "WorkspaceChatRepository",
  workspaceChatCompaction: "WorkspaceChatCompactionRepository",
  workspaceCognition: "WorkspaceCognitionRepository",
  workspaceMeetingDelegate: "WorkspaceMeetingDelegateRepository",
  workspaceMindMap: "WorkspaceMindMapRepository",
  workspaceOverview: "WorkspaceOverviewRepository",
  workspaceParsedFile: "WorkspaceParsedFileRepository",
  workspaceSuggestedMessage: "WorkspaceSuggestedMessageRepository",
  workspaceSupplement: "WorkspaceSupplementRepository",
  workspaceVisualAsset: "WorkspaceVisualAssetRepository",
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
  let outcome = "success";
  try {
    const result = await withOperationSpan(
      `data_access.${domain}.${operation}`,
      {
        kind: api.SpanKind.INTERNAL,
        attributes: {
          "athena.data.domain": domain,
          "athena.data.operation": operation,
          "athena.data.access_type": accessType,
        },
      },
      fn
    );
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
    outcome = "failure";
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
  } finally {
    const labels = { domain, access_type: accessType, outcome };
    metrics.dataAccessOperations.inc(labels);
    metrics.dataAccessDuration.observe(labels, (Date.now() - startedAt) / 1000);
    const journey = currentOperationContext()?.journey || "background";
    const coverage = correlationCoverage(requirementsForJourney(journey));
    metrics.operationCorrelation.inc({
      component: "data_access",
      journey,
      coverage: coverage.complete ? "complete" : "incomplete",
    });
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
  if (method === "updateAutomaticTitle" || method === "claimAutomaticTitle") {
    return { threadId: args[0]?.threadId, workspaceId: args[0]?.workspaceId };
  }
  return clauseScope(args[0]);
}

function syncEventScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  if (method === "persist") {
    return {
      userId: options.scope?.userId,
      eventId: options.eventId,
      visibility: options.visibility,
    };
  }
  return {
    userId: options.userId,
    clientId: options.clientId,
    afterEventId: options.afterEventId,
  };
}

function iosPushTokenScopeFromArgs(method, args = []) {
  if (method === "activeForUser") {
    return { userId: args[0], excludeClientId: args[1] };
  }
  if (method === "revokeById") return { tokenId: args[0] };
  return {
    userId: args[0]?.userId,
    clientId: args[0]?.clientId,
  };
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

function documentSyncQueueScopeFromArgs(method, args = []) {
  if (method === "watch" || method === "unwatch") {
    return { workspaceDocId: args[0]?.id, filename: args[0]?.filename };
  }
  if (method === "_update") return { queueId: args[0] };
  if (method === "saveRun") return { queueId: args[0], status: args[1] };
  if (method === "toggleWatchStatus") {
    return {
      workspaceDocId: args[0]?.id,
      filename: args[0]?.filename,
      watchStatus: args[1],
    };
  }
  return clauseScope(args[0]);
}

function documentSyncRunScopeFromArgs(method, args = []) {
  if (method === "save") return { queueId: args[0], status: args[1] };
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

function chatStreamRunScopeFromArgs(_method, args = []) {
  const scope = args[0] || {};
  return {
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    userId: scope.userId,
    clientTurnId: scope.clientTurnId,
    runId: scope.id,
  };
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

function workspaceCognitiveScopeFromArgs(method, args = []) {
  const first = args[0] || {};
  if (typeof first === "object") {
    return {
      workspaceId: first.workspaceId || first.workspace?.id,
      threadId: first.threadId || first.thread?.id,
      chatId: first.chatId || first.chat?.id,
      jobId: first.jobId,
      candidateId: first.candidateId,
      cognitiveItemId: first.cognitiveItemId || first.canonicalItemId,
      itemKey: first.itemKey,
      assertionId: first.assertionId,
      positionId: first.positionId,
      evidenceId: first.evidenceId,
      meetingPacketId: first.packetId || first.meetingPacketId,
      meetingSessionId: first.sessionId || first.meetingSessionId,
    };
  }
  return {
    workspaceId: first,
    resourceId: args[1],
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

function embedConfigScopeFromArgs(method, args = []) {
  if (method === "new") {
    return { workspaceId: args[0]?.workspace_id, creatorId: args[1] };
  }
  if (method === "update") return { embedId: args[0] };
  return clauseScope(args[0]);
}

function communityHubScopeFromArgs(method, args = []) {
  if (method === "validateImportId" || method === "getBundleItem") {
    return { importId: args[0] };
  }
  if (method === "applyItem") {
    return {
      itemType: args[0]?.itemType,
      workspaceSlug: args[1]?.workspaceSlug,
      userId: args[1]?.currentUser?.id,
    };
  }
  if (method === "importBundleItem") {
    return { itemType: args[0]?.item?.itemType };
  }
  if (method === "fetchUserItems") {
    return { hasConnectionKey: Boolean(args[0]) };
  }
  if (method === "createStaticItem") {
    return { itemType: args[0], hasConnectionKey: Boolean(args[2]) };
  }
  return { operation: method };
}

function externalCommunicationScopeFromArgs(method, args = []) {
  return { type: args[0], operation: method };
}

function wechatGatewayThreadScopeFromArgs(method, args = []) {
  if (method === "getByWxid") return { wxid: args[0] };
  if (method === "getByThreadSlug") return { threadSlug: args[0] };
  if (method === "upsert") {
    const options = args[0] || {};
    return {
      wxid: options.wxid,
      workspaceSlug: options.workspaceSlug,
      threadSlug: options.threadSlug,
    };
  }
  return { operation: method };
}

function workspaceMindMapScopeFromArgs(method, args = []) {
  if (method === "findCached") {
    const options = args[0] || {};
    return {
      workspaceId: options.workspaceId,
      userId: options.user?.id,
      sourceHash: options.sourceHash,
    };
  }
  if (method === "create") {
    const data = args[0] || {};
    return {
      workspaceId: data.workspaceId,
      userId: data.user?.id,
      threadId: data.threadId,
      sourceHash: data.sourceHash,
    };
  }
  if (method === "updateViewport") {
    const options = args[0] || {};
    return {
      id: options.id,
      workspaceId: options.workspaceId,
      userId: options.user?.id,
    };
  }
  return clauseScope(args[0]);
}

function workspaceSuggestedMessageScopeFromArgs(method, args = []) {
  if (method === "saveAll") {
    return {
      workspaceSlug: args[1],
      count: Array.isArray(args[0]) ? args[0].length : 0,
    };
  }
  if (method === "getMessages") return { workspaceSlug: args[0] };
  return clauseScope(args[0]);
}

function workspaceVisualAssetScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  return {
    workspaceId: options.workspaceId,
    workspaceSlug: options.workspaceSlug,
    scopeType: options.scopeType,
    nodeKey: options.nodeKey,
    id: options.id,
  };
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
  if (method === "issueTemporaryAuthToken") return { userId: args[0] };
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
    authUserId: options.authUserId,
    itemId: options.itemId,
    itemType: options.itemType,
    targetClientId: options.targetClientId,
    rootEpoch: options.rootEpoch,
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

function securityKeyScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  return {
    keyId: options.keyId,
    purpose: options.purpose,
    domain: options.domain,
    jobId: options.jobId,
    idempotencyKey: options.idempotencyKey ? "[redacted]" : null,
  };
}

function readerWorkerJobScopeFromArgs(method, args = []) {
  const options = args[0] || {};
  if (method === "complete" || method === "fail") return { jobId: args[0] };
  if (method === "cancel") return clauseScope(options);
  return {
    jobId: options.jobId,
    task: options.task,
    status: options.status,
    workspaceSlug: options.workspaceSlug,
    readerDocumentId: options.readerDocumentId,
    userId: options.userId,
    workerId: options.workerId,
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

const readerWorkerJob = makeRepositoryFacade(
  "readerWorkerJob",
  {
    enabled: "read",
    enqueue: "write",
    get: "read",
    where: "read",
    claimNext: "write",
    complete: "write",
    fail: "write",
    cancel: "write",
    snapshot: "read",
  },
  readerWorkerJobScopeFromArgs
);

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

const athenaMutationReceipt = makeRepositoryFacade(
  "athenaMutationReceipt",
  {
    reserve: "write",
    complete: "write",
    fail: "write",
    release: "write",
    renew: "write",
    sweepStale: "maintenance",
    snapshot: "read",
    pruneExpired: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);

const workspaceThread = {
  ...makeRepositoryFacade(
    "workspaceThread",
    {
      withLastChatActivity: "read",
      historyFingerprintManifest: "read",
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
      claimAutomaticTitle: "write",
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

const syncEvent = makeRepositoryFacade(
  "syncEvent",
  {
    persist: "write",
    replay: "read",
    pruneIfNeeded: "maintenance",
  },
  syncEventScopeFromArgs
);

const syncV2 = makeRepositoryFacade(
  "syncV2",
  {
    schemaReady: "read",
    enabled: "read",
    canAccessNode: "read",
    mutationReplay: "read",
    recordNodeChange: "write",
    recordAuthSessionChange: "write",
    assertMutationVersion: "read",
    reconcileNode: "write",
    materializeCoreForUser: "write",
    manifestForUser: "read",
    batchGet: "read",
    eventsAfter: "read",
    updateCursor: "write",
    pendingOutbox: "read",
    deadLetterOutbox: "read",
    outboxRows: "read",
    requeueDeadLetters: "maintenance",
    restoreDeadLetters: "maintenance",
    claimOutbox: "maintenance",
    releaseOutboxClaims: "maintenance",
    renewOutboxClaims: "maintenance",
    markOutboxDispatched: "maintenance",
    failOutboxClaim: "maintenance",
    markDispatched: "write",
    pruneExpired: "maintenance",
    audienceUserIds: "read",
    outboxHealth: "read",
    snapshot: "read",
  },
  repositoryBoundaryScopeFromArgs
);

const iosPushToken = makeRepositoryFacade(
  "iosPushToken",
  {
    register: "write",
    revoke: "write",
    revokeById: "write",
    activeForUser: "read",
  },
  iosPushTokenScopeFromArgs
);

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
    publicIdColumnExists: "read",
    backfillMissingPublicIds: "maintenance",
    truncateForNativeEdit: "write",
    regenerateLastTurn: "write",
    deleteTurnPermanently: "write",
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

const chatStreamRun = makeRepositoryFacade(
  "chatStreamRun",
  {
    claim: "write",
    getScoped: "read",
    checkpoint: "write",
    appendEvents: "write",
    eventsAfter: "read",
    renewLease: "write",
    reconcileExpired: "maintenance",
    settle: "write",
  },
  chatStreamRunScopeFromArgs
);

const agentRun = makeRepositoryFacade(
  "agentRun",
  {
    claim: "write",
    ensure: "write",
    append: "write",
    state: "read",
    eventsAfter: "read",
    updateState: "write",
    renewLease: "write",
    expiredLeases: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);

const toolInvocation = makeRepositoryFacade(
  "toolInvocation",
  {
    requestApproval: "write",
    resolveApproval: "write",
    startExecution: "write",
    startAutomaticExecution: "write",
    completeExecution: "write",
    failExecution: "write",
    executionContext: "read",
    consumeCapabilityNonce: "write",
    pruneCapabilityNonces: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);

const browserPlane = makeRepositoryFacade(
  "browserPlane",
  {
    ensureProfile: "write",
    getProfile: "read",
    claimProfileLease: "write",
    releaseProfileLease: "write",
    updateProfileCheckpoint: "write",
    markProfileDeleted: "write",
    createSession: "write",
    activeSession: "read",
    getSession: "read",
    idleSessions: "read",
    updateSession: "write",
    upsertTabs: "write",
    startTask: "write",
    claimApprovedTask: "write",
    finishTask: "write",
    createArtifact: "write",
    createArtifactFromFile: "write",
    listWorkspaces: "read",
    saveWorkspace: "write",
    addHistory: "write",
    listHistory: "read",
    addBookmark: "write",
    listBookmarks: "read",
  },
  repositoryBoundaryScopeFromArgs
);

const contentObject = makeRepositoryFacade(
  "contentObject",
  {
    resolveCompletedUpload: "read",
    payloadReferences: "read",
    contentReferenceObject: "read",
    createUpload: "write",
    pendingUpload: "read",
    recordUploadPart: "write",
    completableUpload: "read",
    uploadParts: "read",
    markUploadCompleted: "write",
    stageBuffer: "write",
    stageFileParts: "write",
    attachToChat: "write",
    prepareChatReferenceClone: "read",
    cloneChatReferences: "write",
    readRange: "read",
    readWhole: "read",
    attachmentForWorkspace: "read",
    contentRefForWorkspace: "read",
    verify: "read",
    reconcile: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);

const aiGovernance = makeRepositoryFacade(
  "aiGovernance",
  {
    priceFor: "read",
    policyFor: "read",
    reserve: "write",
    settle: "write",
    release: "write",
    observeCompletedExecution: "write",
  },
  repositoryBoundaryScopeFromArgs
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
    create: "write",
    addDocuments: "write",
    removeDocuments: "write",
    reindexDocuments: "maintenance",
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

const documentSyncQueue = {
  ...makeRepositoryFacade(
    "documentSyncQueue",
    {
      enabled: "read",
      watch: "write",
      unwatch: "write",
      _update: "write",
      get: "read",
      where: "read",
      count: "read",
      delete: "write",
      staleDocumentQueues: "read",
      saveRun: "write",
      toggleWatchStatus: "write",
      bootWorkers: "maintenance",
      killWorkers: "maintenance",
    },
    documentSyncQueueScopeFromArgs
  ),
  get featureKey() {
    return repositoryObject("documentSyncQueue").featureKey;
  },
  get validFileTypes() {
    return repositoryObject("documentSyncQueue").validFileTypes;
  },
  get defaultStaleAfter() {
    return repositoryObject("documentSyncQueue").defaultStaleAfter;
  },
  get maxRepeatFailures() {
    return repositoryObject("documentSyncQueue").maxRepeatFailures;
  },
  canWatch(metadata = {}) {
    return repositoryObject("documentSyncQueue").canWatch(metadata);
  },
  calcNextSync(queueRecord = null) {
    return repositoryObject("documentSyncQueue").calcNextSync(queueRecord);
  },
};

const documentSyncRun = {
  ...makeRepositoryFacade(
    "documentSyncRun",
    {
      save: "write",
      get: "read",
      where: "read",
      count: "read",
      delete: "write",
    },
    documentSyncRunScopeFromArgs
  ),
  get statuses() {
    return repositoryObject("documentSyncRun").statuses;
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
      countAfter: "read",
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

const workspaceCognition = makeRepositoryFacade(
  "workspaceCognition",
  {
    createAssertion: "write",
    addEvidence: "write",
    createPosition: "write",
    createRelation: "write",
    patchAssertion: "write",
    patchPosition: "write",
    patchEvidence: "write",
    listItems: "read",
    rebuildProfile: "write",
    getLatestProfile: "read",
    markDocumentEvidenceStale: "write",
    markChatEvidenceStale: "write",
    createExtractionJob: "write",
    updateExtractionJob: "write",
    enqueueFinalizedTurn: "write",
    enqueueThreadBackfill: "write",
    requestFlush: "write",
    retryExtractionJob: "write",
    listExtractionState: "read",
    listCandidates: "read",
    createManualCandidate: "write",
    reviewCandidate: "write",
    itemHistory: "read",
    listLedgerItems: "read",
    reviseCanonicalItemFromProjection: "write",
    currentCanonicalView: "read",
    rebuildCanonicalProfile: "write",
    getProfileState: "read",
    appendEvidenceEventsForSources: "write",
    appendEvidencePolicyEvent: "write",
    cancelBufferedChats: "write",
    reconcileFinalizedTurns: "maintenance",
    backfillLegacyCognition: "maintenance",
    deleteWorkspaceBatchData: "write",
    deleteWorkspaceData: "write",
    startWorker: "maintenance",
    stopWorker: "maintenance",
    workerSnapshot: "read",
  },
  workspaceCognitiveScopeFromArgs
);

const workspaceMeetingDelegate = makeRepositoryFacade(
  "workspaceMeetingDelegate",
  {
    createPacket: "write",
    updatePacket: "write",
    getPacket: "read",
    listPackets: "read",
    freezePacket: "write",
    revokePacket: "write",
    createSession: "write",
    getSession: "read",
    recordAudit: "write",
    listAudit: "read",
    validateCommitment: "read",
  },
  workspaceCognitiveScopeFromArgs
);

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

const embedConfig = {
  ...makeRepositoryFacade(
    "embedConfig",
    {
      new: "write",
      update: "write",
      get: "read",
      getWithWorkspace: "read",
      delete: "write",
      where: "read",
      whereWithWorkspace: "read",
    },
    embedConfigScopeFromArgs
  ),
  parseAllowedHosts(embed = null) {
    return repositoryObject("embedConfig").parseAllowedHosts(embed);
  },
};

const communityHub = makeRepositoryFacade(
  "communityHub",
  {
    validateImportId: "read",
    fetchExploreItems: "read",
    getBundleItem: "read",
    applyItem: "write",
    importBundleItem: "write",
    fetchUserItems: "read",
    createStaticItem: "write",
  },
  communityHubScopeFromArgs
);

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

const wechatGatewayThread = makeRepositoryFacade(
  "wechatGatewayThread",
  {
    ensureTable: "maintenance",
    getByWxid: "read",
    getByThreadSlug: "read",
    upsert: "write",
  },
  wechatGatewayThreadScopeFromArgs
);

const workspaceMindMap = {
  ...makeRepositoryFacade(
    "workspaceMindMap",
    {
      ensureTable: "maintenance",
      get: "read",
      where: "read",
      findCached: "read",
      create: "write",
      updateViewport: "write",
    },
    workspaceMindMapScopeFromArgs
  ),
  cacheUserKey(user = null) {
    return repositoryObject("workspaceMindMap").cacheUserKey(user);
  },
  toPayload(record = null) {
    return repositoryObject("workspaceMindMap").toPayload(record);
  },
};

const workspaceSuggestedMessage = makeRepositoryFacade(
  "workspaceSuggestedMessage",
  {
    get: "read",
    where: "read",
    getMessages: "read",
    saveAll: "write",
  },
  workspaceSuggestedMessageScopeFromArgs
);

const workspaceVisualAsset = {
  ...makeRepositoryFacade(
    "workspaceVisualAsset",
    {
      ensureTable: "maintenance",
      list: "read",
      forWorkspace: "read",
      forNode: "read",
      upsertFromUpload: "write",
      get: "read",
      fileFor: "read",
      delete: "write",
    },
    workspaceVisualAssetScopeFromArgs
  ),
  get DEFAULT_ROLE() {
    return repositoryObject("workspaceVisualAsset").DEFAULT_ROLE;
  },
  assetsRoot() {
    return repositoryObject("workspaceVisualAsset").assetsRoot();
  },
  normalizeRow(...args) {
    return repositoryObject("workspaceVisualAsset").normalizeRow(...args);
  },
  publicUrl(...args) {
    return repositoryObject("workspaceVisualAsset").publicUrl(...args);
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
    get job() {
      return repositoryObject(domain).job;
    },
    get run() {
      return repositoryObject(domain).run;
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
const mobile = repositoryBoundaryFacade("mobile");
const nodeSupplement = repositoryBoundaryFacade("nodeSupplement");
const quiz = repositoryBoundaryFacade("quiz");
const requestSigning = repositoryBoundaryFacade("requestSigning");
const runtimeLifecycle = makeRepositoryFacade(
  "runtimeLifecycle",
  {
    databaseReadiness: "read",
    disconnectDatabases: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);
const scheduledJob = repositoryBoundaryFacade("scheduledJob");
const systemPatrol = repositoryBoundaryFacade("systemPatrol");
const operationsAction = makeRepositoryFacade(
  "operationsAction",
  {
    createRun: "write",
    getRun: "read",
    getRunBySourceActionId: "read",
    listRuns: "read",
    transitionRun: "write",
    updateRun: "write",
    addApproval: "write",
    approvalsForRun: "read",
    acquireLease: "maintenance",
    releaseLease: "maintenance",
    expiredLeasedRuns: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);
const workspaceOverview = repositoryBoundaryFacade("workspaceOverview");
const workspaceSupplement = repositoryBoundaryFacade("workspaceSupplement");

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
  get model() {
    return repositoryObject("authIdentity").model;
  },
  get shadowUser() {
    return repositoryObject("authIdentity").shadowUser;
  },
  get localDb() {
    return repositoryObject("authIdentity").localDb;
  },
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
      hubSettings: "read",
      issueTemporaryAuthToken: "write",
      updateSettings: "write",
      _updateSettings: "write",
      syncDefaultSystemPromptToWorkspaces: "write",
      isMultiUserMode: "read",
      delete: "write",
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
  get validations() {
    return repositoryObject("adminSystem").validations;
  },
  get apiKey() {
    return repositoryObject("adminSystem").apiKey;
  },
  get authIdentity() {
    return repositoryObject("adminSystem").authIdentity;
  },
  get authSession() {
    return repositoryObject("adminSystem").authSession;
  },
  get realtimeTicket() {
    return repositoryObject("adminSystem").realtimeTicket;
  },
  get browserExtensionApiKey() {
    return repositoryObject("adminSystem").browserExtensionApiKey;
  },
  get emailVerificationCode() {
    return repositoryObject("adminSystem").emailVerificationCode;
  },
  get emailVerificationGrant() {
    return repositoryObject("adminSystem").emailVerificationGrant;
  },
  get emailVerificationRateLimit() {
    return repositoryObject("adminSystem").emailVerificationRateLimit;
  },
  get invite() {
    return repositoryObject("adminSystem").invite;
  },
  get recoveryCode() {
    return repositoryObject("adminSystem").recoveryCode;
  },
  get passwordResetToken() {
    return repositoryObject("adminSystem").passwordResetToken;
  },
  get temporaryAuthToken() {
    return repositoryObject("adminSystem").temporaryAuthToken;
  },
  get user() {
    return repositoryObject("adminSystem").user;
  },
  get userRecords() {
    return repositoryObject("adminSystem").userRecords;
  },
  get workspaceUser() {
    return repositoryObject("adminSystem").workspaceUser;
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
    activeUserRoot: "read",
    findAccountConnection: "read",
    uniqueAccountConnection: "read",
    upsertAccountConnection: "write",
    listAccountConnections: "read",
    updateAccountConnection: "write",
    updateAccountConnections: "write",
    listAccountEquitySnapshots: "read",
    upsertAccountEquitySnapshot: "write",
    findUserDomainWrap: "read",
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
    userRootStatus: "read",
    issueUserRootChallenge: "write",
    initializeUserRoot: "write",
    storeUserRootEnvelope: "write",
    pendingUserRootEnvelopes: "read",
    consumeUserRootEnvelope: "write",
    queueUserDomainWrap: "write",
    listUserDomainWraps: "read",
    prepareUserDomainWrap: "read",
    completeUserDomainWrap: "write",
    createOrResumeUserDomainMigration: "write",
    advanceUserDomainMigration: "write",
    userDomainWrapCoverage: "read",
    storeDeviceKeyEnvelope: "write",
    pendingDeviceKeyEnvelopes: "read",
    consumeDeviceKeyEnvelope: "write",
    beginKeyEpochRotation: "write",
    listKeyEpochs: "read",
    cancelKeyEpochRotation: "write",
    getDeviceKeyRegistration: "read",
    listUserRootAuthorizationTargets: "read",
    acknowledgeKeyEpoch: "write",
    retireKeyEpoch: "write",
    storeRecoveryPackage: "write",
    getRecoveryPackage: "read",
    revokeRecoveryPackage: "write",
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

const securityKey = makeRepositoryFacade(
  "securityKey",
  {
    probeSample: "read",
    probeAuthSample: "read",
    listRegistry: "read",
    activeRegistry: "read",
    registryByKeyId: "read",
    createRegistry: "write",
    updateRegistry: "write",
    listBindings: "read",
    upsertBinding: "write",
    createRotationJob: "write",
    rotationJob: "read",
    updateRotationJob: "write",
    claimRotationExecution: "write",
    listRotationJobs: "read",
    rotationApprovals: "read",
    recordRotationApproval: "write",
    appendEvent: "write",
    listEvents: "read",
  },
  securityKeyScopeFromArgs
);

const telemetry = makeRepositoryFacade(
  "telemetry",
  {
    sendTelemetry: "write",
    flush: "maintenance",
    setUid: "write",
    findOrCreateId: "write",
    id: "read",
  },
  repositoryBoundaryScopeFromArgs
);

const retention = makeRepositoryFacade(
  "retention",
  {
    sweepPatrolRuns: "maintenance",
    sweepExpiredUploads: "maintenance",
    sweepOperationalRows: "maintenance",
  },
  repositoryBoundaryScopeFromArgs
);

const DataAccessCenter = {
  domains: Object.freeze(Object.keys(repositoryLoaders).sort()),
  adminSystem,
  aiGovernance,
  athenaMutationReceipt,
  agentSkillWhitelist,
  accountDeletion,
  authIdentity,
  browserPlane,
  agentRun,
  clientIdentity,
  communityHub,
  chatStreamRun,
  contentObject,
  crypto,
  document,
  documentEmbeddingBatch,
  documentIndexStatus,
  documentSyncQueue,
  documentSyncRun,
  documentVector,
  embedConfig,
  embedChat,
  externalCommunication,
  knowledgeGraph,
  iosPushToken,
  mobile,
  nodeSupplement,
  operationsAction,
  quiz,
  readerLibrary,
  readerWorkerJob,
  requestSigning,
  retention,
  runtimeLifecycle,
  scheduledJob,
  securityKey,
  sensitiveData,
  slashCommandPreset,
  get storage() {
    return storageAdapterRegistry();
  },
  systemPromptVariable,
  systemPatrol,
  syncEvent,
  syncV2,
  telemetry,
  toolInvocation,
  user,
  userMemory,
  userState,
  vault,
  wechatGatewayThread,
  workspace,
  workspaceAgentInvocation,
  workspaceChat,
  workspaceChatCompaction,
  workspaceCognition,
  workspaceMeetingDelegate,
  workspaceMindMap,
  workspaceOverview,
  workspaceParsedFile,
  workspaceSuggestedMessage,
  workspaceSupplement,
  workspaceVisualAsset,
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
