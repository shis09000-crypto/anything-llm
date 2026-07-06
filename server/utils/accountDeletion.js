const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { lazyDataAccessFacade } = require("./dataAccess/lazyFacade");
const AccountDeletionData = lazyDataAccessFacade("accountDeletion");
const accountDeletionDb = AccountDeletionData.db;
const authPrisma = require("./authPrisma");
const {
  appEnvironment,
  storageBaseDir,
  storagePath,
} = require("./environment");
const { getVectorDbClass } = require("./helpers");
const { normalizePath, isWithin } = require("./files");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const Workspace = AccountDeletionData.workspace;
const WorkspaceChats = AccountDeletionData.workspaceChats;
const {
  DocumentRepository: Document,
} = require("../repositories/documentRepository");
const {
  DocumentVectorRepository: DocumentVectors,
} = require("../repositories/documentVectorRepository");
const AuthIdentity = AccountDeletionData.authIdentity;
const {
  assertDeleteAllowed,
  assertOwnerWillRemainAfterMutation,
  normalizeEnv,
} = require("./authz/accountRoles");
const {
  validateReauthToken,
  consumeReauthToken,
} = require("./authz/reauthTokens");

function sqliteUrl(dbPath) {
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

const AccountDeletionService = {
  async preview({
    actor,
    target = null,
    env = appEnvironment(),
    mode = "self",
  }) {
    const targetUser = target || actor;
    const actorAuth = await authUserFor(actor);
    const targetAuth = await authUserFor(targetUser);
    if (!actorAuth || !targetAuth) throw new Error("账号不存在。");

    assertDeleteAllowed(actorAuth, targetAuth);
    await assertOwnerWillRemainAfterMutation({
      authPrisma,
      targetAuthUserId: targetAuth.id,
      env,
      deleting: true,
    });

    const workspaces = await workspacePreview(targetUser.id);
    const totals = workspaces.reduce(
      (sum, workspace) => {
        sum.workspaceCount += 1;
        sum.threadCount += workspace.threadCount;
        sum.chatCount += workspace.chatCount;
        sum.documentCount += workspace.documentCount;
        sum.vectorNamespaceCount += workspace.vectorNamespaceCount;
        sum.memoryCount += workspace.memoryCount;
        return sum;
      },
      {
        workspaceCount: 0,
        threadCount: 0,
        chatCount: 0,
        documentCount: 0,
        vectorNamespaceCount: 0,
        memoryCount: 0,
      }
    );

    const hasOtherEnv = await hasOtherEnvironmentShadowUser(targetAuth.id, env);
    const blockedReason = null;
    const preview = {
      username: targetUser.username,
      emailMasked: maskEmail(targetUser.email),
      role: targetAuth.role,
      ownerType: targetAuth.ownerType,
      currentEnv: normalizeEnv(env),
      willDeleteSharedAuthUser: !hasOtherEnv,
      blockedReason,
      workspaces,
      totals,
      warnings: hasOtherEnv
        ? ["该账号仍存在其它环境数据，本次仅删除当前环境数据。"]
        : ["该账号没有其它环境数据，将同步删除共享认证账号。"],
    };

    await audit("account_delete_previewed", actor, {
      authUserIdHash: fingerprint(targetAuth.id),
      env: normalizeEnv(env),
      workspaceCount: totals.workspaceCount,
      mode,
    });
    return preview;
  },

  async execute({
    actor,
    target = null,
    env = appEnvironment(),
    reauthToken,
    confirm = false,
    mode = "self",
  }) {
    const deletionJobId = crypto.randomUUID();
    const targetUser = target || actor;
    const reauth = validateReauthToken(reauthToken, actor.id);
    if (!confirm) throw new Error("请确认删除账户。");
    if (!reauth) throw new Error("请先完成安全验证。");

    await audit("account_delete_requested", actor, {
      authUserIdHash: fingerprint(targetUser.authUserId || targetUser.id),
      env: normalizeEnv(env),
      deletionJobId,
      mode,
    });

    try {
      const preview = await this.preview({
        actor,
        target: targetUser,
        env,
        mode,
      });
      const targetAuth = await authUserFor(targetUser);
      const hasOtherEnv = !preview.willDeleteSharedAuthUser;

      for (const workspace of preview.workspaces) {
        if (workspace.deleteMode === "delete_workspace")
          await deleteWorkspaceCompletely(workspace);
        else await removeUserFromWorkspace(workspace, targetUser.id);
      }

      await cleanupUserScopedData(targetUser);
      await deleteProfilePicture(targetUser.pfpFilename);
      await accountDeletionDb.users.deleteMany({
        where: { id: Number(targetUser.id) },
      });

      if (hasOtherEnv) {
        await authPrisma.authEnvironmentDeletion.upsert({
          where: {
            authUserId_env: {
              authUserId: targetAuth.id,
              env: normalizeEnv(env),
            },
          },
          create: {
            authUserId: targetAuth.id,
            env: normalizeEnv(env),
            deletedByAuthUserId: actor.authUserId || null,
          },
          update: {
            deletedAt: new Date(),
            deletedByAuthUserId: actor.authUserId || null,
          },
        });
      } else {
        await cleanupSharedAuthUser(targetAuth.id);
      }

      consumeReauthToken(reauthToken);
      await audit("account_deleted", actor, {
        authUserIdHash: fingerprint(targetAuth.id),
        env: normalizeEnv(env),
        deletionJobId,
        workspaceCount: preview.totals.workspaceCount,
        deletedAt: new Date().toISOString(),
      });
      return { success: true, deletionJobId, preview };
    } catch (error) {
      await audit("account_delete_failed", actor, {
        authUserIdHash: fingerprint(targetUser.authUserId || targetUser.id),
        env: normalizeEnv(env),
        deletionJobId,
        reason: safeReason(error.message),
      });
      return {
        success: false,
        deletionJobId,
        error: error.message || "删除账户失败。",
      };
    }
  },
};

async function authUserFor(user) {
  if (!user) return null;
  if (user.authUserId) return AuthIdentity.findById(user.authUserId);
  const shadow = await AuthIdentity.bootstrapAuthUserFromShadow(user);
  return shadow;
}

async function workspacePreview(userId) {
  const memberships = await accountDeletionDb.workspace_users.findMany({
    where: { user_id: Number(userId) },
    include: { workspaces: true },
    orderBy: { createdAt: "asc" },
  });
  const result = [];
  for (const membership of memberships) {
    const workspace = membership.workspaces;
    if (!workspace) continue;
    const memberCount = await accountDeletionDb.workspace_users.count({
      where: { workspace_id: workspace.id },
    });
    const deleteWorkspace = memberCount <= 1;
    const threadWhere = deleteWorkspace
      ? { workspace_id: workspace.id }
      : { workspace_id: workspace.id, user_id: Number(userId) };
    const chatWhere = deleteWorkspace
      ? { workspaceId: workspace.id }
      : { workspaceId: workspace.id, user_id: Number(userId) };
    const memoryWhere = deleteWorkspace
      ? { workspaceId: workspace.id }
      : { workspaceId: workspace.id, user_id: Number(userId) };
    const [threadCount, chatCount, documentCount, mindMapCount] =
      await Promise.all([
        accountDeletionDb.workspace_threads.count({ where: threadWhere }),
        accountDeletionDb.workspace_chats.count({ where: chatWhere }),
        deleteWorkspace
          ? accountDeletionDb.workspace_documents.count({
              where: { workspaceId: workspace.id },
            })
          : Promise.resolve(0),
        accountDeletionDb.workspace_mind_maps
          .count({ where: memoryWhere })
          .catch(() => 0),
      ]);
    result.push({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      deleteMode: deleteWorkspace ? "delete_workspace" : "remove_membership",
      threadCount,
      chatCount,
      documentCount,
      vectorNamespaceCount: deleteWorkspace ? 1 : 0,
      memoryCount: mindMapCount,
    });
  }
  return result;
}

async function deleteWorkspaceCompletely(workspace) {
  const VectorDb = getVectorDbClass();
  await WorkspaceChats.delete({ workspaceId: Number(workspace.id) });
  await DocumentVectors.deleteForWorkspace(Number(workspace.id));
  await Document.delete({ workspaceId: Number(workspace.id) });
  await cleanupWorkspaceAuxiliaryData(Number(workspace.id));
  try {
    await VectorDb["delete-namespace"]({ namespace: workspace.slug });
  } catch (error) {
    const message = String(error?.message || "");
    if (!/does not exist|not exist|no documents found/i.test(message)) {
      throw new Error(
        `向量数据清理失败，请稍后重试。${message ? ` ${message}` : ""}`
      );
    }
  }
  await Workspace.delete({ id: Number(workspace.id) });
}

async function removeUserFromWorkspace(workspace, userId) {
  await accountDeletionDb.workspace_chats.deleteMany({
    where: { workspaceId: workspace.id, user_id: Number(userId) },
  });
  await accountDeletionDb.workspace_threads.deleteMany({
    where: { workspace_id: workspace.id, user_id: Number(userId) },
  });
  await cleanupUserWorkspaceAuxiliaryData(Number(workspace.id), Number(userId));
  await accountDeletionDb.workspace_users.deleteMany({
    where: { workspace_id: workspace.id, user_id: Number(userId) },
  });
}

async function cleanupWorkspaceAuxiliaryData(workspaceId) {
  await Promise.allSettled([
    accountDeletionDb.workspace_chat_compactions.deleteMany({
      where: { workspace_id: workspaceId },
    }),
    accountDeletionDb.workspace_mind_maps.deleteMany({
      where: { workspaceId },
    }),
    accountDeletionDb.workspace_agent_invocations.deleteMany({
      where: { workspace_id: workspaceId },
    }),
    accountDeletionDb.workspace_parsed_files.deleteMany({
      where: { workspaceId },
    }),
    accountDeletionDb.workspace_quiz_attempts.deleteMany({
      where: { workspaceId },
    }),
    accountDeletionDb.workspace_quiz_wrong_questions.deleteMany({
      where: { workspaceId },
    }),
    accountDeletionDb.workspace_quiz_favorite_questions.deleteMany({
      where: { workspaceId },
    }),
    accountDeletionDb.prompt_history.deleteMany({ where: { workspaceId } }),
    accountDeletionDb.documentIndexStatus.deleteMany({
      where: { workspaceId },
    }),
  ]);
}

async function cleanupUserWorkspaceAuxiliaryData(workspaceId, userId) {
  await Promise.allSettled([
    accountDeletionDb.workspace_chat_compactions.deleteMany({
      where: { workspace_id: workspaceId, user_id: userId },
    }),
    accountDeletionDb.workspace_mind_maps.deleteMany({
      where: { workspaceId, user_id: userId },
    }),
    accountDeletionDb.workspace_agent_invocations.deleteMany({
      where: { workspace_id: workspaceId, user_id: userId },
    }),
    accountDeletionDb.workspace_parsed_files
      .deleteMany({ where: { workspaceId, userId } })
      .catch(() => null),
    accountDeletionDb.workspace_quiz_attempts.deleteMany({
      where: { workspaceId, userId },
    }),
    accountDeletionDb.workspace_quiz_wrong_questions.deleteMany({
      where: { workspaceId, userId },
    }),
    accountDeletionDb.workspace_quiz_favorite_questions.deleteMany({
      where: { workspaceId, userId },
    }),
    accountDeletionDb.prompt_history.deleteMany({
      where: { workspaceId, modifiedBy: userId },
    }),
  ]);
}

async function cleanupUserScopedData(user) {
  const userId = Number(user.id);
  await Promise.allSettled([
    accountDeletionDb.browser_extension_api_keys.deleteMany({
      where: { user_id: userId },
    }),
    accountDeletionDb.temporary_auth_tokens.deleteMany({ where: { userId } }),
    accountDeletionDb.system_prompt_variables.deleteMany({ where: { userId } }),
    accountDeletionDb.desktop_mobile_devices.deleteMany({ where: { userId } }),
  ]);
}

async function cleanupSharedAuthUser(authUserId) {
  const userId = Number(authUserId);
  await authPrisma.recovery_codes.deleteMany({ where: { user_id: userId } });
  await authPrisma.password_reset_tokens.deleteMany({
    where: { user_id: userId },
  });
  await authPrisma.email_verification_codes.deleteMany({
    where: { user_id: userId },
  });
  await authPrisma.passkeyCredential.deleteMany({ where: { userId } });
  await authPrisma.passkeyChallenge.deleteMany({ where: { userId } });
  await authPrisma.trustedLoginDevice.deleteMany({ where: { userId } });
  await authPrisma.zkLoginAttempt.deleteMany({ where: { userId } });
  await authPrisma.invites
    .updateMany({
      where: { usedByUserId: userId },
      data: { usedByUserId: null },
    })
    .catch(() => null);
  await authPrisma.users.deleteMany({ where: { id: userId } });
}

async function hasOtherEnvironmentShadowUser(authUserId, env) {
  const currentEnv = normalizeEnv(env);
  const otherEnvs = ["production", "development"].filter(
    (candidate) => candidate !== currentEnv
  );
  for (const otherEnv of otherEnvs) {
    const dbPath = path.join(storageBaseDir(), otherEnv, "anythingllm.db");
    if (!fs.existsSync(dbPath)) continue;
    const db = new PrismaClient({
      datasources: { db: { url: sqliteUrl(dbPath) } },
    });
    try {
      const count = await db.users.count({
        where: { authUserId: Number(authUserId) },
      });
      if (count > 0) return true;
    } finally {
      await db.$disconnect();
    }
  }
  return false;
}

async function deleteProfilePicture(pfpFilename) {
  if (!pfpFilename) return;
  const basePath = storagePath("assets", "pfp");
  const pfpPath = path.join(basePath, normalizePath(pfpFilename));
  if (!isWithin(path.resolve(basePath), path.resolve(pfpPath))) return;
  await fs.promises.unlink(pfpPath).catch(() => null);
}

async function audit(event, actor, metadata = {}) {
  await EventLogs.logEvent(event, metadata, actor?.id || null);
}

function maskEmail(email) {
  if (!email || !String(email).includes("@")) return null;
  const [name, domain] = String(email).split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function fingerprint(value) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 16);
}

function safeReason(message = "") {
  return String(message || "unknown")
    .replace(/[<>]/g, "")
    .slice(0, 160);
}

module.exports = { AccountDeletionService };
