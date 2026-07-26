const crypto = require("crypto");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const { jsonrepair } = require("jsonrepair");
const prisma = require("../utils/prisma");
const { getTaskConnector } = require("../utils/llmTasks");
const {
  beginModelExecution,
  estimatedTokens,
} = require("../utils/aiGovernance");
const { WorkspaceChats } = require("./workspaceChats");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const {
  getVectorDbClass,
  getEmbeddingEngineSelection,
} = require("../utils/helpers");
const {
  CognitionWorkerLifecycle,
} = require("../utils/workspaceCognition/workerLifecycle");
const {
  createWorkspaceCognitionPipelineProtocol,
} = require("../utils/workspaceCognition/pipelineProtocol");

const BATCH_SIZE = 5;
const SILENCE_MS = 10 * 60 * 1000;
const PIPELINE_VERSION = 4;
const REFINE_GROUP_SIZE = 3;
const USER_GATE_INPUT_TOKENS = 2_000;
const ROUGH_INPUT_TOKENS = 4_500;
const REFINE_INPUT_TOKENS = 6_500;
const USER_GATE_MAX_TOKENS = 160;
const ASSISTANT_EVIDENCE_MAX_TOKENS = 160;
const ROUGH_MAX_TOKENS = 320;
const REFINE_MAX_TOKENS = 1_200;
const REPAIR_INPUT_TOKENS = 1_200;
const REPAIR_MAX_TOKENS = 256;
const ROUGH_MODEL_OVERRIDE =
  process.env.WORKSPACE_COGNITIVE_SCREEN_MODEL || "deepseek-v4-flash";
const LEASE_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const TERMINAL_REVIEW_EVENTS = new Set([
  "confirmed",
  "temporary_confirmed",
  "rejected",
  "edited",
  "split",
]);
const workerId = `${os.hostname()}:${process.pid}:${uuidv4()}`;
let workerBusy = false;

async function cognitionSyncReady() {
  return SyncV2.enabled("cognition") && (await SyncV2.schemaReady());
}

async function recordCognitionChange(
  tx,
  { workspaceId, eventType, changedPaths, payloadHint }
) {
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.workspaceDomain(workspaceId, "cognition"),
    content: payloadHint,
    eventType,
    changedPaths,
    payloadHint,
  });
}

function batchEnabled() {
  if (process.env.WORKSPACE_COGNITION_BATCH_V3 === "0") return false;
  if (
    process.env.WORKSPACE_COGNITION_BATCH_V3 === undefined &&
    process.env.WORKSPACE_COGNITION_BATCH_V2 === "0"
  )
    return false;
  return true;
}

function json(value, fallback = "{}") {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  const text = String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {}
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    return fallback;
  }
}

function cleanText(value = "", max = 12_000) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizedHash(type, statement) {
  return sha(`${type}\u0000${cleanText(statement, 8_000).toLowerCase()}`);
}

function responsePayload(chat = {}) {
  return parseJson(chat.response, {});
}

function scopeKeyForChat(chat = {}) {
  if (chat.thread_id) return `thread:${Number(chat.thread_id)}`;
  return `overview:user:${Number(chat.user_id || 0)}`;
}

function completeTurnContent(chat = {}) {
  const response = responsePayload(chat);
  const text = cleanText(response.text, 100_000);
  if (!cleanText(chat.prompt, 100_000) || !text) return null;
  return { response, text };
}

function extractionPlanForPending(pendingCount, flushReason = null) {
  const count = Math.max(0, Number(pendingCount) || 0);
  if (count >= BATCH_SIZE)
    return {
      take: BATCH_SIZE,
      pipeline: "rough_screen",
      triggerReason: "batch5",
    };
  if (count > 0 && flushReason)
    return {
      take: count,
      pipeline: "rough_screen",
      triggerReason: flushReason,
    };
  return null;
}

function shouldScheduleSilentRough(unscreenedPending) {
  return unscreenedPending > 0 && unscreenedPending < BATCH_SIZE;
}

const {
  ASSERTION_TYPES,
  MAX_ROUGH_SEGMENTS,
  RELATION_TYPES,
  assistantEvidencePrompt,
  dedupedSourceCatalog,
  refinePrompt,
  segmentCatalog,
  sourceCatalog,
  userGatePrompt,
  validateRefinement,
  validateScreening,
  validateUserGate,
} = createWorkspaceCognitionPipelineProtocol({
  responsePayload,
  cleanText,
  sha,
  json,
});

async function workspaceScope(workspace) {
  const documents = await prisma.workspace_documents.findMany({
    where: { workspaceId: Number(workspace.id) },
    select: { filename: true },
    orderBy: { id: "asc" },
    take: 20,
  });
  return {
    name: cleanText(workspace.name, 300),
    objective: cleanText(workspace.openAiPrompt, 2_000),
    documentTitles: documents.map((document) =>
      cleanText(document.filename, 300)
    ),
  };
}

async function completeTask(
  taskName,
  workspace,
  messages,
  maxTokens,
  modelOverride = null
) {
  const { connector, provider, model } = getTaskConnector(
    taskName,
    { workspace },
    modelOverride ? { model: modelOverride } : {}
  );
  const execution = await beginModelExecution(
    {
      ownerType: "workspace",
      ownerId: String(workspace.id),
      workspaceId: workspace.id,
      taskType: taskName,
      provider,
      model,
    },
    { messages, outputTokens: maxTokens, durationMs: 120_000 }
  );
  let result;
  try {
    result = await connector.getChatCompletion(messages, {
      temperature: 0,
      responseFormat: { type: "json_object" },
      maxTokens,
      thinking: "disabled",
    });
    await execution.settle(result?.metrics || {}, {
      pipelineVersion: PIPELINE_VERSION,
    });
  } catch (error) {
    await execution.fail(error).catch(() => null);
    throw error;
  }
  const payload = parseJson(result?.textResponse, null);
  return {
    payload,
    raw: String(result?.textResponse || ""),
    metrics: result?.metrics || {},
    provider,
    model,
  };
}

async function currentCanonicalItems(workspaceId) {
  const [items, relations] = await Promise.all([
    prisma.workspace_cognitive_items.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: [{ itemKey: "asc" }, { version: "desc" }],
    }),
    prisma.workspace_cognitive_item_relations.findMany({
      where: { workspaceId: Number(workspaceId) },
    }),
  ]);
  const latest = [];
  const seenKeys = new Set();
  for (const item of items) {
    if (seenKeys.has(item.itemKey)) continue;
    seenKeys.add(item.itemKey);
    latest.push(item);
  }
  const inactive = new Set();
  for (const relation of relations) {
    if (["supersedes", "withdraws"].includes(relation.relationType))
      inactive.add(relation.toItemId);
    if (["confirms", "duplicates", "withdraws"].includes(relation.relationType))
      inactive.add(relation.fromItemId);
  }
  return latest.filter((item) => !inactive.has(item.id));
}

