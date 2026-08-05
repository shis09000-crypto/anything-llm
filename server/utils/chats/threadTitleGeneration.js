const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const WorkspaceThread = lazyDataAccessFacade("workspaceThread");
const WorkspaceChats = lazyDataAccessFacade("workspaceChat");
const crypto = require("crypto");
const PQueue = require("p-queue").default;
const { getTaskConnector } = require("../llmTasks");
const { publishThreadTitleUpdate } = require("./threadTitleEvents");
const { requestInternalService } = require("../microModules");

const TITLE_GENERATION_TIMEOUT_MS = 15_000;
const TITLE_REFRESH_PAGE_SIZE =
  Number(process.env.THREAD_TITLE_REFRESH_PAGE_SIZE) || 100;
const TITLE_REFRESH_RECENT_DAYS = 90;
const DEFAULT_TITLE_REFRESH_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const TITLE_QUEUE_CONCURRENCY = Math.min(
  Math.max(Number(process.env.THREAD_TITLE_QUEUE_CONCURRENCY) || 1, 1),
  2
);

const TITLE_SCOPES = {
  firstUserMessage: "first_user_message",
  firstFiveUserMessages: "first_5_user_messages",
  latestFiveUserMessages: "latest_5_user_messages",
};

const THREAD_TITLE_METADATA_FIELDS = [
  "title",
  "titleSource",
  "titleGeneratedAt",
  "titleHash",
  "titleVersion",
  "titleMessageScope",
  "titleGenerationStatus",
];

const titleQueue = new PQueue({ concurrency: TITLE_QUEUE_CONCURRENCY });
const pendingJobKeys = new Set();
const pendingCallbacks = new Map();
let titleMetadataReadiness = null;

function usesRemoteThreadTitleControl() {
  return ["chat-runtime", "agent-runtime"].includes(
    String(process.env.ATHENA_RUNTIME_ROLE || "")
  );
}

function titleDebug(event, payload = {}) {
  if (process.env.THREAD_TITLE_DEBUG !== "true") return;
  console.log(`[ThreadTitle] ${event}`, JSON.stringify(payload));
}

function parseTitleRefreshCooldownMs(
  value = process.env.THREAD_TITLE_REFRESH_INTERVAL
) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;

  const raw = String(value || "14d")
    .trim()
    .toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) return DEFAULT_TITLE_REFRESH_COOLDOWN_MS;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0)
    return DEFAULT_TITLE_REFRESH_COOLDOWN_MS;

  const unitMs = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * unitMs[match[2]];
}

function dateValueMs(value = null) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();

  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function titleRefreshOnCooldown(thread = null, nowMs = Date.now()) {
  const generatedAtMs = dateValueMs(thread?.titleGeneratedAt);
  if (!Number.isFinite(generatedAtMs)) return false;

  return nowMs - generatedAtMs < parseTitleRefreshCooldownMs();
}

async function titleMetadataReady() {
  if (titleMetadataReadiness !== null) return titleMetadataReadiness;

  try {
    const readiness = await WorkspaceThread.titleMetadataSchemaReady(
      THREAD_TITLE_METADATA_FIELDS
    );
    const prismaReady = Boolean(readiness.prismaReady);
    const dbReady = Boolean(readiness.dbReady);
    titleMetadataReadiness = Boolean(readiness.ready);
    if (!titleMetadataReadiness) {
      console.warn(
        `[ThreadTitle] title metadata schema is not ready. ` +
          `Run prisma migrate deploy and prisma generate before automatic titles can be saved. ` +
          `prismaReady=${prismaReady} dbReady=${dbReady}`
      );
    }
    titleDebug("schema:ready", { prismaReady, dbReady });
  } catch (error) {
    titleMetadataReadiness = false;
    console.warn("[ThreadTitle] schema readiness check failed", error.message);
  }

  return titleMetadataReadiness;
}

function visibleThreadChatClause({
  workspaceId = null,
  threadId = null,
  userId = null,
} = {}) {
  return {
    workspaceId: Number(workspaceId),
    thread_id: Number(threadId),
    user_id: userId ?? null,
    api_session_id: null,
    include: true,
  };
}

