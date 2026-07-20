const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const prisma = require("../utils/prisma");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");

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

async function recordMembershipChanges(
  tx,
  { workspaceIds = [], userIds = [], operation = "update" } = {}
) {
  for (const workspaceId of [...new Set(workspaceIds.map(Number))]) {
    const membership = await workspaceMembershipContent(tx, workspaceId);
    const audience = membership.map((entry) => Number(entry.user_id));
    for (const nodeKey of [
      nodeKeys.workspaceMembers(workspaceId),
      nodeKeys.workspacePermissions(workspaceId),
    ]) {
      await SyncV2.recordNodeChange(tx, {
        nodeKey,
        content: membership,
        eventType: "workspace.membership.updated",
        changedPaths: ["members"],
        payloadHint: { workspaceId, operation },
        audience,
      });
    }
  }
  for (const userId of [...new Set(userIds.map(Number))]) {
    await SyncV2.recordNodeChange(tx, {
      nodeKey: nodeKeys.userWorkspacesIndex(userId),
      content: await userWorkspaceIndexContent(tx, userId),
      eventType: "workspace.index.updated",
      changedPaths: ["workspaces"],
      payloadHint: { operation },
      audience: [userId],
    });
  }
}

const WorkspaceUser = {
  createMany: async function (userId, workspaceIds = []) {
    if (workspaceIds.length === 0) return;
    try {
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      if (!syncReady) {
        await prisma.$transaction(
          workspaceIds.map((workspaceId) =>
            prisma.workspace_users.create({
              data: { user_id: userId, workspace_id: workspaceId },
            })
          )
        );
      } else {
        await prisma.$transaction(async (tx) => {
          for (const workspaceId of workspaceIds) {
            await tx.workspace_users.create({
              data: {
                user_id: Number(userId),
                workspace_id: Number(workspaceId),
              },
            });
          }
          await recordMembershipChanges(tx, {
            workspaceIds,
            userIds: [userId],
            operation: "add",
          });
        });
      }
    } catch (error) {
      console.error(error.message);
    }
    return;
  },

  /**
   * Create many workspace users.
   * @param {Array<number>} userIds - An array of user IDs to create workspace users for.
   * @param {number} workspaceId - The ID of the workspace to create workspace users for.
   * @returns {Promise<void>} A promise that resolves when the workspace users are created.
   */
  createManyUsers: async function (userIds = [], workspaceId) {
    if (userIds.length === 0) return;
    try {
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      if (!syncReady) {
        await prisma.$transaction(
          userIds.map((userId) =>
            prisma.workspace_users.create({
              data: {
                user_id: Number(userId),
                workspace_id: Number(workspaceId),
              },
            })
          )
        );
      } else {
        await prisma.$transaction(async (tx) => {
          for (const userId of userIds) {
            await tx.workspace_users.create({
              data: {
                user_id: Number(userId),
                workspace_id: Number(workspaceId),
              },
            });
          }
          await recordMembershipChanges(tx, {
            workspaceIds: [workspaceId],
            userIds,
            operation: "add",
          });
        });
      }
    } catch (error) {
      console.error(error.message);
    }
    return;
  },

  create: async function (userId = 0, workspaceId = 0) {
    try {
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      if (!syncReady) {
        await prisma.workspace_users.create({
          data: { user_id: Number(userId), workspace_id: Number(workspaceId) },
        });
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.workspace_users.create({
            data: {
              user_id: Number(userId),
              workspace_id: Number(workspaceId),
            },
          });
          await recordMembershipChanges(tx, {
            workspaceIds: [workspaceId],
            userIds: [userId],
            operation: "add",
          });
        });
      }
      return true;
    } catch (error) {
      throwModelDataAccessError("workspaceUsers.create", error);
    }
  },

  get: async function (clause = {}) {
    try {
      const result = await prisma.workspace_users.findFirst({ where: clause });
      return result || null;
    } catch (error) {
      throwModelDataAccessError("workspaceUsers.get", error);
    }
  },

  where: async function (clause = {}, limit = null) {
    try {
      const results = await prisma.workspace_users.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return results;
    } catch (error) {
      throwModelDataAccessError("workspaceUsers.where", error);
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.workspace_users.count({ where: clause });
      return count;
    } catch (error) {
      throwModelDataAccessError("workspaceUsers.count", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      const syncReady =
        SyncV2.enabled("workspace") && (await SyncV2.schemaReady());
      if (!syncReady) {
        await prisma.workspace_users.deleteMany({ where: clause });
      } else {
        await prisma.$transaction(async (tx) => {
          const rows = await tx.workspace_users.findMany({
            where: clause,
            select: { user_id: true, workspace_id: true },
          });
          await tx.workspace_users.deleteMany({ where: clause });
          if (!rows.length) return;
          await recordMembershipChanges(tx, {
            workspaceIds: rows.map((row) => row.workspace_id),
            userIds: rows.map((row) => row.user_id),
            operation: "remove",
          });
        });
      }
    } catch (error) {
      console.error(error.message);
    }
    return;
  },
};

module.exports.WorkspaceUser = WorkspaceUser;