async function enqueueFinalizedTurn({ chat, sourceChannel = "web" } = {}) {
  if (!batchEnabled()) return null;
  if (!chat?.id || !chat?.workspaceId || chat.include === false) return null;
  if (chat.api_session_id || !["web", "agent"].includes(sourceChannel))
    return null;
  const complete = completeTurnContent(chat);
  if (
    !complete ||
    (complete.response.type && complete.response.type !== "chat")
  )
    return null;
  if (chat.thread_id) {
    const thread = await prisma.workspace_threads.findFirst({
      where: {
        id: Number(chat.thread_id),
        workspace_id: Number(chat.workspaceId),
      },
      select: { thread_type: true },
    });
    if (thread?.thread_type === "meeting") return null;
  }
  const scopeKey = scopeKeyForChat(chat);
  const hash = sha(
    json({
      prompt: cleanText(chat.prompt, 100_000),
      response: complete.text,
      sources: sourceCatalog([chat]).map((source) => source.ref),
    })
  );
  let buffer = null;
  try {
    buffer = await prisma.$transaction(async (tx) => {
      await tx.workspace_cognitive_turn_buffer.updateMany({
        where: {
          workspaceId: Number(chat.workspaceId),
          chatId: Number(chat.id),
          contentHash: { not: hash },
          status: { in: ["pending", "claimed", "screened"] },
        },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: "chat_content_replaced",
        },
      });
      const created = await tx.workspace_cognitive_turn_buffer.create({
        data: {
          workspaceId: Number(chat.workspaceId),
          threadId: chat.thread_id ? Number(chat.thread_id) : null,
          scopeKey,
          chatId: Number(chat.id),
          contentHash: hash,
          sourceChannel,
        },
      });
      const pendingTurnCount = await tx.workspace_cognitive_turn_buffer.count({
        where: {
          workspaceId: Number(chat.workspaceId),
          scopeKey,
          status: { in: ["pending", "claimed"] },
        },
      });
      await tx.workspace_cognitive_thread_state.upsert({
        where: {
          workspaceId_scopeKey: {
            workspaceId: Number(chat.workspaceId),
            scopeKey,
          },
        },
        create: {
          workspaceId: Number(chat.workspaceId),
          threadId: chat.thread_id ? Number(chat.thread_id) : null,
          scopeKey,
          lastEnqueuedChatId: Number(chat.id),
          pendingTurnCount,
          lastActivityAt: new Date(),
        },
        update: {
          lastEnqueuedChatId: Number(chat.id),
          pendingTurnCount,
          lastActivityAt: new Date(),
          lastErrorCode: null,
          lastErrorDetail: null,
        },
      });
      return created;
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    buffer = await prisma.workspace_cognitive_turn_buffer.findUnique({
      where: {
        workspaceId_chatId_contentHash: {
          workspaceId: Number(chat.workspaceId),
          chatId: Number(chat.id),
          contentHash: hash,
        },
      },
    });
  }
  await createNextJob(Number(chat.workspaceId), scopeKey);
  return buffer;
}

async function createNextJob(
  workspaceId,
  scopeKey,
  flushReason = null,
  requestedById = null
) {
  const blocker = await prisma.workspace_cognitive_extraction_jobs.findFirst({
    where: {
      workspaceId,
      scopeKey,
      pipelineVersion: PIPELINE_VERSION,
      jobType: "rough_screen",
      status: {
        in: ["pending", "running", "retry_wait", "failed", "budget_blocked"],
      },
    },
    orderBy: { id: "asc" },
  });
  if (blocker) {
    if (flushReason) {
      return await prisma.workspace_cognitive_extraction_jobs.update({
        where: { id: blocker.id },
        data: {
          metadataJson: json({
            ...parseJson(blocker.metadataJson, {}),
            continuationFlushReason: flushReason,
          }),
        },
      });
    }
    return blocker;
  }
  const pending = await prisma.workspace_cognitive_turn_buffer.findMany({
    where: { workspaceId, scopeKey, status: "pending", jobId: null },
    orderBy: { chatId: "asc" },
    take: BATCH_SIZE,
  });
  const plan = extractionPlanForPending(pending.length, flushReason);
  if (!plan) return null;
  const selected = pending.slice(0, plan.take);
  const { pipeline, triggerReason } = plan;
  const ids = selected.map((row) => row.chatId);
  const inputContentHash = sha(
    selected.map((row) => row.contentHash).join(":")
  );
  const idempotencyKey = sha(
    `${PIPELINE_VERSION}:${workspaceId}:${scopeKey}:${pipeline}:${ids.join(",")}:${inputContentHash}`
  );
  try {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.workspace_cognitive_extraction_jobs.create({
        data: {
          workspaceId,
          threadId: selected[0]?.threadId || null,
          requestedById: requestedById ? Number(requestedById) : null,
          mode: triggerReason === "backfill" ? "backfill" : "incremental",
          status: "pending",
          phase: "pending",
          scopeKey,
          triggerReason,
          pipeline,
          pipelineVersion: PIPELINE_VERSION,
          jobType: "rough_screen",
          priority: 20,
          modelMaxTokens: ROUGH_MAX_TOKENS,
          idempotencyKey,
          chatIdsJson: json(ids, "[]"),
          inputContentHash,
          fromChatId: ids[0] || null,
          toChatId: ids[ids.length - 1] || null,
          metadataJson: json({
            bufferIds: selected.map((row) => row.id),
            continuationFlushReason: flushReason || null,
          }),
        },
      });
      await tx.workspace_cognitive_turn_buffer.updateMany({
        where: {
          id: { in: selected.map((row) => row.id) },
          status: "pending",
          jobId: null,
        },
        data: { status: "claimed", jobId: job.id, claimedAt: new Date() },
      });
      await tx.workspace_cognitive_thread_state.updateMany({
        where: { workspaceId, scopeKey },
        data: {
          flushRequestedAt: flushReason ? new Date() : undefined,
          flushReason: flushReason || undefined,
        },
      });
      return job;
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return await prisma.workspace_cognitive_extraction_jobs.findUnique({
      where: { idempotencyKey },
    });
  }
}

async function requestFlush({
  workspaceId,
  threadId = null,
  userId = null,
  reason = "manual",
}) {
  const scopeKey = threadId
    ? `thread:${Number(threadId)}`
    : `overview:user:${Number(userId || 0)}`;
  await prisma.workspace_cognitive_thread_state.updateMany({
    where: { workspaceId: Number(workspaceId), scopeKey },
    data: { flushRequestedAt: new Date(), flushReason: reason },
  });
  const job = await createNextJob(
    Number(workspaceId),
    scopeKey,
    reason,
    userId
  );
  try {
    await createRefineJobsForWorkspace(Number(workspaceId), {
      forcePartial: reason === "manual",
    });
  } catch (error) {
    console.warn("[WorkspaceCognitionBatch] flush aggregation deferred", {
      workspaceId: Number(workspaceId),
      message: error.message,
    });
  }
  return job;
}

async function enqueueThreadBackfill({
  workspaceId,
  threadId,
  userId = null,
  fromChatId = null,
}) {
  const chats = await WorkspaceChats.where(
    {
      workspaceId: Number(workspaceId),
      thread_id: threadId ? Number(threadId) : null,
      api_session_id: null,
      include: true,
      ...(userId ? { user_id: Number(userId) } : {}),
      ...(fromChatId ? { id: { gte: Number(fromChatId) } } : {}),
    },
    null,
    { id: "asc" }
  );
  for (const chat of chats)
    await enqueueFinalizedTurn({ chat, sourceChannel: "web" });
  return await requestFlush({
    workspaceId,
    threadId,
    userId,
    reason: "backfill",
  });
}

function cognitiveNamespace(workspaceId) {
  return `workspace-cognition-${Number(workspaceId)}`;
}

function pendingCognitiveNamespace(workspaceId) {
  return `workspace-cognition-pending-v4-${Number(workspaceId)}`;
}

async function indexCanonicalItem(item) {
  if (process.env.NODE_ENV === "test") return;
  try {
    const VectorDb = getVectorDbClass();
    await VectorDb.addDocumentToNamespace(
      cognitiveNamespace(item.workspaceId),
      {
        pageContent: item.statement,
        docId: `cognitive-item-${item.id}`,
        itemId: item.id,
        itemKey: item.itemKey,
        version: item.version,
        assertionType: item.assertionType,
        workspaceId: item.workspaceId,
      },
      null,
      true
    );
  } catch (error) {
    console.warn("[WorkspaceCognitionBatch] cognitive index unavailable", {
      itemId: item.id,
      message: error.message,
    });
  }
}

async function activeIndexForModel(workspaceId, query = "") {
  const items = await currentCanonicalItems(workspaceId);
  let selected = items;
  if (items.length > 80 && cleanText(query)) {
    try {
      const VectorDb = getVectorDbClass();
      const EmbedderEngine = getEmbeddingEngineSelection();
      const result = await VectorDb.performSimilaritySearch({
        namespace: cognitiveNamespace(workspaceId),
        input: cleanText(query, 8_000),
        LLMConnector: {
          embedTextInput: (input) => EmbedderEngine.embedTextInput(input),
        },
        similarityThreshold: 0.15,
        topN: 12,
      });
      const recalledIds = new Set(
        (result.sources || [])
          .map((source) => Number(source?.metadata?.itemId || source?.itemId))
          .filter(Number.isInteger)
      );
      const recalled = items.filter((item) => recalledIds.has(item.id));
      if (recalled.length) selected = recalled;
    } catch (error) {
      console.warn(
        "[WorkspaceCognitionBatch] using profile fallback for cognitive recall",
        error.message
      );
    }
  }
  return selected.slice(0, 12).map((item) => ({
    id: item.id,
    itemKey: item.itemKey,
    version: item.version,
    assertionType: item.assertionType,
    statement: item.statement,
    isTemporary: item.isTemporary,
  }));
}

async function indexPendingCandidate(candidate) {
  if (process.env.NODE_ENV === "test") return;
  try {
    const VectorDb = getVectorDbClass();
    await VectorDb.addDocumentToNamespace(
      pendingCognitiveNamespace(candidate.workspaceId),
      {
        pageContent: candidate.statement,
        docId: `cognitive-candidate-${candidate.id}`,
        candidateId: candidate.id,
        workspaceId: candidate.workspaceId,
      },
      null,
      true
    );
  } catch (error) {
    console.warn(
      "[WorkspaceCognitionBatch] pending candidate index unavailable",
      {
        candidateId: candidate.id,
        message: error.message,
      }
    );
  }
}

async function pendingCandidatesForModel(workspaceId, query = "") {
  const candidates = await prisma.workspace_cognitive_candidates.findMany({
    where: {
      workspaceId: Number(workspaceId),
      pipelineVersion: PIPELINE_VERSION,
      legacyPipeline: false,
    },
    orderBy: { id: "desc" },
    take: 24,
  });
  if (!candidates.length) return [];
  const events = await prisma.workspace_cognitive_candidate_events.findMany({
    where: {
      candidateId: { in: candidates.map((candidate) => candidate.id) },
      eventType: { in: [...TERMINAL_REVIEW_EVENTS] },
    },
    select: { candidateId: true },
  });
  const reviewed = new Set(events.map((event) => event.candidateId));
  const pending = candidates.filter((candidate) => !reviewed.has(candidate.id));
  let selected = pending;
  if (pending.length > 8 && cleanText(query)) {
    try {
      const VectorDb = getVectorDbClass();
      const EmbedderEngine = getEmbeddingEngineSelection();
      const result = await VectorDb.performSimilaritySearch({
        namespace: pendingCognitiveNamespace(workspaceId),
        input: cleanText(query, 8_000),
        LLMConnector: {
          embedTextInput: (input) => EmbedderEngine.embedTextInput(input),
        },
        similarityThreshold: 0.15,
        topN: 8,
      });
      const recalledIds = new Set(
        (result.sources || [])
          .map((source) =>
            Number(source?.metadata?.candidateId || source?.candidateId)
          )
          .filter(Number.isInteger)
      );
      const recalled = pending.filter((candidate) =>
        recalledIds.has(candidate.id)
      );
      if (recalled.length) selected = recalled;
    } catch {}
  }
  return selected.slice(0, 8).map((candidate) => ({
    id: candidate.id,
    assertionType: candidate.assertionType,
    statement: candidate.statement,
  }));
}

async function persistCandidates(job, candidates, sources) {
  let count = 0;
  for (const candidate of candidates) {
    const evidence = [
      ...candidate.evidenceRefs.map((ref) => ({
        evidenceKind: "context",
        sourceType: "chat_turn",
        sourceRef: `chat:${ref.chatId}:${ref.speaker}`,
        chatId: ref.chatId,
        threadId: ref.threadId ?? job.threadId,
        excerpt: ref.excerpt,
        sourceWorkspaceId: job.workspaceId,
        confidence: candidate.confidence,
      })),
      ...candidate.sourceRefs.map((ref) => {
        const source = sources.find((item) => item.ref === ref);
        return {
          evidenceKind: "supports",
          sourceType: source.sourceType,
          sourceRef: ref,
          documentId: source.documentId,
          chunkId: source.chunkId,
          graphEdgeId: source.graphEdgeId,
          chatId: source.chatId,
          threadId:
            candidate.evidenceRefs.find((item) => item.chatId === source.chatId)
              ?.threadId ?? job.threadId,
          excerpt: source.excerpt,
          sourceWorkspaceId: job.workspaceId,
          confidence: candidate.confidence,
          metadata: source.metadata,
        };
      }),
    ];
    try {
      const created = await prisma.workspace_cognitive_candidates.create({
        data: {
          candidateKey: uuidv4(),
          workspaceId: job.workspaceId,
          threadId: job.threadId,
          extractionJobId: job.id,
          assertionType: candidate.assertionType,
          statement: candidate.statement,
          origin: candidate.origin,
          subjectUserId: candidate.subjectUserId,
          stance: candidate.stance,
          rationale: candidate.rationale,
          conditionsJson: json(candidate.conditions),
          confidence: candidate.confidence,
          sourceChatIdsJson: json([
            ...new Set(candidate.evidenceRefs.map((ref) => ref.chatId)),
          ]),
          evidenceJson: json(evidence),
          suggestedRelationJson: json(candidate.suggestedRelation),
          normalizedHash: normalizedHash(
            candidate.assertionType,
            candidate.statement
          ),
          rawModelOutputJson: json(candidate.raw),
          qualityJson: json(candidate.quality),
          pipelineVersion: PIPELINE_VERSION,
          legacyPipeline: false,
        },
      });
      await indexPendingCandidate(created);
      count += 1;
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }
  }
  return count;
}

function protocolError(error) {
  return /^(model_json_invalid|protocol_output_|screening_|user_gate_|refinement_|candidate_|user_position_|user_origin_|user_cognition_|assistant_origin_|assistant_inference_|document_fact_)/.test(
    String(error?.code || "")
  );
}

function metricNumber(metrics, ...keys) {
  for (const key of keys) {
    const value = Number(metrics?.[key]);
    if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  }
  return 0;
}

async function recordAttempt({
  job,
  stage,
  call = null,
  messages,
  outcome,
  error = null,
  estimatedPromptTokens = null,
  budgetDecision = "allowed",
}) {
  const attemptNo =
    (await prisma.workspace_cognitive_extraction_attempts.count({
      where: { jobId: job.id, stage },
    })) + 1;
  const metrics = call?.metrics || {};
  const duration = Number(metrics.duration || metrics.durationMs || 0);
  await prisma.workspace_cognitive_extraction_attempts.create({
    data: {
      workspaceId: job.workspaceId,
      jobId: job.id,
      stage,
      attemptNo,
      provider: call?.provider || null,
      model: call?.model || metrics.model || null,
      promptTokens: metricNumber(metrics, "prompt_tokens", "promptTokens"),
      completionTokens: metricNumber(
        metrics,
        "completion_tokens",
        "completionTokens"
      ),
      totalTokens: metricNumber(metrics, "total_tokens", "totalTokens"),
      cacheHitTokens: metricNumber(
        metrics,
        "prompt_cache_hit_tokens",
        "cache_hit_tokens",
        "cacheHitTokens"
      ),
      cacheMissTokens: metricNumber(
        metrics,
        "prompt_cache_miss_tokens",
        "cache_miss_tokens",
        "cacheMissTokens"
      ),
      durationMs:
        duration > 0 && duration < 10_000
          ? Math.round(duration * 1000)
          : Math.round(duration),
      inputHash: sha(json(messages)),
      outputHash: call?.raw ? sha(call.raw) : null,
      outcome,
      errorCode: error?.code || null,
      finishReason: metrics.finish_reason || null,
      thinkingMode: metrics.thinking_mode || "disabled",
      reasoningTokens: metricNumber(metrics, "reasoning_tokens"),
      estimatedPromptTokens: estimatedPromptTokens ?? estimatedTokens(messages),
      budgetDecision,
      metricsJson: json(metrics),
    },
  });
}

function repairPrompt(raw, instruction, repairContext = {}) {
  return [
    {
      role: "system",
      content:
        "你是 JSON 协议修复器。只修复结构和引用，只输出一行 JSON，不增加新语义。",
    },
    {
      role: "user",
      content: json({
        error: instruction,
        schema: repairContext.schema || null,
        allowedSegmentIds: repairContext.allowedSegmentIds || [],
        allowedChatIds: repairContext.allowedChatIds || [],
        allowedSourceRefs: repairContext.allowedSourceRefs || [],
        allowedItemIds: repairContext.allowedItemIds || [],
        raw: cleanText(raw, 8_000),
      }),
    },
  ];
}

function budgetOverrideEnabled(job) {
  return parseJson(job?.metadataJson, {}).budgetOverrideOnce === true;
}

function consumedBudgetMetadata(job, extra = {}) {
  const metadata = { ...parseJson(job?.metadataJson, {}), ...extra };
  if (metadata.budgetOverrideOnce === true) {
    metadata.budgetOverrideOnce = false;
    metadata.budgetOverrideUsed = true;
    metadata.budgetOverrideConsumedAt = new Date().toISOString();
  }
  return metadata;
}

function assertPromptBudget(job, messages, limit, stage) {
  const estimate = estimatedTokens(messages);
  if (estimate <= limit || budgetOverrideEnabled(job))
    return {
      estimate,
      decision: estimate <= limit ? "allowed" : "override_once",
    };
  const error = new Error("cognitive_budget_blocked");
  error.code = "cognitive_budget_blocked";
  error.budgetBlocked = true;
  error.nonRetryable = true;
  error.details = { stage, estimatedPromptTokens: estimate, limit };
  throw error;
}

async function runValidatedModel({
  job,
  taskName,
  workspace,
  stage,
  messages,
  maxTokens,
  validate,
  modelOverride = null,
  inputTokenLimit,
  repairContext = {},
}) {
  const budget = assertPromptBudget(job, messages, inputTokenLimit, stage);
  let call = null;
  try {
    call = await completeTask(
      taskName,
      workspace,
      messages,
      maxTokens,
      modelOverride
    );
    if (call?.metrics?.hit_output_limit) {
      const error = new Error("protocol_output_truncated");
      error.code = "protocol_output_truncated";
      throw error;
    }
    if (!call.payload) {
      const error = new Error("model_json_invalid");
      error.code = "model_json_invalid";
      throw error;
    }
    const validated = validate(call.payload);
    await recordAttempt({
      job,
      stage,
      call,
      messages,
      outcome: "success",
      estimatedPromptTokens: budget.estimate,
      budgetDecision: budget.decision,
    });
    return { payload: call.payload, validated };
  } catch (error) {
    await recordAttempt({
      job,
      stage,
      call,
      messages,
      outcome: protocolError(error) ? "protocol_error" : "failed",
      error,
      estimatedPromptTokens: budget.estimate,
      budgetDecision: budget.decision,
    });
    if (!protocolError(error)) throw error;
    if (!call?.raw || call?.metrics?.hit_output_limit) {
      error.code = call?.metrics?.hit_output_limit
        ? "protocol_output_truncated"
        : error.code;
      throw error;
    }
    const metadata = parseJson(job.metadataJson, {});
    const repairedStages = new Set(metadata.protocolRepairedStages || []);
    if (repairedStages.has(stage)) {
      error.nonRetryable = true;
      throw error;
    }
    repairedStages.add(stage);
    const nextMetadata = {
      ...metadata,
      protocolRepairedStages: [...repairedStages],
    };
    await prisma.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        protocolRepairAttempted: true,
        phase: "protocol_repair",
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        metadataJson: json(nextMetadata),
      },
    });
    job.protocolRepairAttempted = true;
    job.metadataJson = json(nextMetadata);
    const repairedMessages = repairPrompt(call.raw, error.code, repairContext);
    const repairBudget = assertPromptBudget(
      job,
      repairedMessages,
      REPAIR_INPUT_TOKENS,
      `protocol_repair:${stage}`
    );
    let repairCall = null;
    try {
      repairCall = await completeTask(
        taskName,
        workspace,
        repairedMessages,
        REPAIR_MAX_TOKENS,
        modelOverride
      );
      if (!repairCall.payload) {
        const parseError = new Error("model_json_invalid");
        parseError.code = "model_json_invalid";
        throw parseError;
      }
      const validated = validate(repairCall.payload);
      await recordAttempt({
        job,
        stage: `protocol_repair:${stage}`,
        call: repairCall,
        messages: repairedMessages,
        outcome: "success",
        estimatedPromptTokens: repairBudget.estimate,
        budgetDecision: repairBudget.decision,
      });
      return { payload: repairCall.payload, validated };
    } catch (repairError) {
      await recordAttempt({
        job,
        stage: `protocol_repair:${stage}`,
        call: repairCall,
        messages: repairedMessages,
        outcome: "failed",
        error: repairError,
        estimatedPromptTokens: repairBudget.estimate,
        budgetDecision: repairBudget.decision,
      });
      repairError.code = "protocol_repair_failed";
      repairError.nonRetryable = true;
      throw repairError;
    }
  }
}