function scopedThreadClause({ workspaceId, threadId, userId = null } = {}) {
  if (!workspaceId || !threadId) return null;
  return {
    id: Number(threadId),
    workspace_id: Number(workspaceId),
    ...(userId !== null && userId !== undefined ? { user_id: userId } : {}),
  };
}

async function getScopedThread({ workspaceId, threadId, userId = null } = {}) {
  const clause = scopedThreadClause({ workspaceId, threadId, userId });
  if (!clause) return null;
  return await WorkspaceThread.get(clause);
}

function normalizeUserMessage(message = "") {
  return String(message || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeUserMessages(messages = []) {
  return messages.map(normalizeUserMessage).filter(Boolean);
}

function hashUserMessages(messages = []) {
  const normalized = normalizeUserMessages(messages);
  if (normalized.length === 0) return null;
  return crypto
    .createHash("sha256")
    .update(normalized.join("\n---anythingllm-thread-title---\n"))
    .digest("hex");
}

function effectiveChars(text = "") {
  return Array.from(normalizeUserMessage(text).replace(/\s+/g, ""));
}

function fallbackTitleFromMessage(message = "") {
  const title = effectiveChars(message).slice(0, 12).join("");
  return Array.from(title).length >= 4 ? title : "新的对话";
}

function stripThinkBlocks(text = "") {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function parseTitleFromJson(text = "") {
  const cleaned = stripThinkBlocks(text)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return typeof parsed?.title === "string" ? parsed.title : "";
  } catch {}

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objectMatch) return "";

  try {
    const parsed = JSON.parse(objectMatch[0]);
    return typeof parsed?.title === "string" ? parsed.title : "";
  } catch {
    return "";
  }
}

function sanitizeTitle(rawTitle = "", fallbackMessage = "") {
  let title = String(rawTitle || "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "")
    .replace(/[。！？!?,，、；;：:·.《》<>【】[\]（）(){}]/g, "")
    .trim();

  let usedFallback = false;
  if (!title) {
    title = fallbackTitleFromMessage(fallbackMessage);
    usedFallback = true;
  }

  const chars = Array.from(title);
  if (chars.length > 12) title = chars.slice(0, 12).join("");

  const nextChars = Array.from(title);
  const understandableShortTitle =
    nextChars.length >= 2 && /[\p{Script=Han}A-Za-z0-9]/u.test(title);
  if (nextChars.length < 4 && !understandableShortTitle) {
    title = "新的对话";
    usedFallback = true;
  }

  return { title, usedFallback };
}

async function userPromptsForScope({
  workspaceId,
  threadId,
  userId = null,
  scope,
}) {
  const clause = visibleThreadChatClause({ workspaceId, threadId, userId });
  if (scope === TITLE_SCOPES.firstUserMessage) {
    const chats = await WorkspaceChats.where(clause, 1, { id: "asc" });
    return chats.map((chat) => chat.prompt);
  }

  if (scope === TITLE_SCOPES.firstFiveUserMessages) {
    const chats = await WorkspaceChats.where(clause, 5, { id: "asc" });
    return chats.map((chat) => chat.prompt);
  }

  const chats = await WorkspaceChats.where(clause, 5, { id: "desc" });
  return chats.reverse().map((chat) => chat.prompt);
}

function titlePrompt(messages = []) {
  return [
    {
      role: "system",
      content:
        '你是聊天标题生成器。根据用户消息生成4到12字中文标题。只输出JSON对象，格式必须是{"title":"标题"}。不要解释。不要标点。如果内容模糊，title使用“新的对话”。',
    },
    {
      role: "user",
      content: messages
        .map((message, index) => `${index + 1}. ${message}`)
        .join("\n"),
    },
  ];
}

function withTimeout(promise, timeoutMs = TITLE_GENERATION_TIMEOUT_MS) {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("thread_title_generation_timeout")),
      timeoutMs
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeout)
  );
}

async function generateTitle({ messages = [] } = {}) {
  const { connector: llm } = getTaskConnector("thread_title_generation");
  const completion = await withTimeout(
    llm.getChatCompletion(titlePrompt(messages), {
      temperature: 0,
      responseFormat: { type: "json_object" },
    })
  );
  const rawTitle = parseTitleFromJson(completion?.textResponse || "");
  return sanitizeTitle(rawTitle, messages[0] || "");
}

