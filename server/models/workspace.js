const prisma = require("../utils/prisma");
const slugifyModule = require("slugify");
const { Document } = require("./documents");
const { WorkspaceUser } = require("./workspaceUsers");
const { v4: uuidv4 } = require("uuid");
const { User } = require("./user");
const { PromptHistory } = require("./promptHistory");
const { SystemSettings } = require("./systemSettings");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");

function workspaceSyncContent(workspace = {}) {
  const {
    id,
    name,
    slug,
    pfpFilename,
    chatProvider,
    chatModel,
    chatMode,
    agentProvider,
    agentModel,
    openAiHistory,
    similarityThreshold,
    topN,
    vectorSearchMode,
  } = workspace;
  return {
    id,
    name,
    slug,
    pfpFilename,
    chatProvider,
    chatModel,
    chatMode,
    agentProvider,
    agentModel,
    openAiHistory,
    similarityThreshold,
    topN,
    vectorSearchMode,
  };
}

async function userWorkspaceIndexContent(tx, userId) {
  return await tx.workspaces.findMany({
    where: { workspace_users: { some: { user_id: Number(userId) } } },
    select: {
      id: true,
      name: true,
      slug: true,
      pfpFilename: true,
      chatModel: true,
    },
    orderBy: { id: "asc" },
  });
}

async function workspaceMembershipContent(tx, workspaceId) {
  return await tx.workspace_users.findMany({
    where: { workspace_id: Number(workspaceId) },
    select: {
      user_id: true,
      users: { select: { role: true, status: true, suspended: true } },
    },
    orderBy: { user_id: "asc" },
  });
}

function isNullOrNaN(value) {
  if (value === null) return true;
  return isNaN(value);
}

/**
 * @typedef {Object} Workspace
 * @property {number} id - The ID of the workspace
 * @property {string} name - The name of the workspace
 * @property {string} slug - The slug of the workspace
 * @property {string} openAiPrompt - The OpenAI prompt of the workspace
 * @property {string} openAiTemp - The OpenAI temperature of the workspace
 * @property {number} openAiHistory - The OpenAI history of the workspace
 * @property {number} similarityThreshold - The similarity threshold of the workspace
 * @property {string} chatProvider - The chat provider of the workspace
 * @property {string} chatModel - The chat model of the workspace
 * @property {number} topN - The top N of the workspace
 * @property {string} chatMode - The chat mode of the workspace
 * @property {string} agentProvider - The agent provider of the workspace
 * @property {string} agentModel - The agent model of the workspace
 * @property {string} queryRefusalResponse - The query refusal response of the workspace
 * @property {string} vectorSearchMode - The vector search mode of the workspace
 */