async function loadJobSnapshot(job) {
  const chatIds = parseJson(job.chatIdsJson, []).map(Number);
  const chats = await WorkspaceChats.where(
    { workspaceId: job.workspaceId, id: { in: chatIds }, include: true },
    null,
    { id: "asc" }
  );
  if (chats.length !== chatIds.length)
    throw Object.assign(new Error("job_chat_snapshot_missing"), {
      code: "job_chat_snapshot_missing",
    });
  const workspace = await prisma.workspaces.findUnique({
    where: { id: job.workspaceId },
  });
  if (!workspace)
    throw Object.assign(new Error("workspace_not_found"), {
      code: "workspace_not_found",
    });
  return { chats, workspace };
}

async function refreshThreadStateTx(
  tx,
  workspaceId,
  scopeKey,
  activeJobId = null
) {
  const pendingTurnCount = await tx.workspace_cognitive_turn_buffer.count({
    where: {
      workspaceId,
      scopeKey,
      status: { in: ["pending", "claimed", "screened"] },
    },
  });
  const latestProcessed = await tx.workspace_cognitive_turn_buffer.findFirst({
    where: { workspaceId, scopeKey, status: "processed" },
    orderBy: { chatId: "desc" },
    select: { chatId: true },
  });
  await tx.workspace_cognitive_thread_state.updateMany({
    where: { workspaceId, scopeKey },
    data: {
      pendingTurnCount,
      lastExtractedChatId: latestProcessed?.chatId || undefined,
      activeJobId,
      flushRequestedAt: null,
      flushReason: null,
      lastErrorCode: null,
      lastErrorDetail: null,
      retryCount: 0,
    },
  });
}

async function createRefineGroup(workspaceId, roughResults, partialGroup) {
  const resultIds = roughResults.map((row) => row.id);
  const roughJobs = await prisma.workspace_cognitive_extraction_jobs.findMany({
    where: { id: { in: roughResults.map((row) => row.roughJobId) } },
    select: { mode: true },
  });
  const outputHash = sha(
    roughResults.map((row) => `${row.id}:${row.outputHash}`).join(":")
  );
  const idempotencyKey = sha(
    `${PIPELINE_VERSION}:${workspaceId}:multi_refine:${outputHash}`
  );
  try {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.workspace_cognitive_extraction_jobs.create({
        data: {
          workspaceId,
          threadId: null,
          mode: roughJobs.some((row) => row.mode === "backfill")
            ? "backfill"
            : "incremental",
          status: "pending",
          phase: "pending",
          scopeKey: `workspace-refine:${workspaceId}`,
          triggerReason: partialGroup ? "partial_group" : "rough_group_3",
          pipeline: "multi_refine",
          pipelineVersion: PIPELINE_VERSION,
          jobType: "multi_refine",
          priority: partialGroup ? 15 : 5,
          partialGroup,
          modelMaxTokens: REFINE_MAX_TOKENS,
          idempotencyKey,
          chatIdsJson: json(
            [
              ...new Set(
                roughResults.flatMap((row) => parseJson(row.chatIdsJson, []))
              ),
            ],
            "[]"
          ),
          inputContentHash: outputHash,
          metadataJson: json({ roughResultIds: resultIds }),
        },
      });
      for (const [ordinal, rough] of roughResults.entries()) {
        const claimed = await tx.workspace_cognitive_rough_results.updateMany({
          where: {
            id: rough.id,
            workspaceId,
            status: "ready",
            refineJobId: null,
          },
          data: { status: "claimed", refineJobId: job.id },
        });
        if (!claimed.count)
          throw Object.assign(new Error("rough_result_claim_conflict"), {
            code: "rough_result_claim_conflict",
          });
        await tx.workspace_cognitive_refine_inputs.create({
          data: {
            workspaceId,
            refineJobId: job.id,
            roughResultId: rough.id,
            ordinal,
          },
        });
      }
      return job;
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    return await prisma.workspace_cognitive_extraction_jobs.findUnique({
      where: { idempotencyKey },
    });
  }
}

function refineGroupSize({
  readyCount,
  activeRough = 0,
  oldestReadyAt = null,
  forcePartial = false,
  now = Date.now(),
}) {
  if (Number(readyCount) >= REFINE_GROUP_SIZE) return REFINE_GROUP_SIZE;
  if (Number(readyCount) <= 0 || Number(activeRough) > 0) return 0;
  const expired =
    oldestReadyAt && new Date(oldestReadyAt).getTime() <= now - SILENCE_MS;
  return forcePartial || expired ? Math.min(2, Number(readyCount)) : 0;
}

async function createRefineJobsForWorkspace(
  workspaceId,
  { forcePartial = false } = {}
) {
  const created = [];
  while (true) {
    const ready = await prisma.workspace_cognitive_rough_results.findMany({
      where: { workspaceId, status: "ready", refineJobId: null },
      orderBy: [{ readyAt: "asc" }, { id: "asc" }],
      take: REFINE_GROUP_SIZE,
    });
    if (ready.length >= REFINE_GROUP_SIZE) {
      created.push(await createRefineGroup(workspaceId, ready, false));
      continue;
    }
    if (!ready.length) break;
    const activeRough = await prisma.workspace_cognitive_extraction_jobs.count({
      where: {
        workspaceId,
        pipelineVersion: PIPELINE_VERSION,
        jobType: "rough_screen",
        status: { in: ["pending", "running", "retry_wait"] },
      },
    });
    const partialSize = refineGroupSize({
      readyCount: ready.length,
      activeRough,
      oldestReadyAt: ready[0].readyAt,
      forcePartial,
    });
    if (!partialSize) break;
    created.push(await createRefineGroup(workspaceId, ready, true));
    break;
  }
  return created.filter(Boolean);
}

async function processRoughJob(job) {
  const { chats, workspace } = await loadJobSnapshot(job);
  const buffers = await prisma.workspace_cognitive_turn_buffer.findMany({
    where: { jobId: job.id, status: "claimed" },
    orderBy: { chatId: "asc" },
  });
  if (
    !buffers.length ||
    sha(buffers.map((row) => row.contentHash).join(":")) !==
      job.inputContentHash
  )
    throw Object.assign(new Error("job_content_hash_mismatch"), {
      code: "job_content_hash_mismatch",
      nonRetryable: true,
    });
  const segments = segmentCatalog(chats);
  const segmentMap = new Map(
    segments.map((segment) => [segment.segmentId, segment])
  );
  const userSegments = segments.filter((segment) => segment.speaker === "user");
  let output = parseJson(job.screeningOutputJson, null);
  if (!output) {
    await prisma.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        phase: "rough_user_gate",
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    const scope = await workspaceScope(workspace);
    const aliasedUsers = userSegments.map((segment, index) => ({
      ...segment,
      stableSegmentId: segment.segmentId,
      segmentId: `u${index + 1}`,
    }));
    const gateMessages = userGatePrompt(aliasedUsers, scope);
    const gate = await runValidatedModel({
      job,
      taskName: "workspace_cognitive_screen",
      workspace,
      stage: "rough_user_gate",
      messages: gateMessages,
      maxTokens: USER_GATE_MAX_TOKENS,
      inputTokenLimit: USER_GATE_INPUT_TOKENS,
      modelOverride: ROUGH_MODEL_OVERRIDE,
      repairContext: {
        schema: { keep: ["segment-id"], assistantChatIds: [1] },
        allowedSegmentIds: aliasedUsers.map((segment) => segment.segmentId),
        allowedChatIds: [
          ...new Set(aliasedUsers.map((segment) => segment.chatId)),
        ],
      },
      validate: (payload) => validateUserGate(payload, aliasedUsers),
    });
    const selectedUsers = gate.validated.kept
      .map((segment) => segmentMap.get(segment.stableSegmentId))
      .filter(Boolean)
      .slice(0, MAX_ROUGH_SEGMENTS);
    const assistantSegments = segments
      .filter(
        (segment) =>
          segment.speaker === "assistant" &&
          gate.validated.assistantChatIds.includes(Number(segment.chatId))
      )
      .map((segment, index) => ({
        ...segment,
        stableSegmentId: segment.segmentId,
        segmentId: `a${index + 1}`,
      }));
    let selectedAssistants = [];
    let assistantEvidenceDeferred = false;
    if (selectedUsers.length && assistantSegments.length) {
      const assistantMessages = assistantEvidencePrompt({
        userSegments: selectedUsers,
        assistantSegments,
        scope,
      });
      const remainingBudget = Math.max(
        1,
        ROUGH_INPUT_TOKENS - estimatedTokens(gateMessages)
      );
      if (
        estimatedTokens(assistantMessages) > remainingBudget &&
        !budgetOverrideEnabled(job)
      ) {
        assistantEvidenceDeferred = true;
      } else {
        await prisma.workspace_cognitive_extraction_jobs.update({
          where: { id: job.id },
          data: {
            phase: "rough_assistant_evidence",
            heartbeatAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          },
        });
        const assistant = await runValidatedModel({
          job,
          taskName: "workspace_cognitive_screen",
          workspace,
          stage: "rough_assistant_evidence",
          messages: assistantMessages,
          maxTokens: ASSISTANT_EVIDENCE_MAX_TOKENS,
          inputTokenLimit: remainingBudget,
          modelOverride: ROUGH_MODEL_OVERRIDE,
          repairContext: {
            schema: { keep: ["segment-id"] },
            allowedSegmentIds: assistantSegments.map(
              (segment) => segment.segmentId
            ),
          },
          validate: (payload) => validateScreening(payload, assistantSegments),
        });
        selectedAssistants = assistant.validated
          .map((segment) => segmentMap.get(segment.stableSegmentId))
          .filter(Boolean)
          .slice(0, Math.max(0, MAX_ROUGH_SEGMENTS - selectedUsers.length));
      }
    }
    output = {
      userKeep: selectedUsers.map((segment) => segment.segmentId),
      assistantKeep: selectedAssistants.map((segment) => segment.segmentId),
      assistantChatIds: gate.validated.assistantChatIds,
      assistantEvidenceDeferred,
    };
    await prisma.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        screeningOutputJson: json(output),
        phase: "persisting",
        metadataJson: json({
          ...consumedBudgetMetadata(job, { assistantEvidenceDeferred }),
        }),
      },
    });
  }
  const selectedIds = [
    ...(Array.isArray(output.userKeep) ? output.userKeep : []),
    ...(Array.isArray(output.assistantKeep) ? output.assistantKeep : []),
  ];
  const selected = selectedIds.map((id) => segmentMap.get(id)).filter(Boolean);
  if (selected.length !== selectedIds.length)
    throw Object.assign(new Error("screening_reference_invalid"), {
      code: "screening_reference_invalid",
      nonRetryable: true,
    });
  const segmentRefs = selected.map((segment) => segment.segmentId);
  const roughResult = await prisma.$transaction(async (tx) => {
    const result = await tx.workspace_cognitive_rough_results.upsert({
      where: { roughJobId: job.id },
      create: {
        workspaceId: job.workspaceId,
        roughJobId: job.id,
        threadId: job.threadId,
        scopeKey: job.scopeKey,
        chatIdsJson: job.chatIdsJson,
        inputContentHash: job.inputContentHash,
        segmentRefsJson: json(segmentRefs, "[]"),
        selectionJson: json(output),
        outputHash: sha(json(segmentRefs)),
        status: segmentRefs.length ? "ready" : "empty",
      },
      update: {},
    });
    await tx.workspace_cognitive_turn_buffer.updateMany({
      where: { jobId: job.id, status: "claimed" },
      data: segmentRefs.length
        ? {
            status: "screened",
            screenedAt: new Date(),
            roughResultId: result.id,
          }
        : {
            status: "processed",
            screenedAt: new Date(),
            processedAt: new Date(),
            roughResultId: result.id,
          },
    });
    await tx.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        status: "completed",
        phase: output.assistantEvidenceDeferred
          ? "completed_with_deferred_evidence"
          : "completed",
        extractedCount: 0,
        lastScannedChatId: job.toChatId,
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: new Date(),
        error: null,
        errorCode: null,
        errorDetail: null,
      },
    });
    await refreshThreadStateTx(tx, job.workspaceId, job.scopeKey, null);
    return result;
  });
  const latestJob = await prisma.workspace_cognitive_extraction_jobs.findUnique(
    {
      where: { id: job.id },
      select: { metadataJson: true },
    }
  );
  const continuation =
    parseJson(latestJob?.metadataJson || job.metadataJson, {})
      .continuationFlushReason || null;
  try {
    const nextJob = await createNextJob(
      job.workspaceId,
      job.scopeKey,
      continuation,
      job.requestedById
    );
    await createRefineJobsForWorkspace(job.workspaceId, {
      forcePartial:
        job.triggerReason === "manual" ||
        continuation === "manual" ||
        (continuation === "backfill" && !nextJob),
    });
  } catch (error) {
    console.warn("[WorkspaceCognitionBatch] post-rough scheduling deferred", {
      jobId: job.id,
      message: error.message,
    });
  }
  return roughResult;
}