function firstMessageFallbackTitle(messages = []) {
  return {
    title: fallbackTitleFromMessage(messages[0] || ""),
    usedFallback: true,
    failureReason: "first_message_fallback",
  };
}

function callbacksForKey(key) {
  if (!pendingCallbacks.has(key)) pendingCallbacks.set(key, []);
  return pendingCallbacks.get(key);
}

async function runCallbacks(key, thread) {
  const callbacks = pendingCallbacks.get(key) || [];
  pendingCallbacks.delete(key);
  await Promise.all(
    callbacks.map(async (callback) => {
      try {
        await callback?.(thread);
      } catch (error) {
        console.warn("[ThreadTitle] title callback failed", error.message);
      }
    })
  );
}

async function runTitleGenerationJob({
  workspaceId,
  threadId,
  userId = null,
  scope,
}) {
  titleDebug("job:start", { workspaceId, threadId, userId, scope });
  const remoteControl = usesRemoteThreadTitleControl();
  if (!remoteControl) {
    const thread = await getScopedThread({ workspaceId, threadId, userId });
    if (!thread || thread.titleSource === "manual") {
      titleDebug("job:skip", {
        workspaceId,
        threadId,
        scope,
        reason: !thread ? "missing_thread" : "manual_locked",
      });
      return null;
    }
  }
  const prompts = await userPromptsForScope({
    workspaceId,
    threadId,
    userId,
    scope,
  });
  const normalizedPrompts = normalizeUserMessages(prompts);
  if (normalizedPrompts.length === 0) throw new Error("no_user_messages");

  const titleHash = hashUserMessages(normalizedPrompts);
  let lease = null;
  if (remoteControl) {
    let claimed;
    try {
      claimed = await requestInternalService({
        callerRole: String(process.env.ATHENA_RUNTIME_ROLE),
        targetModule: "athena-api",
        capability: "workspace.thread-title.claim",
        contractVersion: "1.0",
        url: `${String(
          process.env.ATHENA_API_INTERNAL_URL || "https://anything-llm-api:3024"
        ).replace(/\/+$/, "")}/internal/v1/workspace/thread-title/claim`,
        body: { workspaceId, threadId, userId, scope, titleHash },
        idempotencyKey: `${threadId}:${scope}:${titleHash}`,
        timeoutMs: 10_000,
      });
    } catch (error) {
      if (error?.code === "thread_title_claim_rejected") {
        titleDebug("job:skip", {
          workspaceId,
          threadId,
          scope,
          reason: "lease_rejected",
        });
        return null;
      }
      throw error;
    }
    lease = claimed.lease;
  }
  let result;
  try {
    result = await generateTitle({
      messages: normalizedPrompts,
    });
    titleDebug("llm:success", {
      workspaceId,
      threadId,
      scope,
      title: result.title,
      usedFallback: result.usedFallback,
    });
  } catch (error) {
    result = firstMessageFallbackTitle(normalizedPrompts);
    titleDebug("llm:fallback", {
      workspaceId,
      threadId,
      scope,
      reason: error.message,
      title: result.title,
    });
  }

  const updatedThread = remoteControl
    ? (
        await requestInternalService({
          callerRole: String(process.env.ATHENA_RUNTIME_ROLE),
          targetModule: "athena-api",
          capability: "workspace.thread-title.commit",
          contractVersion: "1.0",
          url: `${String(
            process.env.ATHENA_API_INTERNAL_URL ||
              "https://anything-llm-api:3024"
          ).replace(/\/+$/, "")}/internal/v1/workspace/thread-title/commit`,
          body: {
            lease,
            title: result.title,
            titleSource: result.usedFallback ? "first_message" : "llm",
          },
          idempotencyKey: `${threadId}:${scope}:${titleHash}:commit`,
          timeoutMs: 10_000,
        })
      ).thread
    : await WorkspaceThread.updateAutomaticTitle({
        threadId,
        title: result.title,
        titleSource: result.usedFallback ? "first_message" : "llm",
        titleHash,
        titleMessageScope: scope,
      });
  titleDebug("db:save", {
    workspaceId,
    threadId,
    scope,
    saved: !!updatedThread,
    title: result.title,
    titleSource: result.usedFallback ? "first_message" : "llm",
  });
  if (!updatedThread) throw new Error("title_update_skipped");
  return updatedThread;
}