const Workspace = {
  VALID_CHAT_MODES: ["chat", "query", "automatic"],
  defaultPrompt: SystemSettings.saneDefaultSystemPrompt,

  // Used for generic updates so we can validate keys in request body
  // commented fields are not writable, but are available on the db object
  writable: [
    "name",
    // "slug",
    // "vectorTag",
    "openAiTemp",
    "openAiHistory",
    "lastUpdatedAt",
    "openAiPrompt",
    "similarityThreshold",
    "chatProvider",
    "chatModel",
    "topN",
    "chatMode",
    // "pfpFilename",
    "agentProvider",
    "agentModel",
    "queryRefusalResponse",
    "vectorSearchMode",
  ],

  validations: {
    name: (value) => {
      // If the name is not provided or is not a string then we will use a default name.
      // as the name field is not nullable in the db schema or has a default value.
      if (!value || typeof value !== "string") return "My Workspace";
      return String(value).slice(0, 255);
    },
    openAiTemp: (value) => {
      if (value === null || value === undefined) return null;
      const temp = parseFloat(value);
      if (isNullOrNaN(temp) || temp < 0) return null;
      return temp;
    },
    openAiHistory: (value) => {
      if (value === null || value === undefined) return 20;
      const history = parseInt(value);
      if (isNullOrNaN(history)) return 20;
      if (history < 0) return 0;
      return history;
    },
    similarityThreshold: (value) => {
      if (value === null || value === undefined) return 0.25;
      const threshold = parseFloat(value);
      if (isNullOrNaN(threshold)) return 0.25;
      if (threshold < 0) return 0.0;
      if (threshold > 1) return 1.0;
      return threshold;
    },
    topN: (value) => {
      if (value === null || value === undefined) return 4;
      const n = parseInt(value);
      if (isNullOrNaN(n)) return 4;
      if (n < 1) return 1;
      return n;
    },
    chatMode: (value) => {
      if (!value || !Workspace.VALID_CHAT_MODES.includes(value))
        return "automatic";
      return value;
    },
    chatProvider: (value) => {
      if (!value || typeof value !== "string" || value === "none") return null;
      return String(value);
    },
    chatModel: (value) => {
      if (!value || typeof value !== "string") return null;
      return String(value);
    },
    agentProvider: (value) => {
      if (!value || typeof value !== "string" || value === "none") return null;
      return String(value);
    },
    agentModel: (value) => {
      if (!value || typeof value !== "string") return null;
      return String(value);
    },
    queryRefusalResponse: (value) => {
      if (!value || typeof value !== "string") return null;
      return String(value);
    },
    openAiPrompt: (value) => {
      if (!value || typeof value !== "string") return null;
      return String(value);
    },
    vectorSearchMode: (value) => {
      if (
        !value ||
        typeof value !== "string" ||
        !["default", "rerank"].includes(value)
      )
        return "default";
      return value;
    },
  },

  /**
   * The default Slugify module requires some additional mapping to prevent downstream issues
   * with some vector db providers and instead of building a normalization method for every provider
   * we can capture this on the table level to not have to worry about it.
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

  /**
   * Validate the fields for a workspace update.
   * @param {Object} updates - The updates to validate - should be writable fields
   * @returns {Object} The validated updates. Only valid fields are returned.
   */
  validateFields: function (updates = {}) {
    const validatedFields = {};
    for (const [key, value] of Object.entries(updates)) {
      if (!this.writable.includes(key)) continue;
      if (this.validations[key]) {
        validatedFields[key] = this.validations[key](value);
      } else {
        // If there is no validation for the field then we will just pass it through.
        validatedFields[key] = value;
      }
    }
    return validatedFields;
  },

  /**
   * Create a new workspace.
   * @param {string} name - The name of the workspace.
   * @param {number} creatorId - The ID of the user creating the workspace.
   * @param {Object} additionalFields - Additional fields to apply to the workspace - will be validated.
   * @returns {Promise<{workspace: Object | null, message: string | null}>} A promise that resolves to an object containing the created workspace and an error message if applicable.
   */
  new: async function (name = null, creatorId = null, additionalFields = {}) {
    if (!name) return { workspace: null, message: "name cannot be null" };
    var slug = this.slugify(name, { lower: true });
    slug = slug || uuidv4();

    const existingBySlug = await this.get({ slug });
    if (existingBySlug !== null) {
      const slugSeed = Math.floor(10000000 + Math.random() * 90000000);
      slug = this.slugify(`${name}-${slugSeed}`, { lower: true });
    }

    // Get the default system prompt
    const defaultSystemPrompt = await SystemSettings.get({
      label: "default_system_prompt",
    });
    additionalFields.openAiPrompt = SystemSettings.effectiveDefaultSystemPrompt(
      defaultSystemPrompt?.value
    );

    try {
      const createData = {
        name: this.validations.name(name),
        chatMode: "automatic",
        ...(additionalFields.sourceActionId
          ? { sourceActionId: String(additionalFields.sourceActionId) }
          : {}),
        ...this.validateFields(additionalFields),
        slug,
      };
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      const workspace = syncReady
        ? await prisma.$transaction(async (tx) => {
            const created = await tx.workspaces.create({ data: createData });
            if (creatorId) {
              await tx.workspace_users.create({
                data: {
                  user_id: Number(creatorId),
                  workspace_id: created.id,
                },
              });
            }
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.workspaceMetadata(created.id),
              content: workspaceSyncContent(created),
              eventType: "workspace.created",
              changedPaths: ["$"],
              payloadHint: {
                workspaceId: created.id,
                workspaceSlug: created.slug,
              },
              mutationId: additionalFields.sourceActionId || null,
              audience: creatorId ? [Number(creatorId)] : [],
            });
            if (creatorId) {
              await SyncV2.recordNodeChange(tx, {
                nodeKey: nodeKeys.userWorkspacesIndex(creatorId),
                content: await userWorkspaceIndexContent(tx, creatorId),
                eventType: "workspace.index.updated",
                changedPaths: [`workspaces.${created.id}`],
                payloadHint: { workspaceId: created.id, operation: "add" },
                mutationId: additionalFields.sourceActionId || null,
              });
            }
            return created;
          })
        : await prisma.workspaces.create({ data: createData });

      if (!syncReady && creatorId)
        await WorkspaceUser.create(creatorId, workspace.id);
      return { workspace, message: null };
    } catch (error) {
      if (error?.code === "state_version_conflict") throw error;
      console.error(error.message);
      return { workspace: null, message: error.message };
    }
  },

  /**
   * Update the settings for a workspace. Applies validations to the updates provided.
   * @param {number} id - The ID of the workspace to update.
   * @param {Object} updates - The data to update.
   * @returns {Promise<{workspace: Object | null, message: string | null}>} A promise that resolves to an object containing the updated workspace and an error message if applicable.
   */
  update: async function (id = null, updates = {}, syncContext = {}) {
    if (!id) throw new Error("No workspace id provided for update");

    const validatedUpdates = this.validateFields(updates);
    if (Object.keys(validatedUpdates).length === 0)
      return { workspace: { id }, message: "No valid fields to update!" };

    // If the user unset the chatProvider we will need
    // to then clear the chatModel as well to prevent confusion during
    // LLM loading.
    if (validatedUpdates?.chatProvider === "default") {
      validatedUpdates.chatProvider = null;
      validatedUpdates.chatModel = null;
    }

    return this._update(id, validatedUpdates, syncContext);
  },

  /**
   * Direct update of workspace settings without any validation.
   * @param {number} id - The ID of the workspace to update.
   * @param {Object} data - The data to update.
   * @returns {Promise<{workspace: Object | null, message: string | null}>} A promise that resolves to an object containing the updated workspace and an error message if applicable.
   */
  _update: async function (id = null, data = {}, syncContext = {}) {
    if (!id) throw new Error("No workspace id provided for update");

    try {
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      const workspace = syncReady
        ? await prisma.$transaction(async (tx) => {
            const nodeKey = nodeKeys.workspaceMetadata(id);
            await SyncV2.assertMutationVersion(tx, {
              nodeKey,
              baseVersion: syncContext.baseVersion,
              changedPaths: syncContext.changedPaths || Object.keys(data),
            });
            const updated = await tx.workspaces.update({ where: { id }, data });
            const audience = (
              await tx.workspace_users.findMany({
                where: { workspace_id: Number(id) },
                select: { user_id: true },
              })
            ).map((row) => row.user_id);
            await SyncV2.recordNodeChange(tx, {
              nodeKey,
              content: workspaceSyncContent(updated),
              eventType: "workspace.updated",
              changedPaths: syncContext.changedPaths || Object.keys(data),
              payloadHint: {
                workspaceId: updated.id,
                workspaceSlug: updated.slug,
              },
              originClientId: syncContext.originClientId,
              mutationId: syncContext.mutationId,
              audience,
            });
            for (const userId of audience) {
              await SyncV2.recordNodeChange(tx, {
                nodeKey: nodeKeys.userWorkspacesIndex(userId),
                content: await userWorkspaceIndexContent(tx, userId),
                eventType: "workspace.index.updated",
                changedPaths: [`workspaces.${id}`],
                payloadHint: { workspaceId: id, operation: "update" },
                originClientId: syncContext.originClientId,
                mutationId: syncContext.mutationId,
              });
            }
            return updated;
          })
        : await prisma.workspaces.update({ where: { id }, data });
      return { workspace, message: null };
    } catch (error) {
      if (error?.code === "state_version_conflict") throw error;
      console.error(error.message);
      return { workspace: null, message: error.message };
    }
  },

  getWithUser: async function (user = null, clause = {}) {
    try {
      const workspace = await prisma.workspaces.findFirst({
        where: {
          ...clause,
          workspace_users: {
            some: {
              user_id: user?.id,
            },
          },
        },
        include: {
          workspace_users: true,
          documents: true,
        },
      });

      if (!workspace) return null;

      return {
        ...workspace,
        documents: await Document.forWorkspace(workspace.id),
        contextWindow: this._getContextWindow(workspace),
        currentContextTokenCount: await this._getCurrentContextTokenCount(
          workspace.id
        ),
      };
    } catch (error) {
      throwModelDataAccessError("Workspace.getWithUser", error, {
        userId: user?.id || null,
      });
    }
  },

  /**
   * Get the total token count of all parsed files in a workspace/thread
   * @param {number} workspaceId - The ID of the workspace
   * @param {number|null} threadId - Optional thread ID to filter by
   * @returns {Promise<number>} Total token count of all files
   * @private
   */
  async _getCurrentContextTokenCount(workspaceId, threadId = null) {
    const { WorkspaceParsedFiles } = require("./workspaceParsedFiles");
    return await WorkspaceParsedFiles.totalTokenCount({
      workspaceId: Number(workspaceId),
      threadId: threadId ? Number(threadId) : null,
    });
  },

  /**
   * Get the context window size for a workspace based on its provider and model settings.
   * If the workspace has no provider/model set, falls back to system defaults.
   * @param {Workspace} workspace - The workspace to get context window for
   * @returns {number|null} The context window size in tokens (defaults to null if no provider/model found)
   * @private
   */
  _getContextWindow: function (workspace) {
    const {
      getLLMProviderClass,
      getBaseLLMProviderModel,
    } = require("../utils/helpers");
    const provider = workspace.chatProvider || process.env.LLM_PROVIDER || null;
    const LLMProvider = getLLMProviderClass({ provider });
    const model =
      workspace.chatModel || getBaseLLMProviderModel({ provider }) || null;

    if (!provider || !model) return null;
    return LLMProvider?.promptWindowLimit?.(model) || null;
  },

  get: async function (clause = {}) {
    try {
      const workspace = await prisma.workspaces.findFirst({
        where: clause,
        include: {
          documents: true,
        },
      });

      if (!workspace) return null;
      return {
        ...workspace,
        contextWindow: this._getContextWindow(workspace),
        currentContextTokenCount: await this._getCurrentContextTokenCount(
          workspace.id
        ),
      };
    } catch (error) {
      throwModelDataAccessError("workspace.get", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      const workspace = await prisma.workspaces.findFirst({
        where: clause,
        select: { id: true, slug: true },
      });
      if (!workspace) return false;
      const parsedFileSources = await prisma.workspace_parsed_files.findMany({
        where: { workspaceId: workspace.id },
        select: { metadata: true },
      });
      const { WorkspaceCognition } = require("./workspaceCognition");
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      await prisma.$transaction(async (tx) => {
        const audience = (
          await tx.workspace_users.findMany({
            where: { workspace_id: workspace.id },
            select: { user_id: true },
          })
        ).map((row) => row.user_id);
        const threads = await tx.workspace_threads.findMany({
          where: { workspace_id: workspace.id },
          select: { id: true },
        });
        await WorkspaceCognition.deleteWorkspaceData([workspace.id], tx);
        await tx.workspaces.delete({ where: clause });
        if (syncReady) {
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.workspaceMetadata(workspace.id),
            content: { deleted: true },
            deletedAt: new Date(),
            eventType: "workspace.deleted",
            changedPaths: ["$delete"],
            payloadHint: {
              workspaceId: workspace.id,
              workspaceSlug: workspace.slug,
              purgePrefix: `workspaces/${workspace.id}`,
            },
            audience,
          });
          for (const thread of threads) {
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.threadMetadata(thread.id),
              content: { deleted: true },
              deletedAt: new Date(),
              eventType: "thread.deleted",
              changedPaths: ["$delete"],
              payloadHint: { workspaceId: workspace.id, threadId: thread.id },
              audience,
            });
          }
          for (const userId of audience) {
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.userWorkspacesIndex(userId),
              content: await userWorkspaceIndexContent(tx, userId),
              eventType: "workspace.index.updated",
              changedPaths: [`workspaces.${workspace.id}`],
              payloadHint: { workspaceId: workspace.id, operation: "delete" },
              audience: [userId],
            });
          }
        }
      });
      require("../utils/documentSources").cleanupDocxSources(parsedFileSources);
      return true;
    } catch (error) {
      throwModelDataAccessError("workspace.delete", error);
    }
  },

  count: async function (clause = {}) {
    try {
      return await prisma.workspaces.count({ where: clause });
    } catch (error) {
      throwModelDataAccessError("Workspace.count", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const results = await prisma.workspaces.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return results;
    } catch (error) {
      throwModelDataAccessError("Workspace.where", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  whereWithUser: async function (
    user,
    clause = {},
    limit = null,
    orderBy = null
  ) {
    try {
      const workspaces = await prisma.workspaces.findMany({
        where: {
          ...clause,
          workspace_users: {
            some: {
              user_id: user.id,
            },
          },
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return workspaces;
    } catch (error) {
      throwModelDataAccessError("Workspace.whereWithUser", error, {
        userId: user?.id || null,
      });
    }
  },

  whereWithUsers: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const workspaces = await this.where(clause, limit, orderBy, offset);
      for (const workspace of workspaces) {
        const userIds = (
          await WorkspaceUser.where({ workspace_id: Number(workspace.id) })
        ).map((rel) => rel.user_id);
        workspace.userIds = userIds;
      }
      return workspaces;
    } catch (error) {
      throwModelDataAccessError("Workspace.whereWithUsers", error, {
        hasClause: Object.keys(clause || {}).length > 0,
      });
    }
  },

  /**
   * Get all users for a workspace.
   * @param {number} workspaceId - The ID of the workspace to get users for.
   * @returns {Promise<Array<{userId: number, username: string, role: string}>>} A promise that resolves to an array of user objects.
   */
  workspaceUsers: async function (workspaceId) {
    try {
      const users = (
        await WorkspaceUser.where({ workspace_id: Number(workspaceId) })
      ).map((rel) => rel);

      const usersById = await User.where({
        id: { in: users.map((user) => user.user_id) },
      });

      const userInfo = usersById.map((user) => {
        const workspaceUser = users.find((u) => u.user_id === user.id);
        return {
          userId: user.id,
          username: user.username,
          role: user.role,
          lastUpdatedAt: workspaceUser.lastUpdatedAt,
        };
      });

      return userInfo;
    } catch (error) {
      throwModelDataAccessError("Workspace.workspaceUsers", error, {
        workspaceId: Number(workspaceId) || null,
      });
    }
  },

  /**
   * Update the users for a workspace. Will remove all existing users and replace them with the new list.
   * @param {number} workspaceId - The ID of the workspace to update.
   * @param {number[]} userIds - An array of user IDs to add to the workspace.
   * @returns {Promise<{success: boolean, error: string | null}>} A promise that resolves to an object containing the success status and an error message if applicable.
   */
  updateUsers: async function (workspaceId, userIds = []) {
    try {
      const normalizedWorkspaceId = Number(workspaceId);
      const nextUserIds = [
        ...new Set(
          userIds
            .map(Number)
            .filter((userId) => Number.isInteger(userId) && userId > 0)
        ),
      ];
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      await prisma.$transaction(async (tx) => {
        const previousUserIds = (
          await tx.workspace_users.findMany({
            where: { workspace_id: normalizedWorkspaceId },
            select: { user_id: true },
          })
        ).map((row) => Number(row.user_id));
        await tx.workspace_users.deleteMany({
          where: { workspace_id: normalizedWorkspaceId },
        });
        if (nextUserIds.length) {
          await tx.workspace_users.createMany({
            data: nextUserIds.map((userId) => ({
              user_id: userId,
              workspace_id: normalizedWorkspaceId,
            })),
          });
        }
        if (!syncReady) return;
        const membership = await workspaceMembershipContent(
          tx,
          normalizedWorkspaceId
        );
        for (const nodeKey of [
          nodeKeys.workspaceMembers(normalizedWorkspaceId),
          nodeKeys.workspacePermissions(normalizedWorkspaceId),
        ]) {
          await SyncV2.recordNodeChange(tx, {
            nodeKey,
            content: membership,
            eventType: "workspace.membership.updated",
            changedPaths: ["members"],
            payloadHint: { workspaceId: normalizedWorkspaceId },
            audience: nextUserIds,
          });
        }
        const affectedUserIds = [
          ...new Set([...previousUserIds, ...nextUserIds]),
        ];
        for (const userId of affectedUserIds) {
          await SyncV2.recordNodeChange(tx, {
            nodeKey: nodeKeys.userWorkspacesIndex(userId),
            content: await userWorkspaceIndexContent(tx, userId),
            eventType: "workspace.index.updated",
            changedPaths: [`workspaces.${normalizedWorkspaceId}`],
            payloadHint: {
              workspaceId: normalizedWorkspaceId,
              operation: nextUserIds.includes(userId) ? "upsert" : "remove",
            },
            audience: [userId],
          });
        }
      });
      return { success: true, error: null };
    } catch (error) {
      console.error(error.message);
      return { success: false, error: error.message };
    }
  },

  trackChange: async function (prevData, newData, user) {
    try {
      await this._trackWorkspacePromptChange(prevData, newData, user);
      return;
    } catch (error) {
      console.error("Error tracking workspace change:", error.message);
      return;
    }
  },

  /**
   * We are tracking this change to determine the need to a prompt library or
   * prompt assistant feature. If this is something you would like to see - tell us on GitHub!
   * We now track the prompt change in the PromptHistory model.
   * which is a sub-model of the Workspace model.
   * @param {Workspace} prevData - The previous data of the workspace.
   * @param {Workspace} newData - The new data of the workspace.
   * @param {{id: number, role: string}|null} user - The user who made the change.
   * @returns {Promise<void>}
   */
  _trackWorkspacePromptChange: async function (prevData, newData, user = null) {
    if (
      !!newData?.openAiPrompt && // new prompt is set
      !!prevData?.openAiPrompt && // previous prompt was not null (default)
      prevData?.openAiPrompt !== this.defaultPrompt && // previous prompt was not default
      newData?.openAiPrompt !== prevData?.openAiPrompt // previous and new prompt are not the same
    )
      await PromptHistory.handlePromptChange(prevData, user); // log the change to the prompt history

    const { Telemetry } = require("./telemetry");
    const { EventLogs } = require("./eventLogs");
    if (
      !newData?.openAiPrompt || // no prompt change
      newData?.openAiPrompt === this.defaultPrompt || // new prompt is default prompt
      newData?.openAiPrompt === prevData?.openAiPrompt // same prompt
    )
      return;

    await Telemetry.sendTelemetry("workspace_prompt_changed");
    await EventLogs.logEvent(
      "workspace_prompt_changed",
      {
        workspaceName: prevData?.name,
        prevSystemPrompt: prevData?.openAiPrompt || this.defaultPrompt,
        newSystemPrompt: newData?.openAiPrompt,
      },
      user?.id
    );
    return;
  },

  // Direct DB queries for API use only.
  /**
   * Generic prisma FindMany query for workspaces collections
   * @param {import("../node_modules/.prisma/client/index.d.ts").Prisma.TypeMap['model']['workspaces']['operations']['findMany']['args']} prismaQuery
   * @returns
   */
  _findMany: async function (prismaQuery = {}) {
    try {
      const results = await prisma.workspaces.findMany(prismaQuery);
      return results;
    } catch (error) {
      throwModelDataAccessError("workspace._findMany", error);
    }
  },

  /**
   * Generic prisma query for .get of workspaces collections
   * @param {import("../node_modules/.prisma/client/index.d.ts").Prisma.TypeMap['model']['workspaces']['operations']['findFirst']['args']} prismaQuery
   * @returns
   */
  _findFirst: async function (prismaQuery = {}) {
    try {
      const results = await prisma.workspaces.findFirst(prismaQuery);
      return results;
    } catch (error) {
      throwModelDataAccessError("workspace._findFirst", error);
    }
  },

  /**
   * Upsert a workspace.
   * If the workspace does not exist, it will be created.
   * If the workspace exists, it will be updated (if data is provided).
   * @param {Object} clause - The clause to upsert the workspace by.
   * @param {Object} createData - The data to create the workspace with.
   * @param {Object} updateData - The data to update the workspace with if it already exists.
   * @returns {Promise<{workspace: import("@prisma/client").workspaces | null, error: string | null}>} A promise that resolves to an object containing the upserted workspace and an error message if applicable.
   */
  upsert: async function (clause = {}, createData = {}, updateData = {}) {
    try {
      if (Object.keys(updateData).length === 0) {
        const existing = await prisma.workspaces.findUnique({ where: clause });
        if (existing) return { workspace: existing, error: null };
      }
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      const workspace = syncReady
        ? await prisma.$transaction(async (tx) => {
            const saved = await tx.workspaces.upsert({
              where: clause,
              update: updateData,
              create: createData,
            });
            const audience = (
              await tx.workspace_users.findMany({
                where: { workspace_id: saved.id },
                select: { user_id: true },
              })
            ).map((row) => Number(row.user_id));
            await SyncV2.recordNodeChange(tx, {
              nodeKey: nodeKeys.workspaceMetadata(saved.id),
              content: workspaceSyncContent(saved),
              eventType: "workspace.upserted",
              changedPaths: Object.keys(updateData).length
                ? Object.keys(updateData)
                : ["$create"],
              payloadHint: { workspaceId: saved.id, workspaceSlug: saved.slug },
              audience,
            });
            return saved;
          })
        : await prisma.workspaces.upsert({
            where: clause,
            update: updateData,
            create: createData,
          });
      return { workspace, error: null };
    } catch (error) {
      console.error(error.message);
      return { workspace: null, error: error.message };
    }
  },

  /**
   * Get the prompt history for a workspace.
   * @param {Object} options - The options to get prompt history for.
   * @param {number} options.workspaceId - The ID of the workspace to get prompt history for.
   * @returns {Promise<Array<{id: number, prompt: string, modifiedAt: Date, modifiedBy: number, user: {id: number, username: string, role: string}}>>} A promise that resolves to an array of prompt history objects.
   */
  promptHistory: async function ({ workspaceId }) {
    try {
      const results = await PromptHistory.forWorkspace(workspaceId);
      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * Delete the prompt history for a workspace.
   * @param {Object} options - The options to delete the prompt history for.
   * @param {number} options.workspaceId - The ID of the workspace to delete prompt history for.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  deleteAllPromptHistory: async function ({ workspaceId }) {
    try {
      return await PromptHistory.delete({ workspaceId });
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  /**
   * Delete the prompt history for a workspace.
   * @param {Object} options - The options to delete the prompt history for.
   * @param {number} options.workspaceId - The ID of the workspace to delete prompt history for.
   * @param {number} options.id - The ID of the prompt history to delete.
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating the success of the operation.
   */
  deletePromptHistory: async function ({ workspaceId, id }) {
    try {
      return await PromptHistory.delete({ id, workspaceId });
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  /**
   * Checks if the workspace's chat provider/model waterfall supports native tool calling.
   * @param {Workspace} workspace - The workspace object to check
   * @returns {Promise<boolean>}
   */
  supportsNativeToolCalling: async function (workspace = {}) {
    if (!workspace) return false;
    const { getBaseLLMProviderModel } = require("../utils/helpers");
    const AIbitat = require("../utils/agents/aibitat");
    const provider =
      workspace?.agentProvider ??
      workspace?.chatProvider ??
      process.env.LLM_PROVIDER;
    const model =
      workspace?.agentModel ??
      workspace?.chatModel ??
      getBaseLLMProviderModel({ provider });
    const agentConfig = { provider, model };
    const agentProvider = new AIbitat(agentConfig).getProviderForConfig(
      agentConfig
    );
    const nativeToolCalling = await agentProvider.supportsNativeToolCalling?.();
    return nativeToolCalling;
  },

  /**
   * Checks if the agent command is available for a workspace
   * by checking if the workspace's agent provider supports native tool calling.
   * - If the workspaces chat provider/model supports native tool calling, then the agent command is NOT available
   * as it will be assumed the model is capable of handling tool calls.
   * Otherwise, the agent command is available and the user must opt-in to "@agent" to use tool calls.
   * @param {Workspace} workspace - The workspace object to check
   * @returns {Promise<boolean>}
   */
  isAgentCommandAvailable: async function (workspace) {
    if (workspace.chatMode !== "automatic") return true;
    const nativeToolCalling = await this.supportsNativeToolCalling(workspace);
    return nativeToolCalling === false;
  },
};

module.exports = { Workspace };