async function processRefineJob(job) {
  const inputs = await prisma.workspace_cognitive_refine_inputs.findMany({
    where: { workspaceId: job.workspaceId, refineJobId: job.id },
    orderBy: { ordinal: "asc" },
  });
  if (!inputs.length || inputs.length > REFINE_GROUP_SIZE)
    throw Object.assign(new Error("refine_inputs_invalid"), {
      code: "refinement_schema_invalid",
      nonRetryable: true,
    });
  const roughResults = await prisma.workspace_cognitive_rough_results.findMany({
    where: {
      workspaceId: job.workspaceId,
      id: { in: inputs.map((row) => row.roughResultId) },
    },
  });
  const roughById = new Map(roughResults.map((row) => [row.id, row]));
  const orderedRough = inputs.map((input) =>
    roughById.get(input.roughResultId)
  );
  if (
    orderedRough.some(
      (row) => !row || row.refineJobId !== job.id || row.status !== "claimed"
    )
  )
    throw Object.assign(new Error("refine_input_ownership_invalid"), {
      code: "refine_input_ownership_invalid",
      nonRetryable: true,
    });
  const { chats, workspace } = await loadJobSnapshot(job);
  const allSegments = segmentCatalog(chats);
  const segmentMap = new Map(
    allSegments.map((segment) => [segment.segmentId, segment])
  );
  const selected = [];
  for (const rough of orderedRough) {
    const buffers = await prisma.workspace_cognitive_turn_buffer.findMany({
      where: { roughResultId: rough.id },
      orderBy: { chatId: "asc" },
    });
    if (
      sha(buffers.map((row) => row.contentHash).join(":")) !==
      rough.inputContentHash
    )
      throw Object.assign(new Error("refine_content_hash_mismatch"), {
        code: "refine_content_hash_mismatch",
        nonRetryable: true,
      });
    for (const segmentId of parseJson(rough.segmentRefsJson, [])) {
      const segment = segmentMap.get(segmentId);
      if (!segment)
        throw Object.assign(new Error("refine_segment_missing"), {
          code: "refine_segment_missing",
          nonRetryable: true,
        });
      selected.push(segment);
    }
  }
  const sources = dedupedSourceCatalog(chats).slice(0, 12);
  const refineSegments = selected.map((segment, index) => ({
    ...segment,
    stableSegmentId: segment.segmentId,
    segmentId: `r${index + 1}`,
  }));
  const activeItems = await activeIndexForModel(
    job.workspaceId,
    selected.map((segment) => segment.text).join("\n")
  );
  const pendingItems = await pendingCandidatesForModel(
    job.workspaceId,
    selected.map((segment) => segment.text).join("\n")
  );
  const episodes = chats
    .map((chat) => {
      const episodeSegments = refineSegments.filter(
        (segment) => Number(segment.chatId) === Number(chat.id)
      );
      return {
        workspaceId: job.workspaceId,
        threadId: chat.thread_id ? Number(chat.thread_id) : null,
        chatId: Number(chat.id),
        userSegments: episodeSegments
          .filter((segment) => segment.speaker === "user")
          .map(({ segmentId, userId, text }) => ({
            segmentId,
            userId,
            text,
          })),
        assistantSegments: episodeSegments
          .filter((segment) => segment.speaker === "assistant")
          .map(({ segmentId, text }) => ({ segmentId, text })),
        sourceRefs: sources
          .filter((source) => Number(source.chatId) === Number(chat.id))
          .map((source) => source.ref),
      };
    })
    .filter(
      (episode) =>
        episode.userSegments.length || episode.assistantSegments.length
    );
  let output = parseJson(job.refiningOutputJson, null);
  let candidates = [];
  if (output) {
    candidates = validateRefinement(output, {
      segments: refineSegments,
      sources,
      activeItems,
      pendingItems,
    });
  } else {
    await prisma.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        phase: "refining",
        heartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
      },
    });
    const messages = refinePrompt({
      episodes,
      sources,
      activeItems,
      pendingItems,
    });
    const result = await runValidatedModel({
      job,
      taskName: "workspace_cognitive_refine",
      workspace,
      stage: "multi_refine",
      messages,
      maxTokens: REFINE_MAX_TOKENS,
      inputTokenLimit: REFINE_INPUT_TOKENS,
      repairContext: {
        schema: { items: [] },
        allowedSegmentIds: refineSegments.map((segment) => segment.segmentId),
        allowedSourceRefs: sources.map((source) => source.ref),
        allowedItemIds: activeItems.map((item) => item.id),
      },
      validate: (payload) =>
        validateRefinement(payload, {
          segments: refineSegments,
          sources,
          activeItems,
          pendingItems,
        }),
    });
    output = result.payload;
    candidates = result.validated;
    await prisma.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: { refiningOutputJson: json(output), phase: "persisting" },
    });
  }
  const ownership = await prisma.workspace_cognitive_extraction_jobs.findUnique(
    {
      where: { id: job.id },
      select: { status: true, leaseOwner: true },
    }
  );
  if (ownership?.status !== "running" || ownership?.leaseOwner !== workerId)
    throw Object.assign(new Error("job_cancelled_or_lease_lost"), {
      code: "job_cancelled_or_lease_lost",
    });
  const extractedCount = await persistCandidates(job, candidates, sources);
  const roughIds = orderedRough.map((row) => row.id);
  const scopes = [...new Set(orderedRough.map((row) => row.scopeKey))];
  await prisma.$transaction(async (tx) => {
    await tx.workspace_cognitive_turn_buffer.updateMany({
      where: { roughResultId: { in: roughIds }, status: "screened" },
      data: { status: "processed", processedAt: new Date() },
    });
    await tx.workspace_cognitive_rough_results.updateMany({
      where: {
        id: { in: roughIds },
        workspaceId: job.workspaceId,
        refineJobId: job.id,
      },
      data: { status: "consumed" },
    });
    for (const scopeKey of scopes)
      await refreshThreadStateTx(tx, job.workspaceId, scopeKey, null);
    await tx.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        status: "completed",
        phase: "completed",
        extractedCount,
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: new Date(),
        error: null,
        errorCode: null,
        errorDetail: null,
        metadataJson: json(consumedBudgetMetadata(job)),
      },
    });
  });
  try {
    for (const rough of orderedRough)
      await createNextJob(
        job.workspaceId,
        rough.scopeKey,
        null,
        job.requestedById
      );
    await createRefineJobsForWorkspace(job.workspaceId);
  } catch (error) {
    console.warn("[WorkspaceCognitionBatch] post-refine scheduling deferred", {
      jobId: job.id,
      message: error.message,
    });
  }
  return extractedCount;
}

async function processJob(job) {
  if (Number(job.pipelineVersion) !== PIPELINE_VERSION)
    throw Object.assign(new Error("legacy_pipeline_frozen"), {
      code: "legacy_pipeline_frozen",
      nonRetryable: true,
    });
  if (job.jobType === "rough_screen") return await processRoughJob(job);
  if (job.jobType === "multi_refine") return await processRefineJob(job);
  throw Object.assign(new Error("cognitive_job_type_unsupported"), {
    code: "cognitive_job_type_unsupported",
    nonRetryable: true,
  });
}

async function failJob(job, error) {
  const attemptCount = Number(job.attemptCount || 0) + 1;
  const budgetBlocked = error?.budgetBlocked === true;
  const terminal =
    error?.nonRetryable === true ||
    attemptCount >= Number(job.maxAttempts || 5);
  const delay =
    RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)];
  await prisma.$transaction(async (tx) => {
    await tx.workspace_cognitive_extraction_jobs.update({
      where: { id: job.id },
      data: {
        status: budgetBlocked
          ? "budget_blocked"
          : terminal
            ? "failed"
            : "retry_wait",
        attemptCount,
        nextRetryAt:
          terminal || budgetBlocked ? null : new Date(Date.now() + delay),
        leaseOwner: null,
        leaseExpiresAt: null,
        error: cleanText(error?.message, 2_000),
        errorCode: error?.code || "extraction_failed",
        errorDetail: cleanText(
          error?.details ? json(error.details) : error?.stack || error?.message,
          8_000
        ),
        metadataJson: json(consumedBudgetMetadata(job)),
      },
    });
    await tx.workspace_cognitive_thread_state.updateMany({
      where: { workspaceId: job.workspaceId, scopeKey: job.scopeKey },
      data: {
        activeJobId: null,
        lastErrorCode: error?.code || "extraction_failed",
        lastErrorDetail: cleanText(error?.message, 2_000),
        retryCount: attemptCount,
      },
    });
  });
}

async function claimJob() {
  const now = new Date();
  const candidate = await prisma.workspace_cognitive_extraction_jobs.findFirst({
    where: {
      scopeKey: { not: null },
      idempotencyKey: { not: null },
      pipelineVersion: PIPELINE_VERSION,
      status: { in: ["pending", "retry_wait"] },
      AND: [
        { OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
      ],
    },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });
  if (!candidate) return null;
  const result = await prisma.$transaction(async (tx) => {
    if (candidate.jobType === "rough_screen") {
      const stateClaim = await tx.workspace_cognitive_thread_state.updateMany({
        where: {
          workspaceId: candidate.workspaceId,
          scopeKey: candidate.scopeKey,
          pausedAt: null,
          OR: [{ activeJobId: null }, { activeJobId: candidate.id }],
        },
        data: { activeJobId: candidate.id },
      });
      if (!stateClaim.count) return null;
    }
    const jobClaim = await tx.workspace_cognitive_extraction_jobs.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["pending", "retry_wait"] },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: {
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        heartbeatAt: now,
        startedAt: candidate.startedAt || now,
      },
    });
    if (!jobClaim.count) {
      await tx.workspace_cognitive_thread_state.updateMany({
        where: {
          workspaceId: candidate.workspaceId,
          scopeKey: candidate.scopeKey,
          activeJobId: candidate.id,
        },
        data: { activeJobId: null },
      });
      return null;
    }
    return await tx.workspace_cognitive_extraction_jobs.findUnique({
      where: { id: candidate.id },
    });
  });
  return result;
}

async function recoverExpiredLeases() {
  const expired = await prisma.workspace_cognitive_extraction_jobs.findMany({
    where: {
      status: "running",
      pipelineVersion: PIPELINE_VERSION,
      leaseExpiresAt: { lt: new Date() },
      scopeKey: { not: null },
    },
    select: { id: true, workspaceId: true, scopeKey: true },
  });
  for (const job of expired) {
    await prisma.$transaction(async (tx) => {
      await tx.workspace_cognitive_extraction_jobs.updateMany({
        where: {
          id: job.id,
          status: "running",
          leaseExpiresAt: { lt: new Date() },
        },
        data: {
          status: "retry_wait",
          nextRetryAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: "worker_lease_expired",
        },
      });
      await tx.workspace_cognitive_thread_state.updateMany({
        where: {
          workspaceId: job.workspaceId,
          scopeKey: job.scopeKey,
          activeJobId: job.id,
        },
        data: { activeJobId: null },
      });
    });
  }
}

async function scanSilence() {
  const cutoff = new Date(Date.now() - SILENCE_MS);
  const states = await prisma.workspace_cognitive_thread_state.findMany({
    where: {
      // pendingTurnCount intentionally includes screened turns because those
      // have not crossed the extraction watermark yet. It therefore cannot be
      // used to decide whether the remaining rough batch contains 1-4 turns.
      pendingTurnCount: { gt: 0 },
      lastActivityAt: { lte: cutoff },
      pausedAt: null,
      activeJobId: null,
    },
    take: 100,
  });
  for (const state of states) {
    const unscreenedPending =
      await prisma.workspace_cognitive_turn_buffer.count({
        where: {
          workspaceId: state.workspaceId,
          scopeKey: state.scopeKey,
          status: "pending",
          jobId: null,
        },
      });
    if (shouldScheduleSilentRough(unscreenedPending))
      await createNextJob(state.workspaceId, state.scopeKey, "silence");
  }
  const workspaces = await prisma.workspace_cognitive_rough_results.findMany({
    where: {
      status: "ready",
      refineJobId: null,
      readyAt: { lte: cutoff },
    },
    distinct: ["workspaceId"],
    select: { workspaceId: true },
    take: 100,
  });
  for (const row of workspaces)
    await createRefineJobsForWorkspace(row.workspaceId);
}

