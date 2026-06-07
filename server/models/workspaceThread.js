const prisma = require("../utils/prisma");
const slugifyModule = require("slugify");
const { v4: uuidv4 } = require("uuid");

const THREAD_TYPES = {
  chat: "chat",
  overview: "overview",
};
const THREAD_CREATED_FROM = {
  workspaceDefault: "workspace_default",
};

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
    "created_from",
    "forked_at_message_id",
    "forked_at",
  ],

  withDisplayTitle: function (thread = null) {
    if (!thread) return null;
    return {
      ...thread,
      name: thread.title || thread.name,
      displayTitle: thread.title || thread.name,
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
      }));
    } catch (error) {
      console.error(error.message);
      return threads.map((thread) => ({
        ...thread,
        lastChatAt: null,
        lastChatId: null,
      }));
    }
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
      const thread = await prisma.workspace_threads.create({
        data: {
          name: data.name ? String(data.name) : this.defaultName,
          slug: data.slug
            ? this.slugify(data.slug, { lowercase: true })
            : uuidv4(),
          user_id: userId ? Number(userId) : null,
          workspace_id: workspace.id,
          ...(data.parent_thread_id
            ? { parent_thread_id: Number(data.parent_thread_id) }
            : {}),
          ...(data.thread_type
            ? { thread_type: String(data.thread_type) }
            : {}),
          ...(data.created_from
            ? { created_from: String(data.created_from) }
            : {}),
          ...(data.forked_at_message_id
            ? { forked_at_message_id: Number(data.forked_at_message_id) }
            : {}),
          ...(data.forked_at ? { forked_at: data.forked_at } : {}),
        },
      });

      return { thread: this.withDisplayTitle(thread), message: null };
    } catch (error) {
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

  update: async function (prevThread = null, data = {}) {
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
      const thread = await prisma.workspace_threads.update({
        where: { id: prevThread.id },
        data: { ...validData, lastUpdatedAt: new Date() },
      });
      return { thread: this.withDisplayTitle(thread), message: null };
    } catch (error) {
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
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_threads.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
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
      console.error(error.message);
      return [];
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
      console.error(error.message);
      return false;
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
      console.error(error.message);
      return false;
    }
  },

  updateAutomaticTitle: async function ({
    threadId = null,
    title = null,
    titleSource = "llm",
    titleHash = null,
    titleMessageScope = null,
  } = {}) {
    if (!threadId || !title || !titleMessageScope) return null;
    try {
      const result = await prisma.workspace_threads.updateMany({
        where: {
          id: Number(threadId),
          OR: [{ titleSource: null }, { titleSource: { not: "manual" } }],
        },
        data: {
          name: String(title),
          title: String(title),
          titleSource,
          titleHash,
          titleMessageScope,
          titleGenerationStatus: "idle",
          titleGeneratedAt: new Date(),
          titleVersion: { increment: 1 },
          lastUpdatedAt: new Date(),
        },
      });
      if (result.count === 0) return null;
      return await this.get({ id: Number(threadId) });
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },
};

function threadLatestTime(thread = null) {
  const timestamp =
    thread?.lastChatAt || thread?.lastUpdatedAt || thread?.createdAt || 0;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

module.exports = { WorkspaceThread };
