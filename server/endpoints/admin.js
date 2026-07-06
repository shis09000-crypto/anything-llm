const crypto = require("crypto");
const { ApiKey } = require("../models/apiKeys");
const {
  DocumentRepository: Document,
} = require("../repositories/documentRepository");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { Invite } = require("../models/invite");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { AuthIdentity } = require("../models/authIdentity");
const {
  DocumentVectorRepository: DocumentVectors,
} = require("../repositories/documentVectorRepository");
const {
  WorkspaceRepository: Workspace,
} = require("../repositories/workspaceRepository");
const {
  WorkspaceChatRepository: WorkspaceChats,
} = require("../repositories/workspaceChatRepository");
const prisma = require("../utils/prisma");
const {
  getVectorDbClass,
  getEmbeddingEngineSelection,
} = require("../utils/helpers");
const {
  forceSecondaryOwnerOnPromotion,
  validRoleSelection,
  canModifyAdmin,
  validCanModify,
} = require("../utils/helpers/admin");
const authPrisma = require("../utils/authPrisma");
const {
  ROLES: ACCOUNT_ROLES,
  OWNER_TYPES,
  assertOwnerWillRemainAfterMutation,
  assertBanAllowed,
  assertUnbanAllowed,
  authUserRole,
  canCreateRole,
  normalizeRole,
  deriveRoleDefaults,
} = require("../utils/authz/accountRoles");
const { AccountDeletionService } = require("../utils/accountDeletion");
const {
  validateReauthToken,
  consumeReauthToken,
} = require("../utils/authz/reauthTokens");
const { reqBody, userFromSession, safeJsonParse } = require("../utils/http");
const {
  strictMultiUserRoleValid,
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const ImportedPlugin = require("../utils/agents/imported");
const {
  simpleSSOLoginDisabledMiddleware,
} = require("../utils/middleware/simpleSSOEnabled");
const { recordClientTrustCheckpoint } = require("../utils/clientIdentity");
const { getClientContext } = require("../utils/clientIdentity");
const {
  authSessionFingerprintFromRequest,
} = require("../utils/authz/vaultAccessGrants");
const { issueSensitiveSession } = require("../utils/authz/sensitiveSessions");

const DEFAULT_ADMIN_PAGE_LIMIT = 50;
const MAX_ADMIN_PAGE_LIMIT = 200;

function paginationFromQuery(request) {
  const query = request.query || {};
  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || DEFAULT_ADMIN_PAGE_LIMIT, 1),
    MAX_ADMIN_PAGE_LIMIT
  );
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  const paged =
    query.limit !== undefined ||
    query.offset !== undefined ||
    query.paged === "true";
  return { limit, offset, paged };
}

function banContextFor({ actorAuth, targetAuth }) {
  const now = new Date();
  return {
    role: ACCOUNT_ROLES.disabled,
    status: "disabled",
    allowedEnvs: "[]",
    ownerType: null,
    suspended: 1,
    previousRole: normalizeRole(targetAuth.role),
    previousAllowedEnvs: targetAuth.allowedEnvs,
    previousOwnerType: targetAuth.ownerType,
    banActorRole: normalizeRole(actorAuth.role),
    banActorOwnerType: actorAuth.ownerType,
    banActorAuthUserId: actorAuth.id,
    bannedAt: now,
  };
}

function restoreContextFor(targetAuth, body = {}) {
  const legacyDisabled =
    authUserRole(targetAuth) === ACCOUNT_ROLES.disabled &&
    !targetAuth.previousRole;
  return {
    role: normalizeRole(
      targetAuth.previousRole ||
        (legacyDisabled ? ACCOUNT_ROLES.user : body.restoreRole)
    ),
    allowedEnvs: targetAuth.previousAllowedEnvs || body.restoreAllowedEnvs,
    ownerType: targetAuth.previousOwnerType || targetAuth.ownerType,
  };
}

function clearBanContext() {
  return {
    previousRole: null,
    previousAllowedEnvs: null,
    previousOwnerType: null,
    banActorRole: null,
    banActorOwnerType: null,
    banActorAuthUserId: null,
    bannedAt: null,
  };
}

function recordAdminCheckpoint(
  request,
  action,
  resourceType,
  resourceId = null
) {
  void recordClientTrustCheckpoint(request, {
    action,
    resourceType,
    resourceId,
    outcome: "received",
  });
}