async function retryExtractionJob(
  workspaceId,
  jobId,
  { budgetOverride = null, actorUserId = null } = {}
) {
  const job = await prisma.workspace_cognitive_extraction_jobs.findFirst({
    where: {
      id: Number(jobId),
      workspaceId: Number(workspaceId),
      status: { in: ["failed", "budget_blocked"] },
      pipelineVersion: PIPELINE_VERSION,
    },
  });
  if (!job) return null;
  const metadata = parseJson(job.metadataJson, {});
  delete metadata.protocolRepairedStages;
  if (budgetOverride === "once") {
    const blockedBudget = parseJson(job.errorDetail, {});
    metadata.budgetOverrideOnce = true;
    metadata.budgetOverrideAuthorizedBy = actorUserId
      ? Number(actorUserId)
      : null;
    metadata.budgetOverrideAuthorizedAt = new Date().toISOString();
    metadata.budgetOverrideReason = "manager_one_time_high_cost_retry";
    metadata.budgetOverrideBudget = {
      stage: blockedBudget.stage || job.phase || null,
      automaticInputLimit: Number(blockedBudget.limit) || null,
      estimatedPromptTokens:
        Number(blockedBudget.estimatedPromptTokens) || null,
      outputTokenLimit: Number(job.modelMaxTokens) || null,
    };
    metadata.budgetOverrideHistory = [
      ...(Array.isArray(metadata.budgetOverrideHistory)
        ? metadata.budgetOverrideHistory
        : []),
      {
        actorUserId: actorUserId ? Number(actorUserId) : null,
        authorizedAt: metadata.budgetOverrideAuthorizedAt,
        reason: metadata.budgetOverrideReason,
        budget: metadata.budgetOverrideBudget,
      },
    ];
  } else {
    metadata.budgetOverrideOnce = false;
  }
  return await prisma.workspace_cognitive_extraction_jobs.update({
    where: { id: job.id },
    data: {
      status: "pending",
      attemptCount: 0,
      nextRetryAt: new Date(),
      error: null,
      errorCode: null,
      errorDetail: null,
      protocolRepairAttempted: false,
      metadataJson: json(metadata),
    },
  });
}

async function listExtractionState(workspaceId) {
  const [threads, jobs, roughResults, attempts] = await Promise.all([
    prisma.workspace_cognitive_thread_state.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: { lastActivityAt: "desc" },
    }),
    prisma.workspace_cognitive_extraction_jobs.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: { id: "desc" },
      take: 100,
    }),
    prisma.workspace_cognitive_rough_results.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: [{ readyAt: "desc" }, { id: "desc" }],
      take: 200,
    }),
    prisma.workspace_cognitive_extraction_attempts.findMany({
      where: { workspaceId: Number(workspaceId) },
      orderBy: { id: "desc" },
      take: 500,
    }),
  ]);
  const attemptsByJob = new Map();
  for (const attempt of attempts) {
    if (!attemptsByJob.has(attempt.jobId)) attemptsByJob.set(attempt.jobId, []);
    attemptsByJob.get(attempt.jobId).push({
      ...attempt,
      metrics: parseJson(attempt.metricsJson, {}),
    });
  }
  const refineInputs = await prisma.workspace_cognitive_refine_inputs.findMany({
    where: {
      workspaceId: Number(workspaceId),
      refineJobId: { in: jobs.map((job) => job.id) },
    },
    orderBy: [{ refineJobId: "desc" }, { ordinal: "asc" }],
  });
  const inputsByJob = new Map();
  for (const input of refineInputs) {
    if (!inputsByJob.has(input.refineJobId))
      inputsByJob.set(input.refineJobId, []);
    inputsByJob.get(input.refineJobId).push(input.roughResultId);
  }
  const readyCount = roughResults.filter(
    (row) => row.status === "ready"
  ).length;
  return {
    threads,
    roughResults: roughResults.map((row) => ({
      ...row,
      chatIds: parseJson(row.chatIdsJson, []),
      segmentRefs: parseJson(row.segmentRefsJson, []),
      selection: parseJson(row.selectionJson, {}),
    })),
    aggregation: {
      readyCount,
      groupProgress: readyCount % REFINE_GROUP_SIZE,
      groupSize: REFINE_GROUP_SIZE,
      oldestReadyAt:
        roughResults
          .filter((row) => row.status === "ready")
          .sort((a, b) => new Date(a.readyAt) - new Date(b.readyAt))[0]
          ?.readyAt || null,
    },
    jobs: jobs.map((job) => ({
      ...job,
      metadata: parseJson(job.metadataJson, {}),
      attempts: attemptsByJob.get(job.id) || [],
      roughResultIds: inputsByJob.get(job.id) || [],
      tokenUsage: (attemptsByJob.get(job.id) || []).reduce(
        (sum, attempt) => ({
          promptTokens: sum.promptTokens + Number(attempt.promptTokens || 0),
          completionTokens:
            sum.completionTokens + Number(attempt.completionTokens || 0),
          totalTokens: sum.totalTokens + Number(attempt.totalTokens || 0),
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      ),
    })),
  };
}

async function reconcileFinalizedTurns(limit = 2_000) {
  const [rollout] = await prisma.$queryRawUnsafe(
    `SELECT "finished_at" FROM "_prisma_migrations"
      WHERE "migration_name" = ? AND "finished_at" IS NOT NULL
      ORDER BY "finished_at" DESC LIMIT 1`,
    "20260714120000_add_batch_cognition_append_only"
  );
  const rawRolloutAt = rollout?.finished_at;
  const rolloutAt = rawRolloutAt
    ? new Date(
        typeof rawRolloutAt === "bigint" ? Number(rawRolloutAt) : rawRolloutAt
      )
    : new Date();
  const rows = await prisma.workspace_chats.findMany({
    where: {
      include: true,
      api_session_id: null,
      createdAt: { gte: rolloutAt },
    },
    orderBy: { id: "desc" },
    take: limit,
    select: { id: true, workspaceId: true },
  });
  for (const row of rows.reverse()) {
    const exists = await prisma.workspace_cognitive_turn_buffer.count({
      where: { workspaceId: row.workspaceId, chatId: row.id },
    });
    if (exists) continue;
    const chat = await WorkspaceChats.get({
      id: row.id,
      workspaceId: row.workspaceId,
    });
    if (!chat) continue;
    const channel =
      chat.created_from === "agent" ? "agent" : chat.created_from || "web";
    await enqueueFinalizedTurn({ chat, sourceChannel: channel }).catch(
      () => null
    );
  }
}

async function backfillLegacyCognition() {
  const assertions = await prisma.workspace_cognitive_assertions.findMany({
    where: { canonicalItemId: null },
    orderBy: { id: "asc" },
  });
  const formalStatuses = new Set([
    "source_backed",
    "user_confirmed",
    "contested",
    "superseded",
  ]);
  for (const assertion of assertions) {
    if (!formalStatuses.has(assertion.verificationStatus)) {
      const candidateKey = `legacy-assertion-${assertion.workspaceId}-${assertion.id}`;
      const candidate = await prisma.workspace_cognitive_candidates.upsert({
        where: { candidateKey },
        create: {
          candidateKey,
          workspaceId: assertion.workspaceId,
          assertionType: assertion.assertionType,
          statement: assertion.statement,
          origin: assertion.createdByType,
          subjectUserId: assertion.createdByUserId,
          confidence: assertion.confidence,
          normalizedHash: assertion.normalizedHash,
          rawModelOutputJson: json({ legacyAssertionId: assertion.id }),
          pipelineVersion: 2,
          legacyPipeline: true,
        },
        update: {},
      });
      if (assertion.verificationStatus === "rejected") {
        const idempotencyKey = `legacy-rejected-${assertion.id}`;
        await prisma.workspace_cognitive_candidate_events.upsert({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId: assertion.workspaceId,
              idempotencyKey,
            },
          },
          create: {
            workspaceId: assertion.workspaceId,
            candidateId: candidate.id,
            eventType: "rejected",
            actorUserId: assertion.createdByUserId,
            idempotencyKey,
            payloadJson: json({ migrated: true }),
          },
          update: {},
        });
      }
      continue;
    }
    const itemKey = `legacy-assertion-${assertion.id}`;
    const item = await prisma.workspace_cognitive_items.upsert({
      where: {
        workspaceId_itemKey_version: {
          workspaceId: assertion.workspaceId,
          itemKey,
          version: 1,
        },
      },
      create: {
        workspaceId: assertion.workspaceId,
        itemKey,
        version: 1,
        assertionType: assertion.assertionType,
        statement: assertion.statement,
        createdByType: assertion.createdByType,
        createdByUserId: assertion.createdByUserId,
        confidence: assertion.confidence,
        disclosureLevel: assertion.disclosureLevel,
        normalizedHash: assertion.normalizedHash,
        metadataJson: json({ legacyAssertionId: assertion.id }),
      },
      update: {},
    });
    await prisma.workspace_cognitive_assertions.update({
      where: { id: assertion.id },
      data: { canonicalItemId: item.id },
    });
    const positions = await prisma.workspace_cognitive_positions.findMany({
      where: { workspaceId: assertion.workspaceId, assertionId: assertion.id },
    });
    for (const position of positions) {
      if (position.status !== "confirmed") continue;
      if (position.canonicalPositionVersionId) continue;
      const canonical =
        await prisma.workspace_cognitive_position_versions.create({
          data: {
            workspaceId: assertion.workspaceId,
            cognitiveItemId: item.id,
            subjectUserId: position.subjectUserId,
            stance: position.stance,
            rationale: position.rationale,
            conditionsJson: position.conditionsJson,
            meetingDisclosure: position.meetingDisclosure,
            isTemporary: false,
            createdAt: position.createdAt,
          },
        });
      await prisma.workspace_cognitive_positions.update({
        where: { id: position.id },
        data: { canonicalPositionVersionId: canonical.id },
      });
    }
    const evidence = await prisma.workspace_cognitive_evidence.findMany({
      where: { workspaceId: assertion.workspaceId, assertionId: assertion.id },
    });
    for (const source of evidence) {
      if (source.canonicalEvidenceId) continue;
      const canonical = await prisma.workspace_cognitive_item_evidence.create({
        data: {
          workspaceId: assertion.workspaceId,
          cognitiveItemId: item.id,
          evidenceKind: source.evidenceKind,
          sourceType: source.sourceType,
          sourceRef: source.sourceRef,
          documentId: source.documentId,
          chunkId: source.chunkId,
          chatId: source.chatId,
          threadId: source.threadId,
          graphEdgeId: source.graphEdgeId,
          sourceWorkspaceId: source.sourceWorkspaceId,
          excerpt: source.excerpt,
          confidence: source.confidence,
          disclosureLevel: source.disclosureLevel,
          metadataJson: source.metadataJson,
          createdAt: source.createdAt,
        },
      });
      await prisma.workspace_cognitive_evidence.update({
        where: { id: source.id },
        data: { canonicalEvidenceId: canonical.id },
      });
      if (source.freshness !== "current") {
        const idempotencyKey = `legacy-evidence-${source.id}-${source.freshness}`;
        await prisma.workspace_cognitive_evidence_events.upsert({
          where: {
            workspaceId_idempotencyKey: {
              workspaceId: assertion.workspaceId,
              idempotencyKey,
            },
          },
          create: {
            workspaceId: assertion.workspaceId,
            evidenceId: canonical.id,
            eventType: source.freshness,
            reason: assertion.reviewReason,
            idempotencyKey,
          },
          update: {},
        });
      }
    }
  }
  const relations = await prisma.workspace_cognitive_relations.findMany({
    where: { canonicalRelationId: null },
    orderBy: { id: "asc" },
  });
  const relationMap = {
    supports: "confirms",
    refutes: "contradicts",
    conflicts_with: "contradicts",
    depends_on: "qualifies",
    answers: "extends",
    supersedes: "supersedes",
    derived_from: "extends",
  };
  for (const relation of relations) {
    const [from, to] = await Promise.all([
      prisma.workspace_cognitive_assertions.findFirst({
        where: {
          id: relation.fromAssertionId,
          workspaceId: relation.workspaceId,
        },
      }),
      prisma.workspace_cognitive_assertions.findFirst({
        where: {
          id: relation.toAssertionId,
          workspaceId: relation.workspaceId,
        },
      }),
    ]);
    if (!from?.canonicalItemId || !to?.canonicalItemId) continue;
    const canonical = await prisma.workspace_cognitive_item_relations.upsert({
      where: {
        workspaceId_fromItemId_toItemId_relationType: {
          workspaceId: relation.workspaceId,
          fromItemId: from.canonicalItemId,
          toItemId: to.canonicalItemId,
          relationType: relationMap[relation.relationType] || "extends",
        },
      },
      create: {
        workspaceId: relation.workspaceId,
        fromItemId: from.canonicalItemId,
        toItemId: to.canonicalItemId,
        relationType: relationMap[relation.relationType] || "extends",
        confidence: relation.confidence,
        createdByType: relation.createdByType,
        createdAt: relation.createdAt,
      },
      update: {},
    });
    await prisma.workspace_cognitive_relations.update({
      where: { id: relation.id },
      data: { canonicalRelationId: canonical.id },
    });
  }
  const workspaceIds = [
    ...new Set(
      assertions
        .filter((row) => formalStatuses.has(row.verificationStatus))
        .map((row) => row.workspaceId)
    ),
  ];
  for (const workspaceId of workspaceIds) {
    const existing = await prisma.workspace_cognitive_profile_state.findUnique({
      where: { workspaceId },
    });
    if (!existing) {
      await prisma.workspace_cognitive_profile_state.create({
        data: {
          workspaceId,
          dirtyGeneration: 1,
          rebuiltGeneration: 0,
          rebuildStatus: "pending",
        },
      });
      await prisma.workspace_cognitive_profile_invalidations.create({
        data: {
          workspaceId,
          generation: 1,
          reason: "legacy_backfill",
          sourceType: "migration",
        },
      });
    }
  }
}

async function workerTick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await recoverExpiredLeases();
    const job = await claimJob();
    if (job) {
      try {
        await processJob(job);
      } catch (error) {
        console.warn("[WorkspaceCognitionBatch] job failed", {
          jobId: job.id,
          message: error.message,
        });
        if (error?.code !== "job_cancelled_or_lease_lost")
          await failJob(job, error);
      }
    }
    await rebuildOneDirtyProfile();
  } finally {
    workerBusy = false;
  }
}