async function enqueueThreadTitleGeneration({
  workspaceId,
  threadId,
  userId = null,
  scope,
  onTitle = null,
} = {}) {
  if (!workspaceId || !threadId || !scope) return { queued: false };
  const remoteControl = usesRemoteThreadTitleControl();
  if (!remoteControl && !(await titleMetadataReady()))
    return { queued: false, skipped: "schema_missing" };

  const key = `${threadId}:${scope}`;
  if (pendingJobKeys.has(key)) {
    if (onTitle) callbacksForKey(key).push(onTitle);
    return { queued: false, deduped: true };
  }

  if (!remoteControl) {
    const thread = await getScopedThread({ workspaceId, threadId, userId });
    if (!thread || thread.titleSource === "manual") {
      titleDebug("enqueue:skip", {
        workspaceId,
        threadId,
        scope,
        reason: !thread ? "missing_thread" : "manual_locked",
      });
      return { queued: false, skipped: "manual_or_missing" };
    }
    const markedPending = await WorkspaceThread.markTitleGenerationPending(
      threadId,
      scope
    );
    if (!markedPending) return { queued: false, skipped: "manual_or_missing" };
  }

  if (onTitle) callbacksForKey(key).push(onTitle);
  pendingJobKeys.add(key);
  titleDebug("enqueue:queued", { workspaceId, threadId, userId, scope });
  titleQueue
    .add(async () => {
      try {
        const updatedThread = await runTitleGenerationJob({
          workspaceId,
          threadId,
          userId,
          scope,
        });
        if (updatedThread) {
          // The API owns thread metadata and publishes the distributed title
          // event as part of the atomic commit. Publishing again here would
          // make clients apply the same title twice.
          if (!remoteControl) publishThreadTitleUpdate(updatedThread);
          titleDebug("event:callbacks", {
            workspaceId,
            threadId,
            scope,
            callbackCount: pendingCallbacks.get(key)?.length || 0,
          });
          await runCallbacks(key, updatedThread);
        }
      } catch (error) {
        console.warn("[ThreadTitle] generation failed", error.message);
        if (!remoteControl)
          await WorkspaceThread.markTitleGenerationFailed(threadId, scope);
      } finally {
        pendingJobKeys.delete(key);
        pendingCallbacks.delete(key);
      }
    })
    .catch((error) =>
      console.warn("[ThreadTitle] queue task failed", error.message)
    );

  return { queued: true };
}

async function maybeEnqueueTitleGenerationAfterChat({
  workspaceId,
  threadId,
  userId = null,
  include = true,
  apiSessionId = null,
  onTitle = null,
} = {}) {
  if (!workspaceId || !threadId || !include || apiSessionId) {
    titleDebug("trigger:skip", {
      workspaceId,
      threadId,
      include,
      apiSessionId,
      reason: "invalid_chat_context",
    });
    return;
  }

  try {
    const remoteControl = usesRemoteThreadTitleControl();
    let thread = null;
    if (!remoteControl) {
      thread = await getScopedThread({ workspaceId, threadId, userId });
      if (!thread || thread.titleSource === "manual") {
        titleDebug("trigger:skip", {
          workspaceId,
          threadId,
          reason: !thread ? "missing_thread" : "manual_locked",
        });
        return;
      }
    }
    const count = await WorkspaceChats.count(
      visibleThreadChatClause({ workspaceId, threadId, userId })
    );
    titleDebug("trigger:count", {
      workspaceId,
      threadId,
      userId,
      count,
    });

    if (count === 1) {
      await enqueueThreadTitleGeneration({
        workspaceId,
        threadId,
        userId,
        scope: TITLE_SCOPES.firstUserMessage,
        onTitle,
      });
      return;
    }

    if (
      count === 5 &&
      (remoteControl ||
        ![
          TITLE_SCOPES.firstFiveUserMessages,
          TITLE_SCOPES.latestFiveUserMessages,
        ].includes(thread?.titleMessageScope))
    ) {
      await enqueueThreadTitleGeneration({
        workspaceId,
        threadId,
        userId,
        scope: TITLE_SCOPES.firstFiveUserMessages,
        onTitle,
      });
      return;
    }
    titleDebug("trigger:skip", {
      workspaceId,
      threadId,
      count,
      reason: "no_matching_scope",
    });
  } catch (error) {
    console.warn("[ThreadTitle] trigger failed", error.message);
  }
}