function adminEndpoints(app) {
  if (!app) return;

  app.get(
    "/admin/users",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { limit, offset, paged } = paginationFromQuery(request);
        const users = await User.where({}, paged ? limit : null, {
          offset: paged ? offset : null,
          orderBy: { id: "asc" },
        });
        const total = paged ? await User.count({}) : users.length;
        response.status(200).json({
          users,
          page: paged
            ? {
                limit,
                offset,
                total,
                hasMore: offset + users.length < total,
              }
            : null,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/users/new",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const currUser = await userFromSession(request, response);
        const newUserParams = reqBody(request);
        recordAdminCheckpoint(request, "admin_user_create", "admin_user");
        if (normalizeRole(newUserParams.role) === ACCOUNT_ROLES.owner) {
          response.status(200).json({
            user: null,
            error: "Owner can only be granted from user edit.",
          });
          return;
        }
        const roleValidation = validRoleSelection(currUser, newUserParams);

        if (!roleValidation.valid) {
          response
            .status(200)
            .json({ user: null, error: roleValidation.error });
          return;
        }

        const { user: newUser, error } = await User.create(newUserParams);
        if (!!newUser) {
          await EventLogs.logEvent(
            "user_created",
            {
              userName: newUser.username,
              createdBy: currUser.username,
            },
            currUser.id
          );
        }

        response.status(200).json({ user: newUser, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/user/:id",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const currUser = await userFromSession(request, response);
        const { id } = request.params;
        const updates = reqBody(request);
        recordAdminCheckpoint(request, "admin_user_update", "admin_user", id);
        const user = await User.get({ id: Number(id) });

        const canModify = validCanModify(currUser, user);
        if (!canModify.valid) {
          response.status(200).json({ success: false, error: canModify.error });
          return;
        }

        const roleValidation = validRoleSelection(currUser, updates, {
          allowOwner: true,
        });
        if (!roleValidation.valid) {
          response
            .status(200)
            .json({ success: false, error: roleValidation.error });
          return;
        }

        forceSecondaryOwnerOnPromotion(user, updates);
        if (
          Object.prototype.hasOwnProperty.call(updates, "role") &&
          normalizeRole(updates.role) !== ACCOUNT_ROLES.owner
        ) {
          updates.ownerType = null;
        } else if (
          normalizeRole(updates.role) === ACCOUNT_ROLES.owner &&
          normalizeRole(user?.role) !== ACCOUNT_ROLES.owner &&
          !updates.ownerType
        ) {
          updates.ownerType = OWNER_TYPES.secondary;
        }

        const validAdminRoleModification = await canModifyAdmin(
          user,
          updates,
          currUser
        );
        if (!validAdminRoleModification.valid) {
          response
            .status(200)
            .json({ success: false, error: validAdminRoleModification.error });
          return;
        }

        const { success, error } = await User.update(id, updates);
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  const deleteAdminUser = async (request, response) => {
    try {
      const currUser = await userFromSession(request, response);
      const { id } = request.params;
      const user = await User._get({ id: Number(id) });
      const { confirm, reauthToken } = reqBody(request) || {};
      recordAdminCheckpoint(request, "admin_user_delete", "admin_user", id);

      if (!user) {
        response.status(404).json({ success: false, error: "User not found" });
        return;
      }

      const reauth = validateReauthToken(reauthToken, currUser.id);
      if (!reauth) {
        response.status(401).json({
          success: false,
          error: "请先完成安全验证。",
        });
        return;
      }

      const result = await AccountDeletionService.execute({
        actor: currUser,
        target: user,
        confirm: Boolean(confirm),
        reauthToken,
        mode: "owner_delete",
      });
      if (result.success) consumeReauthToken(reauthToken);
      response.status(result.success ? 200 : 400).json(result);
    } catch (e) {
      console.error(e);
      response
        .status(500)
        .json({ success: false, error: e.message || "Failed to delete user" });
    }
  };

  app.delete(
    "/admin/user/:id",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    deleteAdminUser
  );

  app.delete(
    "/admin/users/:id",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    deleteAdminUser
  );

  app.get(
    "/admin/users/:id/delete-preview",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const currUser = await userFromSession(request, response);
        const user = await User._get({ id: Number(request.params.id) });
        if (!user) {
          response
            .status(404)
            .json({ success: false, error: "User not found" });
          return;
        }
        const preview = await AccountDeletionService.preview({
          actor: currUser,
          target: user,
          mode: "owner_delete",
        });
        response.status(200).json({ success: true, preview });
      } catch (error) {
        response.status(400).json({
          success: false,
          error: error.message || "无法生成删除预览。",
        });
      }
    }
  );

  app.post(
    "/admin/users/:id/ban",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const actor = await userFromSession(request, response);
        const target = await User._get({ id: Number(request.params.id) });
        recordAdminCheckpoint(
          request,
          "admin_user_ban",
          "admin_user",
          request.params.id
        );
        if (!target?.authUserId) {
          response
            .status(404)
            .json({ success: false, error: "User not found" });
          return;
        }
        const actorAuth = await AuthIdentity.findById(actor.authUserId);
        const targetAuth = await AuthIdentity.findById(target.authUserId);
        assertBanAllowed(actorAuth, targetAuth);
        await assertOwnerWillRemainAfterMutation({
          authPrisma,
          targetAuthUserId: targetAuth.id,
          env: process.env.APP_ENV || "development",
          nextStatus: "disabled",
          nextSuspended: 1,
          nextAllowedEnvs: [],
        });

        const disabled = banContextFor({ actorAuth, targetAuth });
        await authPrisma.users.update({
          where: { id: targetAuth.id },
          data: disabled,
        });
        await prisma.users.update({
          where: { id: target.id },
          data: disabled,
        });
        await EventLogs.logEvent(
          "account_banned",
          {
            authUserIdHash: hashId(targetAuth.id),
            actorRole: actorAuth?.role,
            reason: safeAuditText(reqBody(request)?.reason),
          },
          actor.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (error) {
        response.status(400).json({
          success: false,
          error: error.message || "封禁账号失败。",
        });
      }
    }
  );

  app.post(
    "/admin/users/:id/unban",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const actor = await userFromSession(request, response);
        const target = await User._get({ id: Number(request.params.id) });
        recordAdminCheckpoint(
          request,
          "admin_user_unban",
          "admin_user",
          request.params.id
        );
        if (!target?.authUserId) {
          response
            .status(404)
            .json({ success: false, error: "User not found" });
          return;
        }
        const body = reqBody(request) || {};
        const actorAuth = await AuthIdentity.findById(actor.authUserId);
        const targetAuth = await AuthIdentity.findById(target.authUserId);
        const restore = restoreContextFor(targetAuth, body);
        const restoreRole = restore.role;
        const restoreAllowedEnvs = restore.allowedEnvs || undefined;
        assertUnbanAllowed(actorAuth, targetAuth, { restoreRole });
        const roleDefaults = deriveRoleDefaults({
          role: restoreRole,
          status: "active",
          allowedEnvs: restoreAllowedEnvs,
          ownerType: restore.ownerType,
          username: targetAuth.username,
          email: targetAuth.email,
        });
        const restored = { ...roleDefaults, ...clearBanContext() };
        await assertOwnerWillRemainAfterMutation({
          authPrisma,
          targetAuthUserId: targetAuth.id,
          env: process.env.APP_ENV || "development",
          nextRole: roleDefaults.role,
          nextStatus: roleDefaults.status,
          nextAllowedEnvs: roleDefaults.allowedEnvs,
          nextSuspended: roleDefaults.suspended,
        });

        await authPrisma.users.update({
          where: { id: targetAuth.id },
          data: restored,
        });
        await prisma.users.update({
          where: { id: target.id },
          data: restored,
        });
        await EventLogs.logEvent(
          "account_unbanned",
          {
            authUserIdHash: hashId(targetAuth.id),
            actorRole: actorAuth?.role,
            restoreRole: roleDefaults.role,
          },
          actor.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (error) {
        response.status(400).json({
          success: false,
          error: error.message || "解除封禁失败。",
        });
      }
    }
  );

  app.get(
    "/admin/invites",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { limit, offset, paged } = paginationFromQuery(request);
        const invites = await Invite.whereWithUsers(
          {},
          paged ? limit : null,
          paged ? offset : null
        );
        const total = paged ? await Invite.count({}) : invites.length;
        response.status(200).json({
          invites,
          page: paged
            ? {
                limit,
                offset,
                total,
                hasMore: offset + invites.length < total,
              }
            : null,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/invite/new",
    [
      validatedRequest,
      strictMultiUserRoleValid([ROLES.admin]),
      simpleSSOLoginDisabledMiddleware,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const role = normalizeRole(body?.role || ACCOUNT_ROLES.user);
        recordAdminCheckpoint(request, "admin_invite_create", "invite");
        if (role === ACCOUNT_ROLES.owner) {
          response.status(200).json({
            invite: null,
            error:
              "Owner invites are disabled. Promote an existing account from user edit.",
          });
          return;
        }
        if (!canCreateRole(user, role)) {
          response.status(200).json({
            invite: null,
            error: "Invalid role selection for user.",
          });
          return;
        }
        const { invite, error } = await Invite.create({
          createdByUserId: user.id,
          role,
          expiresInHours: body?.expiresInHours || 24,
          workspaceIds: body?.workspaceIds || [],
        });

        await EventLogs.logEvent(
          role === ACCOUNT_ROLES.user
            ? "invite_created"
            : "admin_invite_created",
          {
            inviteId: invite?.id || null,
            role,
            createdBy: response.locals?.user?.username,
            expiresAt: invite?.expiresAt || null,
          },
          response.locals?.user?.id
        );
        response.status(200).json({ invite, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/invite/:id",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        recordAdminCheckpoint(request, "admin_invite_delete", "invite", id);
        const { success, error, invite } = await Invite.deactivate(id);
        await EventLogs.logEvent(
          normalizeRole(invite?.role) === ACCOUNT_ROLES.user
            ? "invite_deleted"
            : "admin_invite_revoked",
          {
            inviteId: Number(id),
            role: invite?.role || null,
            deletedBy: response.locals?.user?.username,
          },
          response.locals?.user?.id
        );
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/workspaces",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { limit, offset, paged } = paginationFromQuery(request);
        const workspaces = await Workspace.whereWithUsers(
          {},
          paged ? limit : null,
          { id: "asc" },
          paged ? offset : null
        );
        const total = paged ? await Workspace.count({}) : workspaces.length;
        response.status(200).json({
          workspaces,
          page: paged
            ? {
                limit,
                offset,
                total,
                hasMore: offset + workspaces.length < total,
              }
            : null,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/workspaces/:workspaceId/users",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { workspaceId } = request.params;
        const users = await Workspace.workspaceUsers(workspaceId);
        response.status(200).json({ users });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/workspaces/new",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { name } = reqBody(request);
        recordAdminCheckpoint(request, "admin_workspace_create", "workspace");
        const { workspace, message: error } = await Workspace.new(
          name,
          user.id
        );
        response.status(200).json({ workspace, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/workspaces/:workspaceId/update-users",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { workspaceId } = request.params;
        const { userIds } = reqBody(request);
        recordAdminCheckpoint(
          request,
          "admin_workspace_update_users",
          "workspace",
          workspaceId
        );
        const { success, error } = await Workspace.updateUsers(
          workspaceId,
          userIds
        );
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/workspaces/:id",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const VectorDb = getVectorDbClass();
        const workspace = await Workspace.get({ id: Number(id) });
        recordAdminCheckpoint(
          request,
          "admin_workspace_delete",
          "workspace",
          id
        );
        if (!workspace) {
          response.sendStatus(404).end();
          return;
        }

        await WorkspaceChats.delete({ workspaceId: Number(workspace.id) });
        await DocumentVectors.deleteForWorkspace(Number(workspace.id));
        await Document.delete({ workspaceId: Number(workspace.id) });
        await Workspace.delete({ id: Number(workspace.id) });
        try {
          await VectorDb["delete-namespace"]({ namespace: workspace.slug });
        } catch (e) {
          console.error(e.message);
        }

        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // System preferences but only by array of labels
  app.get(
    "/admin/system-preferences-for",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const requestedSettings = {};
        const labels = request.query.labels?.split(",") || [];
        const needEmbedder = [
          "text_splitter_chunk_size",
          "max_embed_chunk_size",
        ];
        const noRecord = [
          "max_embed_chunk_size",
          "agent_sql_connections",
          "imported_agent_skills",
          "feature_flags",
          "meta_page_title",
          "meta_page_favicon",
        ];

        for (const label of labels) {
          // Skip any settings that are not explicitly defined as public
          if (!SystemSettings.publicFields.includes(label)) continue;

          // Only get the embedder if the setting actually needs it
          let embedder = needEmbedder.includes(label)
            ? getEmbeddingEngineSelection()
            : null;
          // Only get the record from db if the setting actually needs it
          let setting = noRecord.includes(label)
            ? null
            : await SystemSettings.get({ label });

          switch (label) {
            case "footer_data":
              requestedSettings[label] = setting?.value ?? JSON.stringify([]);
              break;
            case "support_email":
              requestedSettings[label] = setting?.value || null;
              break;
            case "text_splitter_chunk_size":
              requestedSettings[label] =
                setting?.value || embedder?.embeddingMaxChunkLength || null;
              break;
            case "text_splitter_chunk_overlap":
              requestedSettings[label] = setting?.value || null;
              break;
            case "max_embed_chunk_size":
              requestedSettings[label] =
                embedder?.embeddingMaxChunkLength || 1000;
              break;
            case "agent_search_provider":
              requestedSettings[label] = setting?.value || null;
              break;
            case "agent_sql_connections":
              requestedSettings[label] =
                await SystemSettings.agent_sql_connections();
              break;
            case "default_agent_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_agent_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_filesystem_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "file_access_default_mode":
              requestedSettings[label] = setting?.value || "sandbox";
              break;
            case "file_access_authorized_directories":
            case "file_access_open_blacklist":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_create_files_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_gmail_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_outlook_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "imported_agent_skills":
              requestedSettings[label] = ImportedPlugin.listImportedPlugins();
              break;
            case "custom_app_name":
              requestedSettings[label] = setting?.value || null;
              break;
            case "feature_flags":
              requestedSettings[label] =
                (await SystemSettings.getFeatureFlags()) || {};
              break;
            case "meta_page_title":
              requestedSettings[label] =
                await SystemSettings.getValueOrFallback({ label }, null);
              break;
            case "meta_page_favicon":
              requestedSettings[label] =
                await SystemSettings.getValueOrFallback({ label }, null);
              break;
            case "button_lab_app_icon_params":
              requestedSettings[label] = setting?.value || null;
              break;
            case "allow_public_registration":
              requestedSettings[label] = String(
                await SystemSettings.allowPublicRegistration()
              );
              break;
            default:
              break;
          }
        }

        response.status(200).json({ settings: requestedSettings });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/system-preferences",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        let updates = reqBody(request);
        recordAdminCheckpoint(
          request,
          "admin_system_preferences_update",
          "system_settings"
        );

        const result = await SystemSettings.updateSettings(updates);
        const fileAccessKeys = [
          "file_access_default_mode",
          "file_access_authorized_directories",
          "file_access_open_blacklist",
        ];
        if (result.success && fileAccessKeys.some((key) => key in updates)) {
          await EventLogs.logEvent(
            "file_access_global_policy_updated",
            {
              updatedKeys: Object.keys(updates).filter((key) =>
                fileAccessKeys.includes(key)
              ),
              mode: updates.file_access_default_mode || null,
            },
            response.locals?.user?.id
          );
        }
        response.status(200).json(result);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/api-keys",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const apiKeys = await ApiKey.whereWithUser({});
        return response.status(200).json({
          apiKeys,
          error: null,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          apiKey: null,
          error: "Could not find an API Keys.",
        });
      }
    }
  );

  app.post(
    "/admin/generate-api-key",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { name = null } = reqBody(request);
        recordAdminCheckpoint(request, "admin_api_key_create", "api_key");
        const { apiKey, error } = await ApiKey.create(user.id, name);
        const context = getClientContext(request);
        const sensitiveSession =
          apiKey?.id && context?.clientId
            ? issueSensitiveSession({
                userId: user.id,
                clientId: context.clientId,
                resourceType: "api_key",
                resourceId: apiKey.id,
                ownerScope: `admin:api-key:${apiKey.id}`,
                method: "admin-generate-api-key",
                requestId:
                  request.signedRequest?.requestId || context.requestId || null,
                sessionFingerprint: authSessionFingerprintFromRequest(request),
              })
            : null;
        await EventLogs.logEvent(
          "api_key_created",
          { createdBy: user?.username, name: apiKey?.name },
          user?.id
        );
        return response.status(200).json({
          apiKey,
          sensitiveSession,
          error,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/delete-api-key/:id",
    [validatedRequest, strictMultiUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        if (!id || isNaN(Number(id))) return response.sendStatus(400).end();
        recordAdminCheckpoint(request, "admin_api_key_delete", "api_key", id);
        await ApiKey.delete({ id: Number(id) });

        await EventLogs.logEvent(
          "api_key_deleted",
          { deletedBy: response.locals?.user?.username },
          response?.locals?.user?.id
        );
        return response.status(200).end();
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

function hashId(value) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 16);
}

function safeAuditText(value = "") {
  return String(value || "")
    .replace(/[<>]/g, "")
    .slice(0, 160);
}

module.exports = { adminEndpoints };
