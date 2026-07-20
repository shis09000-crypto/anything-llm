const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { lazyDataAccessFacade } = require("./dataAccess/lazyFacade");
const AccountDeletionData = lazyDataAccessFacade("accountDeletion");
const accountDeletionDb = AccountDeletionData.db;
const Document = lazyDataAccessFacade("document");
const DocumentVectors = lazyDataAccessFacade("documentVector");
const authPrisma = require("./authPrisma");
const {
  appEnvironment,
  storageBaseDir,
  storagePath,
} = require("./environment");
const { getVectorDbClass } = require("./helpers");
const { normalizePath, isWithin } = require("./files");
const { cleanupDocxSources } = require("./documentSources");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const Workspace = AccountDeletionData.workspace;
const WorkspaceChats = AccountDeletionData.workspaceChats;
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
    deletionRunId = null,
  }) {
    const targetUser = target || actor;
    const reauth = validateReauthToken(reauthToken, actor.id);
    if (!confirm) throw new Error("请确认删除账户。");
    if (!reauth) throw new Error("请先完成安全验证。");

    let run = null;
    try {
      run = await getOrCreateDeletionRun({
        runId: deletionRunId,
        actor,
        targetUser,
        env,
        mode,
        previewFactory: () =>
          this.preview({ actor, target: targetUser, env, mode }),
      });
      const context = parseRunContext(run);
      const preview = context.preview;
      const targetSnapshot = context.target;
      const targetAuth = context.targetAuth;
      if (!preview || !targetSnapshot || !targetAuth)
        throw new Error("删除工作流上下文不完整，无法安全继续。");

      await audit("account_delete_requested", actor, {
        authUserIdHash: fingerprint(targetAuth.id),
        env: normalizeEnv(env),
        deletionJobId: run.runId,
        mode,
        attempt: run.attempts,
      });

      const hasOtherEnv = !preview.willDeleteSharedAuthUser;

      for (const workspace of preview.workspaces) {
        await runDeletionStep(run, `workspace:${workspace.id}`, async () => {
          if (workspace.deleteMode === "delete_workspace")
            await deleteWorkspaceCompletely(workspace);
          else await removeUserFromWorkspace(workspace, targetSnapshot.id);
        });
      }

      await runDeletionStep(run, "user_scoped_data", () =>
        cleanupUserScopedData(targetSnapshot)
      );
      await runDeletionStep(run, "profile_picture", () =>
        deleteProfilePicture(targetSnapshot.pfpFilename)
      );

      if (hasOtherEnv) {
        await runDeletionStep(run, "auth_environment_marker", () =>
          authPrisma.authEnvironmentDeletion.upsert({
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
          })
        );
      }

      await runDeletionStep(run, "shadow_user", async () => {
        const { User } = require("../models/user");
        const deletedShadow = await User.delete({
          authUserId: Number(targetAuth.id),
        });
        if (!deletedShadow) {
          const remaining = await accountDeletionDb.users.count({
            where: { authUserId: Number(targetAuth.id) },
          });
          if (remaining > 0) throw new Error("账号本地数据删除失败。");
        }
      });

      if (!hasOtherEnv)
        await runDeletionStep(run, "shared_auth_user", () =>
          cleanupSharedAuthUser(targetAuth.id)
        );

      await verifyDeletionOutcome({
        targetSnapshot,
        targetAuth,
        hasOtherEnv,
      });

      consumeReauthToken(reauthToken);
      await accountDeletionDb.account_deletion_runs.update({
        where: { runId: run.runId },
        data: {
          status: "completed",
          currentStep: null,
          errorJson: null,
          completedAt: new Date(),
        },
      });
      await audit("account_deleted", actor, {
        authUserIdHash: fingerprint(targetAuth.id),
        env: normalizeEnv(env),
        deletionJobId: run.runId,
        workspaceCount: preview.totals.workspaceCount,
        deletedAt: new Date().toISOString(),
      });
      return {
        success: true,
        deletionRunId: run.runId,
        deletionJobId: run.runId,
        preview,
      };
    } catch (error) {
      const runId = run?.runId || deletionRunId || crypto.randomUUID();
      if (run?.runId) {
        await accountDeletionDb.account_deletion_runs
          .update({
            where: { runId: run.runId },
            data: {
              status: "failed",
              errorJson: JSON.stringify({
                code: "account_deletion_incomplete",
                message: safeReason(error.message),
                failedAt: new Date().toISOString(),
              }),
            },
          })
          .catch(() => null);
      }
      await audit("account_delete_failed", actor, {
        authUserIdHash: fingerprint(targetUser.authUserId || targetUser.id),
        env: normalizeEnv(env),
        deletionJobId: runId,
        reason: safeReason(error.message),
      });
      return {
        success: false,
        errorCode: "account_deletion_incomplete",
        deletionRunId: runId,
        deletionJobId: runId,
        error: error.message || "删除账户失败。",
      };
    }
  },
};

