const prisma = require("../utils/prisma");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const {
  rebuildChatCryptoChainFromChatId,
} = require("../utils/security/chatHistorySerialEncryption");
const slugifyModule = require("slugify");
const { v4: uuidv4 } = require("uuid");
const { resolveThreadChatModel } = require("../utils/chats/threadChatModel");
const {
  threadHistoryFingerprint,
} = require("../utils/chats/threadHistoryFingerprint");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");

const THREAD_TYPES = {
  chat: "chat",
  overview: "overview",
  meeting: "meeting",
};
const THREAD_CREATED_FROM = {
  workspaceDefault: "workspace_default",
};

const UNTITLED_THREAD_ALIASES = new Set([
  "",
  "new thread",
  "thread",
  "新线程",
  "新しいスレッド",
]);

function isUntitledThread(thread = {}) {
  if (thread.thread_type && thread.thread_type !== THREAD_TYPES.chat)
    return false;
  if (thread.titleSource === "manual") return false;
  const title = String(thread.title || "")
    .trim()
    .toLowerCase();
  const name = String(thread.name || "")
    .trim()
    .toLowerCase();
  return (
    UNTITLED_THREAD_ALIASES.has(title) && UNTITLED_THREAD_ALIASES.has(name)
  );
}

function threadProjection(thread = {}) {
  const isUntitled = isUntitledThread(thread);
  return {
    ...thread,
    ...(isUntitled ? { title: null } : {}),
    isUntitled,
    titleSource: thread.titleSource || null,
    titleGenerationStatus: thread.titleGenerationStatus || "idle",
    titleVersion: Number(thread.titleVersion || 0),
  };
}

function threadSyncContent(thread = {}) {
  const {
    id,
    workspace_id,
    user_id,
    slug,
    name,
    title,
    titleVersion,
    titleSource,
    titleGenerationStatus,
    thread_type,
    chatModel,
    archivedAt,
  } = thread;
  return threadProjection({
    id,
    workspace_id,
    user_id,
    slug,
    name,
    title,
    titleVersion,
    titleSource,
    titleGenerationStatus,
    thread_type,
    chatModel,
    archivedAt,
  });
}

async function workspaceThreadsIndexContent(tx, workspaceId, userId = null) {
  return await tx.workspace_threads
    .findMany({
      where: {
        workspace_id: Number(workspaceId),
        ...(userId
          ? { OR: [{ user_id: Number(userId) }, { user_id: null }] }
          : {}),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        title: true,
        titleSource: true,
        titleGenerationStatus: true,
        titleVersion: true,
        thread_type: true,
        chatModel: true,
        archivedAt: true,
      },
      orderBy: { id: "asc" },
    })
    .then((threads) => threads.map(threadProjection));
}

async function workspaceAudience(tx, workspaceId, fallbackUserId = null) {
  const users = (
    await tx.workspace_users.findMany({
      where: { workspace_id: Number(workspaceId) },
      select: { user_id: true },
    })
  ).map((row) => Number(row.user_id));
  if (fallbackUserId) users.push(Number(fallbackUserId));
  return [...new Set(users.filter((id) => id > 0))];
}

function workspaceThreadIndexChange(workspaceId, operation) {
  return {
    // A workspace thread index is projected per requesting user. Its event is
    // therefore deliberately aggregate-only: private thread identifiers stay
    // inside the authorized thread node and domain API.
    changedPaths: ["threads"],
    payloadHint: { workspaceId: Number(workspaceId), operation },
  };
}

function placeholders(values = []) {
  return values.map(() => "?").join(",");
}

async function ensureThreadMoveTables() {
  const { WorkspaceChatCompaction } = require("./workspaceChatCompaction");
  const { WorkspaceMindMaps } = require("./workspaceMindMaps");
  const { ensureQuizLearningTables } = require("../utils/quiz/learningRecords");

  await WorkspaceChatCompaction.ensureTable();
  await WorkspaceMindMaps.ensureTable();
  await ensureQuizLearningTables();
}