const workerLifecycle = new CognitionWorkerLifecycle({
  recover: async () => {
    await backfillLegacyCognition();
    await reconcileFinalizedTurns();
    const states = await prisma.workspace_cognitive_thread_state.findMany({
      where: { pendingTurnCount: { gt: 0 }, pausedAt: null },
    });
    for (const state of states)
      await createNextJob(
        state.workspaceId,
        state.scopeKey,
        state.flushReason || null
      );
    const ready = await prisma.workspace_cognitive_rough_results.findMany({
      where: { status: "ready", refineJobId: null },
      distinct: ["workspaceId"],
      select: { workspaceId: true },
    });
    for (const row of ready)
      await createRefineJobsForWorkspace(row.workspaceId);
  },
  tick: workerTick,
  scanSilence,
  isBusy: () => workerBusy,
  onRecoveryError: (error) =>
    console.warn(
      "[WorkspaceCognitionBatch] startup recovery failed",
      error.message
    ),
});

function startWorkspaceCognitionWorker() {
  if (process.env.NODE_ENV === "test" || !batchEnabled()) return false;
  return workerLifecycle.start();
}

async function stopWorkspaceCognitionWorker(options = {}) {
  return await workerLifecycle.stop(options);
}

function workspaceCognitionWorkerSnapshot() {
  return workerLifecycle.snapshot();
}

async function candidateReviewState(candidateIds = []) {
  const events = candidateIds.length
    ? await prisma.workspace_cognitive_candidate_events.findMany({
        where: { candidateId: { in: candidateIds } },
        orderBy: { id: "asc" },
      })
    : [];
  const byCandidate = new Map();
  for (const event of events) {
    if (!byCandidate.has(event.candidateId))
      byCandidate.set(event.candidateId, []);
    byCandidate
      .get(event.candidateId)
      .push({ ...event, payload: parseJson(event.payloadJson, {}) });
  }
  return byCandidate;
}

async function listCandidates(
  workspaceId,
  { limit = 200, includeLegacy = false } = {}
) {
  const candidates = await prisma.workspace_cognitive_candidates.findMany({
    where: {
      workspaceId: Number(workspaceId),
      ...(includeLegacy ? {} : { legacyPipeline: false }),
    },
    orderBy: { id: "desc" },
    take: Math.min(500, Math.max(1, Number(limit) || 200)),
  });
  const events = await candidateReviewState(candidates.map((item) => item.id));
  return candidates.map((candidate) => {
    const history = events.get(candidate.id) || [];
    const terminal = [...history]
      .reverse()
      .find((event) => TERMINAL_REVIEW_EVENTS.has(event.eventType));
    return {
      ...candidate,
      conditions: parseJson(candidate.conditionsJson, {}),
      sourceChatIds: parseJson(candidate.sourceChatIdsJson, []),
      evidence: parseJson(candidate.evidenceJson, []),
      suggestedRelation: parseJson(candidate.suggestedRelationJson, {}),
      quality: parseJson(candidate.qualityJson, {}),
      reviewStatus: terminal?.eventType || "pending",
      events: history,
    };
  });
}

async function createManualCandidate({
  workspaceId,
  assertionType,
  statement,
  origin = "user",
  subjectUserId = null,
  stance = null,
  rationale = null,
  conditions = {},
  evidence = [],
  suggestedRelation = {},
} = {}) {
  if (!ASSERTION_TYPES.has(assertionType))
    throw new Error("invalid_assertion_type");
  statement = cleanText(statement, 8_000);
  if (!workspaceId || !statement)
    throw new Error("workspace_and_statement_required");
  const candidateKey = uuidv4();
  const normalizedEvidence = evidence.length
    ? evidence
    : [
        {
          evidenceKind: "context",
          sourceType: "manual_note",
          sourceRef: `manual-candidate:${candidateKey}`,
          sourceWorkspaceId: Number(workspaceId),
          excerpt: statement,
          confidence: 1,
        },
      ];
  return await prisma.workspace_cognitive_candidates.create({
    data: {
      candidateKey,
      workspaceId: Number(workspaceId),
      assertionType,
      statement,
      origin,
      subjectUserId: subjectUserId ? Number(subjectUserId) : null,
      stance,
      rationale: cleanText(rationale, 4_000) || null,
      conditionsJson: json(conditions),
      confidence: 1,
      evidenceJson: json(normalizedEvidence),
      suggestedRelationJson: json(suggestedRelation),
      normalizedHash: normalizedHash(assertionType, statement),
      rawModelOutputJson: json({ manual: true }),
      qualityJson: json({
        retentionReason: "explicit_position",
        workspaceRelevance: 1,
        durability: 1,
        userCentrality: 1,
        manual: true,
      }),
      pipelineVersion: PIPELINE_VERSION,
      legacyPipeline: false,
    },
  });
}

async function invalidateProfileTx(
  tx,
  workspaceId,
  reason,
  sourceType,
  sourceId
) {
  const state = await tx.workspace_cognitive_profile_state.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      dirtyGeneration: 1,
      rebuiltGeneration: 0,
      rebuildStatus: "pending",
    },
    update: {
      dirtyGeneration: { increment: 1 },
      rebuildStatus: "pending",
      lastError: null,
    },
  });
  await tx.workspace_cognitive_profile_invalidations.create({
    data: {
      workspaceId,
      generation: state.dirtyGeneration,
      reason,
      sourceType,
      sourceId: sourceId ? String(sourceId) : null,
    },
  });
  return state;
}

async function projectCanonicalItemTx(tx, item, position, evidence, relation) {
  const projectionType =
    item.assertionType === "user_position" ? "conclusion" : item.assertionType;
  let assertion = await tx.workspace_cognitive_assertions.findFirst({
    where: {
      workspaceId: item.workspaceId,
      normalizedHash: item.normalizedHash,
    },
  });
  if (!assertion) {
    assertion = await tx.workspace_cognitive_assertions.create({
      data: {
        workspaceId: item.workspaceId,
        assertionType: projectionType,
        statement: item.statement,
        verificationStatus:
          item.assertionType === "document_fact"
            ? "source_backed"
            : "user_confirmed",
        confidence: item.confidence,
        createdByType: item.createdByType,
        createdByUserId: item.createdByUserId,
        normalizedHash: item.normalizedHash,
        disclosureLevel: item.disclosureLevel,
        canonicalItemId: item.id,
        reviewReason: item.isTemporary ? "temporary_position" : null,
      },
    });
  } else if (!assertion.canonicalItemId) {
    assertion = await tx.workspace_cognitive_assertions.update({
      where: { id: assertion.id },
      data: {
        verificationStatus:
          item.assertionType === "document_fact"
            ? "source_backed"
            : "user_confirmed",
        canonicalItemId: item.id,
        reviewReason: item.isTemporary ? "temporary_position" : null,
      },
    });
  }
  if (position) {
    const projectedPosition = await tx.workspace_cognitive_positions.create({
      data: {
        workspaceId: item.workspaceId,
        assertionId: assertion.id,
        subjectUserId: position.subjectUserId,
        proposedByUserId: item.createdByUserId,
        stance: position.stance,
        rationale: position.rationale,
        conditionsJson: position.conditionsJson,
        status: "confirmed",
        meetingDisclosure: position.meetingDisclosure,
        confirmedAt: new Date(),
        sourceChatId: evidence.find((row) => row.chatId)?.chatId || null,
        canonicalPositionVersionId: position.id,
      },
    });
    void projectedPosition;
  }
  for (const row of evidence) {
    const projected = await tx.workspace_cognitive_evidence.create({
      data: {
        workspaceId: item.workspaceId,
        assertionId: assertion.id,
        evidenceKind: row.evidenceKind,
        sourceType: row.sourceType,
        sourceRef: `${row.sourceRef}:canonical:${row.id}`,
        documentId: row.documentId,
        chunkId: row.chunkId,
        chatId: row.chatId,
        threadId: row.threadId,
        graphEdgeId: row.graphEdgeId,
        sourceWorkspaceId: row.sourceWorkspaceId,
        excerpt: row.excerpt,
        confidence: row.confidence,
        disclosureLevel: row.disclosureLevel,
        metadataJson: row.metadataJson,
        canonicalEvidenceId: row.id,
      },
    });
    void projected;
  }
  if (relation) {
    const targetAssertion = await tx.workspace_cognitive_assertions.findFirst({
      where: {
        workspaceId: item.workspaceId,
        canonicalItemId: relation.toItemId,
      },
    });
    const relationMap = {
      confirms: "supports",
      extends: "derived_from",
      qualifies: "depends_on",
      contradicts: "conflicts_with",
      supersedes: "supersedes",
      withdraws: "supersedes",
      duplicates: "derived_from",
    };
    if (targetAssertion && targetAssertion.id !== assertion.id) {
      const projected = await tx.workspace_cognitive_relations.create({
        data: {
          workspaceId: item.workspaceId,
          fromAssertionId: assertion.id,
          toAssertionId: targetAssertion.id,
          relationType: relationMap[relation.relationType],
          confidence: relation.confidence,
          createdByType: "user",
          canonicalRelationId: relation.id,
        },
      });
      if (["supersedes", "withdraws"].includes(relation.relationType)) {
        await tx.workspace_cognitive_assertions.update({
          where: { id: targetAssertion.id },
          data: {
            verificationStatus: "superseded",
            supersededById: assertion.id,
          },
        });
      }
      void projected;
    }
  }
  return assertion;
}

async function confirmCandidateTx(
  tx,
  candidate,
  actorUserId,
  eventType,
  payload
) {
  const relationProposal =
    payload.relation || parseJson(candidate.suggestedRelationJson, {});
  const relationType = RELATION_TYPES.has(relationProposal?.relationType)
    ? relationProposal.relationType
    : null;
  const target = relationProposal?.targetItemId
    ? await tx.workspace_cognitive_items.findFirst({
        where: {
          id: Number(relationProposal.targetItemId),
          workspaceId: candidate.workspaceId,
        },
      })
    : null;
  const isVersion =
    target && ["supersedes", "withdraws"].includes(relationType);
  const itemKey = isVersion ? target.itemKey : uuidv4();
  const version = isVersion
    ? (
        await tx.workspace_cognitive_items.aggregate({
          where: { workspaceId: candidate.workspaceId, itemKey },
          _max: { version: true },
        })
      )._max.version + 1
    : 1;
  const statement = cleanText(payload.statement || candidate.statement, 8_000);
  const item = await tx.workspace_cognitive_items.create({
    data: {
      workspaceId: candidate.workspaceId,
      itemKey,
      version,
      candidateId: candidate.id,
      assertionType: candidate.assertionType,
      statement,
      createdByType: candidate.origin,
      createdByUserId:
        candidate.origin === "user"
          ? candidate.subjectUserId || actorUserId
          : actorUserId,
      confidence: candidate.confidence,
      disclosureLevel: payload.disclosureLevel || "workspace_only",
      isTemporary: eventType === "temporary_confirmed",
      normalizedHash: normalizedHash(candidate.assertionType, statement),
      metadataJson: json({ reviewPayload: payload }),
    },
  });
  let position = null;
  if (candidate.assertionType === "user_position") {
    position = await tx.workspace_cognitive_position_versions.create({
      data: {
        workspaceId: candidate.workspaceId,
        cognitiveItemId: item.id,
        subjectUserId: candidate.subjectUserId || actorUserId,
        stance: payload.stance || candidate.stance || "supports",
        rationale: payload.rationale ?? candidate.rationale,
        conditionsJson: json(
          payload.conditions || parseJson(candidate.conditionsJson, {})
        ),
        meetingDisclosure: payload.meetingDisclosure || "workspace_only",
        isTemporary: eventType === "temporary_confirmed",
      },
    });
  }
  const evidenceRows = [];
  for (const source of parseJson(candidate.evidenceJson, [])) {
    evidenceRows.push(
      await tx.workspace_cognitive_item_evidence.create({
        data: {
          workspaceId: candidate.workspaceId,
          cognitiveItemId: item.id,
          evidenceKind: source.evidenceKind || "context",
          sourceType: source.sourceType,
          sourceRef: source.sourceRef,
          documentId: source.documentId || null,
          chunkId: source.chunkId || null,
          chatId: source.chatId ? Number(source.chatId) : null,
          threadId: source.threadId ? Number(source.threadId) : null,
          graphEdgeId: source.graphEdgeId || null,
          sourceWorkspaceId: candidate.workspaceId,
          excerpt: cleanText(source.excerpt, 4_000) || null,
          confidence: Number(source.confidence || candidate.confidence || 0),
          disclosureLevel: source.disclosureLevel || "workspace_only",
          metadataJson: json(source.metadata || {}),
        },
      })
    );
  }
  let relation = null;
  if (relationType && target) {
    relation = await tx.workspace_cognitive_item_relations.create({
      data: {
        workspaceId: candidate.workspaceId,
        fromItemId: item.id,
        toItemId: target.id,
        relationType,
        confidence: Number(
          relationProposal.confidence || candidate.confidence || 0
        ),
        rationale: cleanText(relationProposal.rationale, 2_000) || null,
        createdByType: "user",
        createdByUserId: actorUserId,
      },
    });
  }
  await projectCanonicalItemTx(tx, item, position, evidenceRows, relation);
  await invalidateProfileTx(
    tx,
    candidate.workspaceId,
    eventType,
    "candidate",
    candidate.id
  );
  return item;
}