async function requestThreadTitleGeneration(context = {}) {
  // Agent finalization reaches Chat Runtime through the durable
  // chat.finalized event. Keeping this edge asynchronous avoids a forbidden
  // Chat Runtime <-> Agent Runtime RPC cycle while preserving one title owner.
  if (String(process.env.ATHENA_RUNTIME_ROLE || "") === "agent-runtime")
    return { queued: false, delegated: "chat_finalized_event" };
  return await maybeEnqueueTitleGenerationAfterChat(context);
}

async function refreshRecentThreadTitles({
  pageSize = TITLE_REFRESH_PAGE_SIZE,
  waitForIdle = true,
} = {}) {
  const cutoff = new Date(
    Date.now() - TITLE_REFRESH_RECENT_DAYS * 24 * 60 * 60 * 1000
  );
  const seenThreadIds = new Set();
  let cursorId = null;
  let scannedChats = 0;
  let queued = 0;

  while (true) {
    const chats = await WorkspaceChats.whereMetadata(
      {
        include: true,
        api_session_id: null,
        thread_id: { not: null },
        lastUpdatedAt: { gte: cutoff },
        ...(cursorId ? { id: { lt: cursorId } } : {}),
      },
      pageSize,
      { id: "desc" }
    );
    if (chats.length === 0) break;

    scannedChats += chats.length;
    cursorId = chats[chats.length - 1].id;

    for (const chat of chats) {
      if (!chat.thread_id || seenThreadIds.has(chat.thread_id)) continue;
      seenThreadIds.add(chat.thread_id);

      const remoteControl = usesRemoteThreadTitleControl();
      let thread = null;
      if (!remoteControl) {
        thread = await getScopedThread({
          workspaceId: chat.workspaceId,
          threadId: chat.thread_id,
          userId: chat.user_id ?? null,
        });
        if (!thread || thread.titleSource === "manual") continue;
        if (titleRefreshOnCooldown(thread)) continue;
      }

      const prompts = await userPromptsForScope({
        workspaceId: chat.workspaceId,
        threadId: chat.thread_id,
        userId: chat.user_id ?? null,
        scope: TITLE_SCOPES.latestFiveUserMessages,
      });
      const titleHash = hashUserMessages(prompts);
      if (!titleHash || (!remoteControl && titleHash === thread?.titleHash))
        continue;

      const result = await enqueueThreadTitleGeneration({
        workspaceId: chat.workspaceId,
        threadId: chat.thread_id,
        userId: chat.user_id ?? null,
        scope: TITLE_SCOPES.latestFiveUserMessages,
      });
      if (result.queued) queued += 1;
    }
  }

  if (waitForIdle) await titleQueue.onIdle();
  return { scannedChats, scannedThreads: seenThreadIds.size, queued };
}

module.exports = {
  TITLE_SCOPES,
  normalizeUserMessage,
  normalizeUserMessages,
  hashUserMessages,
  parseTitleFromJson,
  sanitizeTitle,
  fallbackTitleFromMessage,
  enqueueThreadTitleGeneration,
  maybeEnqueueTitleGenerationAfterChat,
  requestThreadTitleGeneration,
  refreshRecentThreadTitles,
  _internals: {
    titleQueue,
    pendingJobKeys,
    getScopedThread,
    scopedThreadClause,
    userPromptsForScope,
    runTitleGenerationJob,
    generateTitle,
    titleMetadataReady,
    parseTitleRefreshCooldownMs,
    titleRefreshOnCooldown,
    resetTitleMetadataReadiness: () => {
      titleMetadataReadiness = null;
    },
  },
};