async function quizAttemptIdsForChatIds(tx, sourceWorkspaceId, chatIds = []) {
  if (chatIds.length === 0) return [];
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id" FROM "workspace_quiz_attempts"
      WHERE "workspaceId" = ? AND "quizChatId" IN (${placeholders(chatIds)})`,
    Number(sourceWorkspaceId),
    ...chatIds
  );
  return rows.map((row) => Number(row.id)).filter((id) => id > 0);
}

async function moveQuizLearningRecords({
  tx,
  sourceWorkspaceId,
  targetWorkspaceId,
  chatIds = [],
  attemptIds = [],
}) {
  if (chatIds.length > 0) {
    await tx.$executeRawUnsafe(
      `UPDATE "workspace_quiz_attempts"
        SET "workspaceId" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "workspaceId" = ? AND "quizChatId" IN (${placeholders(chatIds)})`,
      Number(targetWorkspaceId),
      Number(sourceWorkspaceId),
      ...chatIds
    );

    await tx.$executeRawUnsafe(
      `UPDATE "workspace_quiz_favorite_questions"
        SET "workspaceId" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "workspaceId" = ? AND "quizChatId" IN (${placeholders(chatIds)})`,
      Number(targetWorkspaceId),
      Number(sourceWorkspaceId),
      ...chatIds
    );
  }

  if (attemptIds.length > 0) {
    await tx.$executeRawUnsafe(
      `UPDATE "workspace_quiz_wrong_questions"
        SET "workspaceId" = ?, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "workspaceId" = ? AND "attemptId" IN (${placeholders(attemptIds)})`,
      Number(targetWorkspaceId),
      Number(sourceWorkspaceId),
      ...attemptIds
    );
  }
}

async function moveThreadMindMaps({
  tx,
  sourceWorkspaceId,
  targetWorkspaceId,
  threadId,
}) {
  await tx.$executeRawUnsafe(
    `DELETE FROM "workspace_mind_maps"
      WHERE "workspaceId" = ? AND "thread_id" = ?
        AND EXISTS (
          SELECT 1 FROM "workspace_mind_maps" target
          WHERE target."workspaceId" = ?
            AND target."cacheUserKey" = "workspace_mind_maps"."cacheUserKey"
            AND target."sourceHash" = "workspace_mind_maps"."sourceHash"
        )`,
    Number(sourceWorkspaceId),
    Number(threadId),
    Number(targetWorkspaceId)
  );

  await tx.$executeRawUnsafe(
    `UPDATE "workspace_mind_maps"
      SET "workspaceId" = ?, "lastUpdatedAt" = CURRENT_TIMESTAMP
      WHERE "workspaceId" = ? AND "thread_id" = ?`,
    Number(targetWorkspaceId),
    Number(sourceWorkspaceId),
    Number(threadId)
  );
}

const WorkspaceThread = {
  defaultName: "New Thread",
  defaultChatName: "New Thread",
  overviewName: "Overview",
  THREAD_TYPES,
  THREAD_CREATED_FROM,
  writable: [
    "name",
    "parent_thread_id",
    "thread_type",
    "chatModel",
    "created_from",
    "forked_at_message_id",
    "forked_at",
  ],

  withDisplayTitle: function (thread = null) {
    if (!thread) return null;
    const projected = threadProjection(thread);
    const displayTitle = projected.isUntitled
      ? null
      : projected.title || projected.name;
    return {
      ...projected,
      name: displayTitle || projected.name,
      displayTitle,
    };
  },

  withLastChatActivity: async function (
    threads = [],
    workspaceId = null,
    userId = null
  ) {
    if (!workspaceId || threads.length === 0) return threads;

    const threadIds = threads
      .map((thread) => thread?.id)
      .filter((id) => Number.isFinite(Number(id)))
      .map(Number);
    if (threadIds.length === 0) return threads;

    try {
      const latestChats = await prisma.workspace_chats.groupBy({
        by: ["thread_id"],
        where: {
          workspaceId: Number(workspaceId),
          user_id: userId ? Number(userId) : null,
          api_session_id: null,
          include: true,
          thread_id: { in: threadIds },
        },
        _max: {
          createdAt: true,
          id: true,
        },
      });
      const latestByThreadId = new Map(
        latestChats.map((row) => [
          row.thread_id,
          {
            lastChatAt: row._max.createdAt,
            lastChatId: row._max.id,
          },
        ])
      );

      return threads.map((thread) => ({
        ...thread,
        lastChatAt: latestByThreadId.get(thread.id)?.lastChatAt || null,
        lastChatId: latestByThreadId.get(thread.id)?.lastChatId || null,
        historyFingerprint: threadHistoryFingerprint({
          threadId: thread.id,
          historyRevision: thread.historyRevision,
          latestChatAt: latestByThreadId.get(thread.id)?.lastChatAt || null,
          latestChatId: latestByThreadId.get(thread.id)?.lastChatId || null,
        }),
      }));
    } catch (error) {
      console.error(error.message);
      return threads.map((thread) => ({
        ...thread,
        lastChatAt: null,
        lastChatId: null,
        historyFingerprint: threadHistoryFingerprint({
          threadId: thread.id,
          historyRevision: thread.historyRevision,
        }),
      }));
    }
  },

  historyFingerprintManifest: async function ({
    threads = [],
    userId = null,
  } = {}) {
    const normalizedThreads = threads
      .filter((thread) => Number.isFinite(Number(thread?.id)))
      .map((thread) => ({ ...thread, id: Number(thread.id) }));
    if (!normalizedThreads.length) return [];

    const activity = await prisma.workspace_chats.groupBy({
      by: ["thread_id"],
      where: {
        thread_id: { in: normalizedThreads.map((thread) => thread.id) },
        user_id: userId ? Number(userId) : null,
        api_session_id: null,
        include: true,
      },
      _max: { id: true, lastUpdatedAt: true },
    });
    const activityByThread = new Map(
      activity.map((row) => [Number(row.thread_id), row._max])
    );
    return normalizedThreads.map((thread) => {
      const latest = activityByThread.get(thread.id) || {};
      const historyRevision = Math.max(0, Number(thread.historyRevision) || 0);
      const latestChatId = latest.id || null;
      const latestChatAt = latest.lastUpdatedAt || null;
      return {
        threadId: thread.id,
        historyRevision,
        latestChatId,
        latestChatAt,
        historyFingerprint: threadHistoryFingerprint({
          threadId: thread.id,
          historyRevision,
          latestChatId,
          latestChatAt,
        }),
      };
    });
  },

  isOverviewThread: function (thread = null) {
    return thread?.thread_type === THREAD_TYPES.overview;
  },

  sortForDisplay: function (threads = []) {
    return [...threads].sort((a, b) => {
      const rank = (thread) => {
        if (thread?.thread_type === THREAD_TYPES.overview) return 0;
        return 1;
      };
      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;
      const latestDiff = threadLatestTime(b) - threadLatestTime(a);
      if (latestDiff !== 0) return latestDiff;
      const latestIdDiff =
        Number(b?.lastChatId || 0) - Number(a?.lastChatId || 0);
      if (latestIdDiff !== 0) return latestIdDiff;
      return new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0);
    });
  },

  /**
   * The default Slugify module requires some additional mapping to prevent downstream issues
   * if the user is able to define a slug externally. We have to block non-escapable URL chars
   * so that is the slug is rendered it doesn't break the URL or UI when visited.
   * @param  {...any} args - slugify args for npm package.
   * @returns {string}
   */
  slugify: function (...args) {
    slugifyModule.extend({
      "+": " plus ",
      "!": " bang ",
      "@": " at ",
      "*": " splat ",
      ".": " dot ",
      ":": "",
      "~": "",
      "(": "",
      ")": "",
      "'": "",
      '"': "",
      "|": "",
    });
    return slugifyModule(...args);
  },

  new: async function (workspace, userId = null, data = {}) {
    try {
      const createData = {
        ...(data.sourceActionId
          ? { sourceActionId: String(data.sourceActionId) }
          : {}),
        name: data.name ? String(data.name) : this.defaultName,
        slug: data.slug
          ? this.slugify(data.slug, { lowercase: true })
          : uuidv4(),
        user_id: userId ? Number(userId) : null,
        workspace_id: workspace.id,
        chatModel: resolveThreadChatModel(workspace, data),
        ...(data.parent_thread_id
          ? { parent_thread_id: Number(data.parent_thread_id) }
          : {}),
        ...(data.thread_type ? { thread_type: String(data.thread_type) } : {}),
        ...(data.created_from
          ? { created_from: String(data.created_from) }
          : {}),
        ...(data.forked_at_message_id
          ? { forked_at_message_id: Number(data.forked_at_message_id) }
          : {}),
        ...(data.forked_at ? { forked_at: data.forked_at } : {}),
      };
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      const thread = syncReady
        ? await prisma.$transaction(async (tx) => {
            const created = await tx.workspace_threads.create({
              data: createData,
            });
            const audience = await workspaceAudience(tx, workspace.id, userId);
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.threadMetadata(created.id),
              content: threadSyncContent(created),
              eventType: "thread.created",
              changedPaths: ["$"],
              payloadHint: {
                workspaceId: workspace.id,
                workspaceSlug: workspace.slug,
                threadId: created.id,
                threadSlug: created.slug,
              },
              mutationId: data.sourceActionId || null,
              audience,
            });
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.workspaceThreadsIndex(workspace.id),
              content: await workspaceThreadsIndexContent(
                tx,
                workspace.id,
                userId
              ),
              eventType: "thread.index.updated",
              ...workspaceThreadIndexChange(workspace.id, "add"),
              mutationId: data.sourceActionId || null,
              audience,
            });
            return created;
          })
        : await prisma.workspace_threads.create({ data: createData });

      return { thread: this.withDisplayTitle(thread), message: null };
    } catch (error) {
      if (error?.code === "state_version_conflict") throw error;
      console.error(error.message);
      return { thread: null, message: error.message };
    }
  },

  ensureDefaultThreads: async function (workspace, userId = null) {
    const userClause = { user_id: userId ? Number(userId) : null };
    const clause = {
      workspace_id: workspace.id,
      ...userClause,
    };

    const existingThreads = await this.where(clause);
    let overviewThread = existingThreads.find((thread) =>
      this.isOverviewThread(thread)
    );
    let chatThread = existingThreads.find(
      (thread) =>
        thread.thread_type === THREAD_TYPES.chat &&
        thread.created_from === THREAD_CREATED_FROM.workspaceDefault
    );

    if (!overviewThread) {
      const result = await this.new(workspace, userId, {
        name: this.overviewName,
        thread_type: THREAD_TYPES.overview,
        created_from: THREAD_CREATED_FROM.workspaceDefault,
      });
      overviewThread = result.thread;
    }

    if (!chatThread) {
      const result = await this.new(workspace, userId, {
        name: this.defaultChatName,
        thread_type: THREAD_TYPES.chat,
        created_from: THREAD_CREATED_FROM.workspaceDefault,
      });
      chatThread = result.thread;
    }

    const threads = await this.where(clause);
    return {
      overviewThread,
      chatThread,
      threads: this.sortForDisplay(threads),
    };
  },

  ensureOverviewThread: async function (workspace, userId = null) {
    const userClause = { user_id: userId ? Number(userId) : null };
    const clause = {
      workspace_id: workspace.id,
      ...userClause,
    };

    const existingThreads = await this.where(clause);
    let overviewThread = existingThreads.find((thread) =>
      this.isOverviewThread(thread)
    );
    const chatThread =
      existingThreads.find(
        (thread) =>
          thread.thread_type === THREAD_TYPES.chat &&
          thread.created_from === THREAD_CREATED_FROM.workspaceDefault
      ) || null;

    if (!overviewThread) {
      const result = await this.new(workspace, userId, {
        name: this.overviewName,
        thread_type: THREAD_TYPES.overview,
        created_from: THREAD_CREATED_FROM.workspaceDefault,
      });
      overviewThread = result.thread;
    }

    const threads = await this.where(clause);
    return {
      overviewThread,
      chatThread,
      threads: this.sortForDisplay(threads),
    };
  },

  update: async function (prevThread = null, data = {}, syncContext = {}) {
    if (!prevThread) throw new Error("No thread id provided for update");

    if (this.isOverviewThread(prevThread)) {
      return {
        thread: this.withDisplayTitle(prevThread),
        message: "Overview thread cannot be updated.",
      };
    }

    const validData = {};
    Object.entries(data).forEach(([key, value]) => {
      if (!this.writable.includes(key)) return;
      validData[key] = key === "name" ? String(value) : value;
    });

    if (Object.keys(validData).length === 0)
      return {
        thread: this.withDisplayTitle(prevThread),
        message: "No valid fields to update!",
      };

    if (validData.hasOwnProperty("name")) {
      validData.title = validData.name;
      validData.titleSource = "manual";
      validData.titleGenerationStatus = "idle";
      validData.titleGeneratedAt = new Date();
      validData.titleVersion = { increment: 1 };
    }

    try {
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      const thread = syncReady
        ? await prisma.$transaction(async (tx) => {
            const nodeKey = nodeKeys.threadMetadata(prevThread.id);
            const changedPaths =
              syncContext.changedPaths || Object.keys(validData);
            await SyncV2.assertMutationVersion(tx, {
              nodeKey,
              baseVersion: syncContext.baseVersion,
              changedPaths,
            });
            const updated = await tx.workspace_threads.update({
              where: { id: prevThread.id },
              data: { ...validData, lastUpdatedAt: new Date() },
            });
            const audience = await workspaceAudience(
              tx,
              updated.workspace_id,
              updated.user_id
            );
            await SyncV2.recordNodeChange(tx, {
              nodeKey,
              content: threadSyncContent(updated),
              eventType: "thread.updated",
              changedPaths,
              payloadHint: {
                workspaceId: updated.workspace_id,
                threadId: updated.id,
                threadSlug: updated.slug,
              },
              originClientId: syncContext.originClientId,
              mutationId: syncContext.mutationId,
              audience,
            });
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.workspaceThreadsIndex(updated.workspace_id),
              content: await workspaceThreadsIndexContent(
                tx,
                updated.workspace_id,
                updated.user_id
              ),
              eventType: "thread.index.updated",
              ...workspaceThreadIndexChange(updated.workspace_id, "update"),
              originClientId: syncContext.originClientId,
              mutationId: syncContext.mutationId,
              audience,
            });
            return updated;
          })
        : await prisma.workspace_threads.update({
            where: { id: prevThread.id },
            data: { ...validData, lastUpdatedAt: new Date() },
          });
      return { thread: this.withDisplayTitle(thread), message: null };
    } catch (error) {
      if (error?.code === "state_version_conflict") throw error;
      console.error(error.message);
      return { thread: null, message: error.message };
    }
  },

  get: async function (clause = {}) {
    try {
      const thread = await prisma.workspace_threads.findFirst({
        where: clause,
      });

      return this.withDisplayTitle(thread) || null;
    } catch (error) {
      throwModelDataAccessError("WorkspaceThread.get", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  delete: async function (clause = {}) {
    try {
      const threads = await prisma.workspace_threads.findMany({
        where: clause,
        select: { id: true, workspace_id: true },
      });
      for (const thread of threads) {
        const chatIds = (
          await prisma.workspace_chats.findMany({
            where: {
              workspaceId: thread.workspace_id,
              thread_id: thread.id,
            },
            select: { id: true },
          })
        ).map((row) => row.id);
        if (chatIds.length) {
          const { WorkspaceCognition } = require("./workspaceCognition");
          await WorkspaceCognition.cancelBufferedChats(
            thread.workspace_id,
            chatIds,
            "thread_deleted"
          );
        }
      }
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      if (!syncReady) {
        await prisma.workspace_threads.deleteMany({ where: clause });
        return true;
      }
      await prisma.$transaction(async (tx) => {
        const deletedThreads = await tx.workspace_threads.findMany({
          where: clause,
        });
        const audienceByWorkspace = new Map();
        for (const thread of deletedThreads) {
          if (!audienceByWorkspace.has(thread.workspace_id)) {
            audienceByWorkspace.set(
              thread.workspace_id,
              await workspaceAudience(tx, thread.workspace_id, thread.user_id)
            );
          }
        }
        await tx.workspace_threads.deleteMany({ where: clause });
        for (const thread of deletedThreads) {
          const audience = audienceByWorkspace.get(thread.workspace_id) || [];
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.threadMetadata(thread.id),
            content: { deleted: true },
            deletedAt: new Date(),
            eventType: "thread.deleted",
            changedPaths: ["$delete"],
            payloadHint: {
              workspaceId: thread.workspace_id,
              threadId: thread.id,
              threadSlug: thread.slug,
            },
            audience,
          });
        }
        for (const [workspaceId, audience] of audienceByWorkspace.entries()) {
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.workspaceThreadsIndex(workspaceId),
            content: await workspaceThreadsIndexContent(tx, workspaceId),
            eventType: "thread.index.updated",
            ...workspaceThreadIndexChange(workspaceId, "delete"),
            audience,
          });
        }
      });
      return true;
    } catch (error) {
      throwModelDataAccessError("workspaceThread.delete", error);
    }
  },

  archive: async function (thread = null, userId = null) {
    if (!thread?.id || this.isOverviewThread(thread)) return null;
    const syncReady =
      SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
    const archived = syncReady
      ? await prisma.$transaction(async (tx) => {
          const updated = await tx.workspace_threads.update({
            where: { id: Number(thread.id) },
            data: { archivedAt: new Date(), lastUpdatedAt: new Date() },
          });
          const audience = await workspaceAudience(
            tx,
            updated.workspace_id,
            updated.user_id
          );
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.threadMetadata(updated.id),
            content: threadSyncContent(updated),
            eventType: "thread.archived",
            changedPaths: ["archivedAt"],
            payloadHint: {
              workspaceId: updated.workspace_id,
              threadId: updated.id,
              threadSlug: updated.slug,
            },
            audience,
          });
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.workspaceThreadsIndex(updated.workspace_id),
            content: await workspaceThreadsIndexContent(
              tx,
              updated.workspace_id,
              updated.user_id
            ),
            eventType: "thread.index.updated",
            ...workspaceThreadIndexChange(updated.workspace_id, "archive"),
            audience,
          });
          return updated;
        })
      : await prisma.workspace_threads.update({
          where: { id: Number(thread.id) },
          data: { archivedAt: new Date(), lastUpdatedAt: new Date() },
        });
    const { WorkspaceCognition } = require("./workspaceCognition");
    await WorkspaceCognition.requestFlush({
      workspaceId: archived.workspace_id,
      threadId: archived.id,
      userId,
      reason: "archive",
    });
    return this.withDisplayTitle(archived);
  },

  restore: async function (thread = null) {
    if (!thread?.id) return null;
    const syncReady =
      SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
    const restored = syncReady
      ? await prisma.$transaction(async (tx) => {
          const updated = await tx.workspace_threads.update({
            where: { id: Number(thread.id) },
            data: { archivedAt: null, lastUpdatedAt: new Date() },
          });
          const audience = await workspaceAudience(
            tx,
            updated.workspace_id,
            updated.user_id
          );
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.threadMetadata(updated.id),
            content: threadSyncContent(updated),
            eventType: "thread.restored",
            changedPaths: ["archivedAt"],
            payloadHint: {
              workspaceId: updated.workspace_id,
              threadId: updated.id,
              threadSlug: updated.slug,
            },
            audience,
          });
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.workspaceThreadsIndex(updated.workspace_id),
            content: await workspaceThreadsIndexContent(
              tx,
              updated.workspace_id,
              updated.user_id
            ),
            eventType: "thread.index.updated",
            ...workspaceThreadIndexChange(updated.workspace_id, "restore"),
            audience,
          });
          return updated;
        })
      : await prisma.workspace_threads.update({
          where: { id: Number(thread.id) },
          data: { archivedAt: null, lastUpdatedAt: new Date() },
        });
    return this.withDisplayTitle(restored);
  },

  moveToWorkspace: async function ({
    thread = null,
    sourceWorkspace = null,
    targetWorkspace = null,
  } = {}) {
    if (!thread?.id) return { thread: null, message: "No thread provided." };
    if (!sourceWorkspace?.id)
      return { thread: null, message: "No source workspace provided." };
    if (!targetWorkspace?.id)
      return { thread: null, message: "No target workspace provided." };
    if (this.isOverviewThread(thread)) {
      return {
        thread: this.withDisplayTitle(thread),
        message: "Overview thread cannot be moved.",
      };
    }

    const sourceWorkspaceId = Number(sourceWorkspace.id);
    const targetWorkspaceId = Number(targetWorkspace.id);
    const threadId = Number(thread.id);
    if (sourceWorkspaceId === targetWorkspaceId) {
      return {
        thread: this.withDisplayTitle(thread),
        message: "Thread is already in the target workspace.",
      };
    }

    try {
      await ensureThreadMoveTables();
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      const result = await prisma.$transaction(async (tx) => {
        const sourceThread = await tx.workspace_threads.findFirst({
          where: {
            id: threadId,
            workspace_id: sourceWorkspaceId,
            user_id: thread.user_id ?? null,
          },
        });

        if (!sourceThread)
          throw new Error("Thread does not belong to source workspace.");
        if (this.isOverviewThread(sourceThread))
          throw new Error("Overview thread cannot be moved.");

        const chatRows = await tx.workspace_chats.findMany({
          where: {
            workspaceId: sourceWorkspaceId,
            thread_id: threadId,
          },
          select: { id: true, user_id: true, api_session_id: true },
        });
        const chatIds = chatRows.map((row) => Number(row.id));
        const movedChatScopes = new Map();
        for (const row of chatRows) {
          const key = JSON.stringify({
            userId: row.user_id ?? null,
            apiSessionId: row.api_session_id ?? null,
          });
          const current = movedChatScopes.get(key);
          if (!current || Number(row.id) < current.startChatId) {
            movedChatScopes.set(key, {
              userId: row.user_id ?? null,
              apiSessionId: row.api_session_id ?? null,
              startChatId: Number(row.id),
            });
          }
        }
        const quizAttemptIds = await quizAttemptIdsForChatIds(
          tx,
          sourceWorkspaceId,
          chatIds
        );

        await moveThreadMindMaps({
          tx,
          sourceWorkspaceId,
          targetWorkspaceId,
          threadId,
        });

        const updatedThread = await tx.workspace_threads.update({
          where: { id: threadId },
          data: {
            workspace_id: targetWorkspaceId,
            lastUpdatedAt: new Date(),
          },
        });

        const movedChats = await tx.workspace_chats.updateMany({
          where: {
            workspaceId: sourceWorkspaceId,
            thread_id: threadId,
          },
          data: {
            workspaceId: targetWorkspaceId,
            lastUpdatedAt: new Date(),
          },
        });
        if (tx.workspace_cognitive_turn_buffer?.updateMany) {
          await tx.workspace_cognitive_turn_buffer.updateMany({
            where: {
              workspaceId: sourceWorkspaceId,
              threadId,
              status: { in: ["pending", "claimed"] },
            },
            data: { workspaceId: targetWorkspaceId },
          });
          await tx.workspace_cognitive_extraction_jobs.updateMany({
            where: {
              workspaceId: sourceWorkspaceId,
              threadId,
              status: { in: ["pending", "running", "retry_wait", "failed"] },
            },
            data: { workspaceId: targetWorkspaceId },
          });
          await tx.workspace_cognitive_thread_state.updateMany({
            where: { workspaceId: sourceWorkspaceId, threadId },
            data: { workspaceId: targetWorkspaceId, pausedAt: null },
          });
        }

        for (const scope of movedChatScopes.values()) {
          await rebuildChatCryptoChainFromChatId(
            {
              workspaceId: targetWorkspaceId,
              userId: scope.userId,
              threadId,
              apiSessionId: scope.apiSessionId,
            },
            scope.startChatId,
            { client: tx, reencrypt: true }
          );
        }

        await tx.workspace_parsed_files.updateMany({
          where: {
            workspaceId: sourceWorkspaceId,
            threadId,
          },
          data: {
            workspaceId: targetWorkspaceId,
          },
        });

        await tx.$executeRawUnsafe(
          `UPDATE "workspace_chat_compactions"
            SET "workspace_id" = ?, "updated_at" = CURRENT_TIMESTAMP
            WHERE "workspace_id" = ? AND "thread_id" = ?`,
          targetWorkspaceId,
          sourceWorkspaceId,
          threadId
        );

        await tx.workspace_agent_invocations.updateMany({
          where: {
            workspace_id: sourceWorkspaceId,
            thread_id: threadId,
          },
          data: {
            workspace_id: targetWorkspaceId,
            lastUpdatedAt: new Date(),
          },
        });

        await moveQuizLearningRecords({
          tx,
          sourceWorkspaceId,
          targetWorkspaceId,
          chatIds,
          attemptIds: quizAttemptIds,
        });

        if (syncReady) {
          const sourceAudience = await workspaceAudience(
            tx,
            sourceWorkspaceId,
            sourceThread.user_id
          );
          const targetAudience = await workspaceAudience(
            tx,
            targetWorkspaceId,
            sourceThread.user_id
          );
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.threadMetadata(updatedThread.id),
            content: threadSyncContent(updatedThread),
            eventType: "thread.moved",
            changedPaths: ["workspace_id"],
            payloadHint: {
              threadId: updatedThread.id,
              threadSlug: updatedThread.slug,
              sourceWorkspaceId,
              targetWorkspaceId,
            },
            audience: [...new Set([...sourceAudience, ...targetAudience])],
          });
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.workspaceThreadsIndex(sourceWorkspaceId),
            content: await workspaceThreadsIndexContent(tx, sourceWorkspaceId),
            eventType: "thread.index.updated",
            ...workspaceThreadIndexChange(sourceWorkspaceId, "move-out"),
            audience: sourceAudience,
          });
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.workspaceThreadsIndex(targetWorkspaceId),
            content: await workspaceThreadsIndexContent(tx, targetWorkspaceId),
            eventType: "thread.index.updated",
            ...workspaceThreadIndexChange(targetWorkspaceId, "move-in"),
            audience: targetAudience,
          });
        }

        return {
          thread: this.withDisplayTitle(updatedThread),
          message: null,
          movedChatCount: movedChats.count || 0,
          movedChatIds: chatIds,
        };
      });
      if (result?.movedChatIds?.length) {
        const { WorkspaceCognition } = require("./workspaceCognition");
        await WorkspaceCognition.appendEvidenceEventsForSources({
          workspaceId: sourceWorkspaceId,
          chatIds: result.movedChatIds,
          eventType: "review_required",
          reason: "source_thread_moved_workspace",
        });
      }
      const { movedChatIds: _movedChatIds, ...publicResult } = result;
      return publicResult;
    } catch (error) {
      console.error(error.message);
      return { thread: null, message: error.message };
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    include = null
  ) {
    try {
      const results = await prisma.workspace_threads.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
        ...(include !== null ? { include } : {}),
      });
      return results.map((thread) => this.withDisplayTitle(thread));
    } catch (error) {
      throwModelDataAccessError("WorkspaceThread.where", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  markTitleGenerationPending: async function (threadId = null, scope = null) {
    if (!threadId || !scope) return false;
    try {
      const result = await prisma.workspace_threads.updateMany({
        where: {
          id: Number(threadId),
          OR: [{ titleSource: null }, { titleSource: { not: "manual" } }],
        },
        data: {
          titleGenerationStatus: "pending",
          titleMessageScope: String(scope),
          lastUpdatedAt: new Date(),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError(
        "workspaceThread.markTitleGenerationPending",
        error
      );
    }
  },

  markTitleGenerationFailed: async function (threadId = null, scope = null) {
    if (!threadId) return false;
    try {
      const result = await prisma.workspace_threads.updateMany({
        where: {
          id: Number(threadId),
          OR: [{ titleSource: null }, { titleSource: { not: "manual" } }],
          ...(scope ? { titleMessageScope: String(scope) } : {}),
        },
        data: {
          titleGenerationStatus: "failed",
          lastUpdatedAt: new Date(),
        },
      });
      return result.count > 0;
    } catch (error) {
      throwModelDataAccessError(
        "workspaceThread.markTitleGenerationFailed",
        error
      );
    }
  },

  updateAutomaticTitle: async function ({
    threadId = null,
    title = null,
    titleSource = "llm",
    titleHash = null,
    titleMessageScope = null,
    expectedTitleVersion = null,
  } = {}) {
    if (!threadId || !title || !titleMessageScope) return null;
    try {
      const where = {
        id: Number(threadId),
        OR: [{ titleSource: null }, { titleSource: { not: "manual" } }],
        ...(expectedTitleVersion !== null
          ? { titleVersion: Number(expectedTitleVersion) }
          : {}),
      };
      const data = {
        name: String(title),
        title: String(title),
        titleSource,
        titleHash,
        titleMessageScope,
        titleGenerationStatus: "idle",
        titleGeneratedAt: new Date(),
        titleVersion: { increment: 1 },
        lastUpdatedAt: new Date(),
      };
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      if (!syncReady) {
        const result = await prisma.workspace_threads.updateMany({
          where,
          data,
        });
        if (result.count === 0) return null;
        return await this.get({ id: Number(threadId) });
      }
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.workspace_threads.updateMany({ where, data });
        if (result.count === 0) return null;
        const thread = await tx.workspace_threads.findUnique({
          where: { id: Number(threadId) },
        });
        if (!thread) return null;
        const audience = await workspaceAudience(
          tx,
          thread.workspace_id,
          thread.user_id
        );
        await SyncV2.recordNodeChange(tx, {
          nodeKey: nodeKeys.threadMetadata(thread.id),
          content: threadSyncContent(thread),
          eventType: "thread.title.updated",
          changedPaths: ["name", "title", "titleVersion"],
          payloadHint: {
            workspaceId: thread.workspace_id,
            threadId: thread.id,
            threadSlug: thread.slug,
            title: thread.title,
          },
          audience,
        });
        await SyncV2.recordNodeChange(tx, {
          nodeKey: nodeKeys.workspaceThreadsIndex(thread.workspace_id),
          content: await workspaceThreadsIndexContent(
            tx,
            thread.workspace_id,
            thread.user_id
          ),
          eventType: "thread.index.updated",
          ...workspaceThreadIndexChange(thread.workspace_id, "title"),
          audience,
        });
        return thread;
      });
      return this.withDisplayTitle(updated);
    } catch (error) {
      throwModelDataAccessError("workspaceThread.updateAutomaticTitle", error);
    }
  },

  claimAutomaticTitle: async function ({
    workspaceId = null,
    threadId = null,
    userId = null,
    scope = null,
    titleHash = null,
  } = {}) {
    if (!workspaceId || !threadId || !scope || !titleHash) return null;
    try {
      const thread = await prisma.workspace_threads.findFirst({
        where: {
          id: Number(threadId),
          workspace_id: Number(workspaceId),
          ...(userId !== null && userId !== undefined
            ? { user_id: Number(userId) }
            : {}),
        },
      });
      if (!thread || thread.titleSource === "manual") return null;
      if (thread.titleHash === String(titleHash)) return null;
      if (
        scope === "latest_5_user_messages" &&
        thread.titleGeneratedAt &&
        Date.now() - new Date(thread.titleGeneratedAt).getTime() <
          14 * 24 * 60 * 60 * 1000
      )
        return null;
      const expectedTitleVersion = Number(thread.titleVersion || 0);
      const claimed = await prisma.workspace_threads.updateMany({
        where: {
          id: thread.id,
          titleVersion: expectedTitleVersion,
          OR: [{ titleSource: null }, { titleSource: { not: "manual" } }],
        },
        data: {
          titleGenerationStatus: "pending",
          titleMessageScope: String(scope),
          lastUpdatedAt: new Date(),
        },
      });
      if (claimed.count !== 1) return null;
      return { thread: this.withDisplayTitle(thread), expectedTitleVersion };
    } catch (error) {
      throwModelDataAccessError("workspaceThread.claimAutomaticTitle", error);
    }
  },
};

function threadLatestTime(thread = null) {
  const timestamp =
    thread?.lastChatAt || thread?.lastUpdatedAt || thread?.createdAt || 0;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

module.exports = {
  WorkspaceThread,
  _internals: { workspaceThreadIndexChange },
};