async function reviewCandidate({
  workspaceId,
  candidateId,
  actorUserId,
  eventType,
  payload = {},
  idempotencyKey,
}) {
  if (!idempotencyKey) throw new Error("idempotency_key_required");
  if (
    ![
      "confirmed",
      "temporary_confirmed",
      "rejected",
      "edited",
      "split",
    ].includes(eventType)
  )
    throw new Error("invalid_review_event");
  const candidate = await prisma.workspace_cognitive_candidates.findFirst({
    where: { id: Number(candidateId), workspaceId: Number(workspaceId) },
  });
  if (!candidate) return null;
  const existing = await prisma.workspace_cognitive_candidate_events.findUnique(
    {
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: Number(workspaceId),
          idempotencyKey,
        },
      },
    }
  );
  if (existing) return { event: existing, replayed: true };
  const prior = await prisma.workspace_cognitive_candidate_events.findFirst({
    where: {
      candidateId: candidate.id,
      eventType: { in: [...TERMINAL_REVIEW_EVENTS] },
    },
  });
  if (prior) throw new Error("candidate_already_reviewed");
  const syncReady = await cognitionSyncReady();
  const result = await prisma.$transaction(async (tx) => {
    const event = await tx.workspace_cognitive_candidate_events.create({
      data: {
        workspaceId: Number(workspaceId),
        candidateId: candidate.id,
        eventType,
        actorUserId: actorUserId ? Number(actorUserId) : null,
        payloadJson: json(payload),
        idempotencyKey,
      },
    });
    let item = null;
    const childCandidates = [];
    if (["confirmed", "temporary_confirmed"].includes(eventType))
      item = await confirmCandidateTx(
        tx,
        candidate,
        Number(actorUserId),
        eventType,
        payload
      );
    if (eventType === "edited") {
      childCandidates.push(
        await tx.workspace_cognitive_candidates.create({
          data: {
            candidateKey: uuidv4(),
            workspaceId: candidate.workspaceId,
            threadId: candidate.threadId,
            extractionJobId: candidate.extractionJobId,
            assertionType: payload.assertionType || candidate.assertionType,
            statement: cleanText(payload.statement, 8_000),
            origin: candidate.origin,
            subjectUserId: candidate.subjectUserId,
            stance: payload.stance || candidate.stance,
            rationale: payload.rationale ?? candidate.rationale,
            conditionsJson: json(
              payload.conditions || parseJson(candidate.conditionsJson, {})
            ),
            confidence: candidate.confidence,
            sourceChatIdsJson: candidate.sourceChatIdsJson,
            evidenceJson: candidate.evidenceJson,
            suggestedRelationJson: json(
              payload.relation || parseJson(candidate.suggestedRelationJson, {})
            ),
            normalizedHash: normalizedHash(
              payload.assertionType || candidate.assertionType,
              payload.statement
            ),
            rawModelOutputJson: json({
              parentCandidateId: candidate.id,
              reviewEdit: payload,
            }),
            qualityJson: candidate.qualityJson,
            pipelineVersion: candidate.pipelineVersion,
            legacyPipeline: candidate.legacyPipeline,
          },
        })
      );
    }
    if (eventType === "split") {
      for (const part of Array.isArray(payload.items) ? payload.items : []) {
        childCandidates.push(
          await tx.workspace_cognitive_candidates.create({
            data: {
              candidateKey: uuidv4(),
              workspaceId: candidate.workspaceId,
              threadId: candidate.threadId,
              extractionJobId: candidate.extractionJobId,
              assertionType: part.assertionType || candidate.assertionType,
              statement: cleanText(part.statement, 8_000),
              origin: candidate.origin,
              subjectUserId: candidate.subjectUserId,
              stance: part.stance || candidate.stance,
              rationale: part.rationale ?? candidate.rationale,
              conditionsJson: json(part.conditions || {}),
              confidence: candidate.confidence,
              sourceChatIdsJson: candidate.sourceChatIdsJson,
              evidenceJson: candidate.evidenceJson,
              suggestedRelationJson: json(part.relation || {}),
              normalizedHash: normalizedHash(
                part.assertionType || candidate.assertionType,
                part.statement
              ),
              rawModelOutputJson: json({
                parentCandidateId: candidate.id,
                splitPart: part,
              }),
              qualityJson: candidate.qualityJson,
              pipelineVersion: candidate.pipelineVersion,
              legacyPipeline: candidate.legacyPipeline,
            },
          })
        );
      }
    }
    if (syncReady) {
      await recordCognitionChange(tx, {
        workspaceId: candidate.workspaceId,
        eventType: "cognition.candidate_reviewed",
        changedPaths: [
          `candidates.${candidate.id}`,
          ...(item ? [`items.${item.id}`] : []),
        ],
        payloadHint: {
          operation: "review",
          candidateId: candidate.id,
          reviewEvent: eventType,
          itemId: item?.id || null,
          childCandidateIds: childCandidates.map((child) => child.id),
        },
      });
    }
    return { event, item, childCandidates, replayed: false };
  });
  if (result.item) await indexCanonicalItem(result.item);
  return result;
}

async function currentCanonicalView(workspaceId) {
  const items = await currentCanonicalItems(workspaceId);
  const ids = items.map((item) => item.id);
  const [positions, evidence, relations] = ids.length
    ? await Promise.all([
        prisma.workspace_cognitive_position_versions.findMany({
          where: { workspaceId, cognitiveItemId: { in: ids } },
        }),
        prisma.workspace_cognitive_item_evidence.findMany({
          where: { workspaceId, cognitiveItemId: { in: ids } },
        }),
        prisma.workspace_cognitive_item_relations.findMany({
          where: {
            workspaceId,
            OR: [{ fromItemId: { in: ids } }, { toItemId: { in: ids } }],
          },
        }),
      ])
    : [[], [], []];
  const evidenceEvents = evidence.length
    ? await prisma.workspace_cognitive_evidence_events.findMany({
        where: {
          workspaceId,
          evidenceId: { in: evidence.map((row) => row.id) },
        },
        orderBy: { id: "asc" },
      })
    : [];
  const latestEvidenceEvent = new Map();
  for (const event of evidenceEvents) {
    if (
      ["stale", "missing", "review_required", "restored"].includes(
        event.eventType
      )
    )
      latestEvidenceEvent.set(event.evidenceId, event);
  }
  const currentEvidence = evidence.filter((row) => {
    const event = latestEvidenceEvent.get(row.id);
    return (
      !event ||
      !["stale", "missing", "review_required"].includes(event.eventType) ||
      event.eventType === "restored"
    );
  });
  return {
    items,
    positions,
    evidence: currentEvidence,
    evidenceEvents,
    relations,
  };
}

async function rebuildCanonicalProfile(workspaceId) {
  workspaceId = Number(workspaceId);
  const state = await prisma.workspace_cognitive_profile_state.upsert({
    where: { workspaceId },
    create: { workspaceId },
    update: { rebuildStatus: "running", lastError: null },
  });
  const generation = state.dirtyGeneration;
  try {
    const [workspace, view, latest] = await Promise.all([
      prisma.workspaces.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, slug: true, openAiPrompt: true },
      }),
      currentCanonicalView(workspaceId),
      prisma.workspace_cognitive_profiles.findFirst({
        where: { workspaceId },
        orderBy: { revision: "desc" },
      }),
    ]);
    const byType = {};
    for (const type of ASSERTION_TYPES) byType[type] = [];
    for (const item of view.items) byType[item.assertionType]?.push(item);
    const positionsByUser = {};
    for (const position of view.positions) {
      const key = String(position.subjectUserId);
      if (!positionsByUser[key]) positionsByUser[key] = [];
      positionsByUser[key].push({
        ...position,
        assertion:
          view.items.find((item) => item.id === position.cognitiveItemId) ||
          null,
      });
    }
    const disputes = view.relations
      .filter((relation) => relation.relationType === "contradicts")
      .map((relation) => ({
        relation,
        left:
          view.items.find((item) => item.id === relation.fromItemId) || null,
        right: view.items.find((item) => item.id === relation.toItemId) || null,
      }));
    const profileBody = {
      scope: {
        workspaceId,
        name: workspace?.name || null,
        slug: workspace?.slug || null,
        objective: workspace?.openAiPrompt || null,
      },
      facts: byType.document_fact,
      conclusions: byType.conclusion,
      decisions: byType.decision,
      hypotheses: byType.hypothesis,
      openQuestions: byType.open_question,
      risks: byType.risk,
      constraints: byType.constraint,
      positionsByUser,
      disputes,
      evidenceCoverage: {
        itemCount: view.items.length,
        coveredItems: new Set(view.evidence.map((row) => row.cognitiveItemId))
          .size,
        ratio: view.items.length
          ? new Set(view.evidence.map((row) => row.cognitiveItemId)).size /
            view.items.length
          : 1,
      },
      canonical: true,
      generation,
    };
    const revision = Number(latest?.revision || 0) + 1;
    const contentHash = sha(json(profileBody));
    const syncReady = await cognitionSyncReady();
    const profile = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace_cognitive_profiles.create({
        data: {
          workspaceId,
          revision,
          profileJson: json(profileBody),
          sourceWatermark: String(generation),
          contentHash,
        },
      });
      for (const item of view.items) {
        await tx.workspace_cognitive_profile_items.create({
          data: {
            workspaceId,
            profileRevision: revision,
            cognitiveItemId: item.id,
            itemKey: item.itemKey,
            itemVersion: item.version,
          },
        });
      }
      if (view.items.length) {
        await tx.workspace_cognitive_assertions.updateMany({
          where: {
            workspaceId,
            canonicalItemId: { in: view.items.map((item) => item.id) },
          },
          data: { profileRevision: revision },
        });
      }
      const update = await tx.workspace_cognitive_profile_state.updateMany({
        where: { workspaceId, dirtyGeneration: generation },
        data: {
          rebuiltGeneration: generation,
          rebuildStatus: "idle",
          lastError: null,
        },
      });
      if (!update.count)
        await tx.workspace_cognitive_profile_state.update({
          where: { workspaceId },
          data: { rebuildStatus: "pending" },
        });
      if (syncReady) {
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.profile_rebuilt",
          changedPaths: ["profile", "items", "positions", "evidence"],
          payloadHint: {
            operation: "rebuild",
            profileId: created.id,
            revision,
            generation,
          },
        });
      }
      return created;
    });
    return profile;
  } catch (error) {
    await prisma.workspace_cognitive_profile_state.update({
      where: { workspaceId },
      data: {
        rebuildStatus: "failed",
        lastError: cleanText(error.message, 2_000),
      },
    });
    throw error;
  }
}

async function rebuildOneDirtyProfile() {
  const state = await prisma.workspace_cognitive_profile_state.findFirst({
    where: { rebuildStatus: { in: ["pending", "failed"] } },
    orderBy: { updatedAt: "asc" },
  });
  if (!state) return null;
  return await rebuildCanonicalProfile(state.workspaceId);
}

async function getProfileState(workspaceId) {
  const state = await prisma.workspace_cognitive_profile_state.findUnique({
    where: { workspaceId: Number(workspaceId) },
  });
  const fallback = {
    dirtyGeneration: 0,
    rebuiltGeneration: 0,
    rebuildStatus: "idle",
  };
  const value = state || fallback;
  return {
    ...value,
    stale:
      value.dirtyGeneration > value.rebuiltGeneration ||
      value.rebuildStatus === "running",
  };
}

async function itemHistory(workspaceId, itemKey) {
  const items = await prisma.workspace_cognitive_items.findMany({
    where: { workspaceId: Number(workspaceId), itemKey: String(itemKey) },
    orderBy: { version: "asc" },
  });
  const ids = items.map((item) => item.id);
  const relations = ids.length
    ? await prisma.workspace_cognitive_item_relations.findMany({
        where: {
          workspaceId: Number(workspaceId),
          OR: [{ fromItemId: { in: ids } }, { toItemId: { in: ids } }],
        },
        orderBy: { id: "asc" },
      })
    : [];
  return { items, relations };
}

async function listLedgerItems(workspaceId) {
  workspaceId = Number(workspaceId);
  const [allItems, activeItems, relations] = await Promise.all([
    prisma.workspace_cognitive_items.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    currentCanonicalItems(workspaceId),
    prisma.workspace_cognitive_item_relations.findMany({
      where: { workspaceId },
      orderBy: { id: "desc" },
    }),
  ]);
  const activeIds = new Set(activeItems.map((item) => item.id));
  return {
    items: allItems.map((item) => ({
      ...item,
      active: activeIds.has(item.id),
    })),
    relations,
  };
}