async function getOrCreateDeletionRun({
  runId,
  actor,
  targetUser,
  env,
  mode,
  previewFactory,
}) {
  if (runId) {
    const existing = await accountDeletionDb.account_deletion_runs.findUnique({
      where: { runId: String(runId) },
    });
    if (!existing) throw new Error("删除工作流不存在。");
    const context = parseRunContext(existing);
    const actorAuthUserId = Number(actor.authUserId || 0);
    if (
      context.actorAuthUserId &&
      Number(context.actorAuthUserId) !== actorAuthUserId
    )
      throw new Error("无权继续该删除工作流。");
    if (existing.status === "completed") return existing;
    return accountDeletionDb.account_deletion_runs.update({
      where: { runId: existing.runId },
      data: {
        status: "running",
        attempts: { increment: 1 },
        errorJson: null,
      },
    });
  }

  const preview = await previewFactory();
  const targetAuth = await authUserFor(targetUser);
  if (!targetAuth) throw new Error("共享认证账号不存在。");
  const context = {
    actorAuthUserId: actor.authUserId || null,
    target: {
      id: Number(targetUser.id),
      authUserId: targetUser.authUserId || targetAuth.id,
      username: targetUser.username || null,
      email: targetUser.email || null,
      pfpFilename: targetUser.pfpFilename || null,
    },
    targetAuth: {
      id: Number(targetAuth.id),
      role: targetAuth.role,
      ownerType: targetAuth.ownerType,
    },
    preview,
  };
  return accountDeletionDb.account_deletion_runs.create({
    data: {
      runId: crypto.randomUUID(),
      targetUserId: Number(targetUser.id),
      targetAuthUserId: Number(targetAuth.id),
      actorUserId: actor.id ? Number(actor.id) : null,
      env: normalizeEnv(env),
      mode,
      status: "running",
      contextJson: JSON.stringify(context),
    },
  });
}

function parseRunContext(run) {
  try {
    return JSON.parse(run?.contextJson || "{}");
  } catch {
    return {};
  }
}

function completedDeletionSteps(run) {
  try {
    const parsed = JSON.parse(run?.completedStepsJson || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function runDeletionStep(run, step, operation) {
  const completed = completedDeletionSteps(run);
  if (completed.includes(step)) return;
  await accountDeletionDb.account_deletion_runs.update({
    where: { runId: run.runId },
    data: { status: "running", currentStep: step },
  });
  await operation();
  const next = [...completed, step];
  await accountDeletionDb.account_deletion_runs.update({
    where: { runId: run.runId },
    data: {
      completedStepsJson: JSON.stringify(next),
      currentStep: null,
      errorJson: null,
    },
  });
  run.completedStepsJson = JSON.stringify(next);
}

async function verifyDeletionOutcome({
  targetSnapshot,
  targetAuth,
  hasOtherEnv,
}) {
  const localCount = await accountDeletionDb.users.count({
    where: { authUserId: Number(targetAuth.id) },
  });
  if (localCount > 0)
    throw new Error(`本地账号仍有 ${localCount} 条记录，删除核验未通过。`);
  if (!hasOtherEnv) {
    const authCount = await authPrisma.users.count({
      where: { id: Number(targetAuth.id) },
    });
    if (authCount > 0) throw new Error("共享认证账号删除核验未通过。");
  }
  const userScopedCount = await accountDeletionDb.temporary_auth_tokens.count({
    where: { userId: Number(targetSnapshot.id) },
  });
  if (userScopedCount > 0) throw new Error("临时认证数据删除核验未通过。");
}

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
  const { WorkspaceThread } = require("../models/workspaceThread");
  const { WorkspaceUser } = require("../models/workspaceUsers");
  await accountDeletionDb.workspace_chats.deleteMany({
    where: { workspaceId: workspace.id, user_id: Number(userId) },
  });
  await WorkspaceThread.delete({
    workspace_id: workspace.id,
    user_id: Number(userId),
  });
  await cleanupUserWorkspaceAuxiliaryData(Number(workspace.id), Number(userId));
  await WorkspaceUser.delete({
    workspace_id: workspace.id,
    user_id: Number(userId),
  });
}

async function cleanupWorkspaceAuxiliaryData(workspaceId) {
  await settledOrThrow("workspace_auxiliary", [
    accountDeletionDb.workspace_chat_compactions.deleteMany({
      where: { workspace_id: workspaceId },
    }),
    accountDeletionDb.workspace_mind_maps.deleteMany({
      where: { workspaceId },
    }),
    accountDeletionDb.workspace_agent_invocations.deleteMany({
      where: { workspace_id: workspaceId },
    }),
    deleteParsedFilesAndSources({ workspaceId }),
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
  await settledOrThrow("user_workspace_auxiliary", [
    accountDeletionDb.workspace_chat_compactions.deleteMany({
      where: { workspace_id: workspaceId, user_id: userId },
    }),
    accountDeletionDb.workspace_mind_maps.deleteMany({
      where: { workspaceId, user_id: userId },
    }),
    accountDeletionDb.workspace_agent_invocations.deleteMany({
      where: { workspace_id: workspaceId, user_id: userId },
    }),
    deleteParsedFilesAndSources({ workspaceId, userId }),
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
  await settledOrThrow("user_scoped", [
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
  await authPrisma.auth_sessions.deleteMany({ where: { authUserId: userId } });
  await authPrisma.invites.updateMany({
    where: { usedByUserId: userId },
    data: { usedByUserId: null },
  });
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
  try {
    await fs.promises.unlink(pfpPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function deleteParsedFilesAndSources(where) {
  const records = await accountDeletionDb.workspace_parsed_files.findMany({
    where,
    select: { metadata: true },
  });
  const result = await accountDeletionDb.workspace_parsed_files.deleteMany({
    where,
  });
  if (result.count > 0) cleanupDocxSources(records);
  return result;
}

async function settledOrThrow(label, promises) {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length === 0) return results;
  const reason = failures
    .map((failure) => safeReason(failure.reason?.message || failure.reason))
    .join("; ");
  throw new Error(`${label} cleanup failed: ${reason}`);
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