async function reviseCanonicalItemFromProjection({
  workspaceId,
  canonicalItemId,
  actorUserId = null,
  assertionPatch = {},
  positionId = null,
  positionPatch = {},
} = {}) {
  workspaceId = Number(workspaceId);
  const oldItem = await prisma.workspace_cognitive_items.findFirst({
    where: { id: Number(canonicalItemId), workspaceId },
  });
  if (!oldItem) return null;
  const withdraw =
    ["rejected", "expired", "superseded"].includes(
      assertionPatch.verificationStatus
    ) || ["withdrawn", "superseded"].includes(positionPatch.status);
  const result = await prisma.$transaction(async (tx) => {
    const latest = await tx.workspace_cognitive_items.findFirst({
      where: { workspaceId, itemKey: oldItem.itemKey },
      orderBy: { version: "desc" },
    });
    const statement = cleanText(
      assertionPatch.statement || latest.statement,
      8_000
    );
    const next = await tx.workspace_cognitive_items.create({
      data: {
        workspaceId,
        itemKey: latest.itemKey,
        version: latest.version + 1,
        assertionType: latest.assertionType,
        statement,
        createdByType: "user",
        createdByUserId: actorUserId ? Number(actorUserId) : null,
        confidence:
          assertionPatch.confidence === undefined
            ? latest.confidence
            : Math.max(0, Math.min(1, Number(assertionPatch.confidence) || 0)),
        disclosureLevel:
          assertionPatch.disclosureLevel || latest.disclosureLevel,
        isTemporary: latest.isTemporary,
        normalizedHash: normalizedHash(latest.assertionType, statement),
        metadataJson: json({
          revisedFromItemId: latest.id,
          assertionPatch,
          positionPatch,
        }),
      },
    });
    const relation = await tx.workspace_cognitive_item_relations.create({
      data: {
        workspaceId,
        fromItemId: next.id,
        toItemId: latest.id,
        relationType: withdraw ? "withdraws" : "supersedes",
        confidence: 1,
        rationale: withdraw
          ? "user_withdrew_current_item"
          : "user_revised_current_item",
        createdByType: "user",
        createdByUserId: actorUserId ? Number(actorUserId) : null,
      },
    });
    const oldPositions =
      await tx.workspace_cognitive_position_versions.findMany({
        where: { workspaceId, cognitiveItemId: latest.id },
      });
    const projectionPosition = positionId
      ? await tx.workspace_cognitive_positions.findFirst({
          where: { id: Number(positionId), workspaceId },
        })
      : null;
    const newPositions = [];
    if (!withdraw) {
      for (const oldPosition of oldPositions) {
        const isTarget =
          !projectionPosition ||
          oldPosition.id === projectionPosition.canonicalPositionVersionId;
        newPositions.push(
          await tx.workspace_cognitive_position_versions.create({
            data: {
              workspaceId,
              cognitiveItemId: next.id,
              subjectUserId: oldPosition.subjectUserId,
              stance:
                isTarget && positionPatch.stance
                  ? positionPatch.stance
                  : oldPosition.stance,
              rationale:
                isTarget && positionPatch.rationale !== undefined
                  ? positionPatch.rationale
                  : oldPosition.rationale,
              conditionsJson:
                isTarget && positionPatch.conditions !== undefined
                  ? json(positionPatch.conditions)
                  : oldPosition.conditionsJson,
              meetingDisclosure:
                isTarget && positionPatch.meetingDisclosure
                  ? positionPatch.meetingDisclosure
                  : oldPosition.meetingDisclosure,
              isTemporary: oldPosition.isTemporary,
            },
          })
        );
      }
    }
    const oldEvidence = await tx.workspace_cognitive_item_evidence.findMany({
      where: { workspaceId, cognitiveItemId: latest.id },
    });
    for (const source of oldEvidence) {
      await tx.workspace_cognitive_item_evidence.create({
        data: {
          workspaceId,
          cognitiveItemId: next.id,
          evidenceKind: source.evidenceKind,
          sourceType: source.sourceType,
          sourceRef: source.sourceRef,
          documentId: source.documentId,
          chunkId: source.chunkId,
          chatId: source.chatId,
          threadId: source.threadId,
          graphEdgeId: source.graphEdgeId,
          sourceWorkspaceId: source.sourceWorkspaceId,
          excerpt: source.excerpt,
          confidence: source.confidence,
          disclosureLevel: source.disclosureLevel,
          metadataJson: source.metadataJson,
        },
      });
    }
    await tx.workspace_cognitive_assertions.updateMany({
      where: { workspaceId, canonicalItemId: latest.id },
      data: {
        canonicalItemId: next.id,
        statement,
        normalizedHash: next.normalizedHash,
        confidence: next.confidence,
        disclosureLevel: next.disclosureLevel,
        verificationStatus: withdraw ? "superseded" : undefined,
        reviewReason: withdraw ? "canonical_item_withdrawn" : null,
      },
    });
    if (projectionPosition) {
      const replacement = newPositions.find(
        (row) => row.subjectUserId === projectionPosition.subjectUserId
      );
      await tx.workspace_cognitive_positions.update({
        where: { id: projectionPosition.id },
        data: {
          canonicalPositionVersionId: replacement?.id || null,
          status: withdraw ? "withdrawn" : "confirmed",
          stance: positionPatch.stance || projectionPosition.stance,
          rationale:
            positionPatch.rationale === undefined
              ? projectionPosition.rationale
              : positionPatch.rationale,
          conditionsJson:
            positionPatch.conditions === undefined
              ? projectionPosition.conditionsJson
              : json(positionPatch.conditions),
          meetingDisclosure:
            positionPatch.meetingDisclosure ||
            projectionPosition.meetingDisclosure,
        },
      });
    }
    await invalidateProfileTx(
      tx,
      workspaceId,
      withdraw ? "canonical_withdrawal" : "canonical_revision",
      "item",
      next.id
    );
    return { item: next, relation };
  });
  if (!withdraw) await indexCanonicalItem(result.item);
  return result;
}

async function appendEvidenceEventsForSources({
  workspaceId,
  chatIds = [],
  documentIds = [],
  eventType = "stale",
  reason,
}) {
  if (!prisma.workspace_cognitive_item_evidence?.findMany) return 0;
  const evidence = await prisma.workspace_cognitive_item_evidence.findMany({
    where: {
      workspaceId: Number(workspaceId),
      OR: [
        ...(chatIds.length ? [{ chatId: { in: chatIds.map(Number) } }] : []),
        ...(documentIds.length
          ? [{ documentId: { in: documentIds.map(String) } }]
          : []),
      ],
    },
  });
  if (!evidence.length) return 0;
  await prisma.$transaction(async (tx) => {
    for (const row of evidence) {
      const key = sha(`${workspaceId}:${row.id}:${eventType}:${reason}`);
      await tx.workspace_cognitive_evidence_events.upsert({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: Number(workspaceId),
            idempotencyKey: key,
          },
        },
        create: {
          workspaceId: Number(workspaceId),
          evidenceId: row.id,
          eventType,
          reason,
          idempotencyKey: key,
        },
        update: {},
      });
    }
    const projectionWhere = {
      workspaceId: Number(workspaceId),
      OR: [
        ...(chatIds.length ? [{ chatId: { in: chatIds.map(Number) } }] : []),
        ...(documentIds.length
          ? [{ documentId: { in: documentIds.map(String) } }]
          : []),
      ],
    };
    if (projectionWhere.OR.length) {
      await tx.workspace_cognitive_evidence.updateMany({
        where: projectionWhere,
        data: {
          freshness: eventType === "restored" ? "current" : eventType,
        },
      });
    }
    await invalidateProfileTx(
      tx,
      Number(workspaceId),
      `evidence_${eventType}`,
      "evidence",
      reason
    );
  });
  return evidence.length;
}

async function appendEvidencePolicyEvent({
  workspaceId,
  evidenceId,
  actorUserId = null,
  patch = {},
  idempotencyKey,
} = {}) {
  if (!idempotencyKey) throw new Error("idempotency_key_required");
  const evidence = await prisma.workspace_cognitive_item_evidence.findFirst({
    where: { id: Number(evidenceId), workspaceId: Number(workspaceId) },
  });
  if (!evidence) return null;
  return await prisma.$transaction(async (tx) => {
    const event = await tx.workspace_cognitive_evidence_events.upsert({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: Number(workspaceId),
          idempotencyKey,
        },
      },
      create: {
        workspaceId: Number(workspaceId),
        evidenceId: evidence.id,
        eventType: "policy_changed",
        actorType: "user",
        actorUserId: actorUserId ? Number(actorUserId) : null,
        metadataJson: json(patch),
        idempotencyKey,
      },
      update: {},
    });
    await invalidateProfileTx(
      tx,
      Number(workspaceId),
      "evidence_policy_changed",
      "evidence",
      evidence.id
    );
    return event;
  });
}

async function cancelBufferedChats(
  workspaceId,
  chatIds,
  reason = "chat_deleted"
) {
  const ids = chatIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const affected = await prisma.workspace_cognitive_turn_buffer.findMany({
    where: {
      workspaceId: Number(workspaceId),
      chatId: { in: ids },
      status: { in: ["pending", "claimed", "screened"] },
    },
    select: { jobId: true, roughResultId: true },
  });
  const result = await prisma.workspace_cognitive_turn_buffer.updateMany({
    where: {
      workspaceId: Number(workspaceId),
      chatId: { in: ids },
      status: { in: ["pending", "claimed", "screened"] },
    },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: reason,
    },
  });
  for (const jobId of [
    ...new Set(affected.map((row) => row.jobId).filter(Boolean)),
  ]) {
    await prisma.workspace_cognitive_turn_buffer.updateMany({
      where: { jobId, status: "claimed" },
      data: { status: "pending", jobId: null, claimedAt: null },
    });
    const job = await prisma.workspace_cognitive_extraction_jobs.update({
      where: { id: jobId },
      data: {
        status: "cancelled",
        phase: "cancelled",
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: reason,
      },
    });
    await prisma.workspace_cognitive_thread_state.updateMany({
      where: {
        workspaceId: job.workspaceId,
        scopeKey: job.scopeKey,
        activeJobId: job.id,
      },
      data: { activeJobId: null },
    });
  }
  const roughIds = [
    ...new Set(affected.map((row) => row.roughResultId).filter(Boolean)),
  ];
  for (const roughId of roughIds) {
    const rough = await prisma.workspace_cognitive_rough_results.findUnique({
      where: { id: roughId },
    });
    if (!rough) continue;
    const group = rough.refineJobId
      ? await prisma.workspace_cognitive_rough_results.findMany({
          where: { refineJobId: rough.refineJobId },
        })
      : [rough];
    await prisma.$transaction(async (tx) => {
      if (rough.refineJobId) {
        await tx.workspace_cognitive_extraction_jobs.updateMany({
          where: {
            id: rough.refineJobId,
            status: { in: ["pending", "running", "retry_wait", "failed"] },
          },
          data: {
            status: "cancelled",
            phase: "cancelled",
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            errorCode: reason,
          },
        });
      }
      await tx.workspace_cognitive_rough_results.updateMany({
        where: { id: { in: group.map((row) => row.id) } },
        data: { status: "cancelled" },
      });
      await tx.workspace_cognitive_turn_buffer.updateMany({
        where: {
          roughResultId: { in: group.map((row) => row.id) },
          chatId: { notIn: ids },
          status: "screened",
        },
        data: {
          status: "pending",
          jobId: null,
          roughResultId: null,
          claimedAt: null,
          screenedAt: null,
        },
      });
    });
  }
  const states = await prisma.workspace_cognitive_thread_state.findMany({
    where: { workspaceId: Number(workspaceId) },
  });
  for (const state of states) {
    const pendingTurnCount = await prisma.workspace_cognitive_turn_buffer.count(
      {
        where: {
          workspaceId: Number(workspaceId),
          scopeKey: state.scopeKey,
          status: { in: ["pending", "claimed", "screened"] },
        },
      }
    );
    await prisma.workspace_cognitive_thread_state.update({
      where: { id: state.id },
      data: { pendingTurnCount },
    });
    await createNextJob(Number(workspaceId), state.scopeKey);
  }
  await appendEvidenceEventsForSources({
    workspaceId,
    chatIds: ids,
    eventType: "missing",
    reason,
  });
  return result.count;
}

async function deleteWorkspaceBatchData(workspaceIds = [], db = prisma) {
  const ids = [...new Set(workspaceIds.map(Number))].filter((id) => id > 0);
  if (!ids.length) return;
  if (db === prisma && process.env.NODE_ENV !== "test") {
    const VectorDb = getVectorDbClass();
    for (const id of ids) {
      for (const namespace of [
        cognitiveNamespace(id),
        pendingCognitiveNamespace(id),
      ]) {
        try {
          await VectorDb["delete-namespace"]({ namespace });
        } catch {}
      }
    }
  }
  const where = { workspaceId: { in: ids } };
  const models = [
    "workspace_cognitive_profile_items",
    "workspace_cognitive_profile_state",
    "workspace_cognitive_profile_invalidations",
    "workspace_cognitive_evidence_events",
    "workspace_cognitive_item_evidence",
    "workspace_cognitive_item_relations",
    "workspace_cognitive_position_versions",
    "workspace_cognitive_items",
    "workspace_cognitive_candidate_events",
    "workspace_cognitive_candidates",
    "workspace_cognitive_extraction_attempts",
    "workspace_cognitive_refine_inputs",
    "workspace_cognitive_rough_results",
    "workspace_cognitive_extraction_jobs",
    "workspace_cognitive_thread_state",
    "workspace_cognitive_turn_buffer",
  ];
  for (const model of models) {
    if (db[model]?.deleteMany) await db[model].deleteMany({ where });
  }
}

module.exports = {
  enqueueFinalizedTurn,
  enqueueThreadBackfill,
  requestFlush,
  retryExtractionJob,
  listExtractionState,
  listCandidates,
  createManualCandidate,
  reviewCandidate,
  itemHistory,
  listLedgerItems,
  reviseCanonicalItemFromProjection,
  currentCanonicalView,
  rebuildCanonicalProfile,
  getProfileState,
  appendEvidenceEventsForSources,
  appendEvidencePolicyEvent,
  cancelBufferedChats,
  reconcileFinalizedTurns,
  backfillLegacyCognition,
  startWorkspaceCognitionWorker,
  stopWorkspaceCognitionWorker,
  workspaceCognitionWorkerSnapshot,
  deleteWorkspaceBatchData,
  validateScreening,
  validateUserGate,
  validateRefinement,
  userGatePrompt,
  assistantEvidencePrompt,
  refinePrompt,
  repairPrompt,
  assertPromptBudget,
  scopeKeyForChat,
  extractionPlanForPending,
  shouldScheduleSilentRough,
  segmentCatalog,
  createRefineJobsForWorkspace,
  refineGroupSize,
};
