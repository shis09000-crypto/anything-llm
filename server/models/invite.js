const {
  throwModelDataAccessError,
} = require("../utils/dataAccess/modelErrors");
const crypto = require("crypto");
const { safeJsonParse } = require("../utils/http");
const authPrisma = require("../utils/authPrisma");
const { normalizeRole } = require("../utils/authz/accountRoles");

const INVITE_ROLES = ["user", "developer", "admin"];
const DEFAULT_INVITE_EXPIRY_HOURS = 24;

function hashToken(token = "") {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function statusFor(invite = {}) {
  if (invite.revokedAt || invite.status === "disabled") return "revoked";
  if (invite.consumedAt || invite.status === "claimed") return "consumed";
  if (invite.expiresAt && new Date(invite.expiresAt) <= new Date())
    return "expired";
  return "pending";
}

function sanitize(invite = null, { includeToken = false, token = null } = {}) {
  if (!invite) return null;
  const {
    tokenHash: _tokenHash,
    code: _code,
    status: _status,
    ...safeInvite
  } = invite;

  return {
    ...safeInvite,
    role: normalizeRole(safeInvite.role || "user"),
    status: statusFor(invite),
    ...(includeToken && token ? { token } : {}),
  };
}

const Invite = {
  roles: INVITE_ROLES,
  defaultExpiryHours: DEFAULT_INVITE_EXPIRY_HOURS,
  hashToken,
  makeToken,

  makeCode: makeToken,

  normalizeRole: function (role = "default") {
    const value = normalizeRole(role || "user");
    if (!INVITE_ROLES.includes(value)) return "user";
    return value;
  },

  calcExpiry: function (expiresInHours = DEFAULT_INVITE_EXPIRY_HOURS) {
    const hours = Number(expiresInHours);
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
    return new Date(Date.now() + safeHours * 60 * 60 * 1000);
  },

  publicInvite: sanitize,

  create: async function ({
    createdByUserId = 0,
    workspaceIds = [],
    role = "default",
    expiresInHours = DEFAULT_INVITE_EXPIRY_HOURS,
  }) {
    try {
      const token = makeToken();
      const tokenHash = hashToken(token);
      const inviteRole = this.normalizeRole(role);
      const invite = await authPrisma.invites.create({
        data: {
          code: tokenHash.slice(0, 32),
          tokenHash,
          role: inviteRole,
          createdBy: Number(createdByUserId) || 0,
          createdByAdminId: Number(createdByUserId) || null,
          workspaceIds: JSON.stringify(
            Array.isArray(workspaceIds) ? workspaceIds : []
          ),
          expiresAt: this.calcExpiry(expiresInHours),
        },
      });
      return {
        invite: sanitize(invite, { includeToken: true, token }),
        error: null,
      };
    } catch (error) {
      console.error("FAILED TO CREATE INVITE.", error.message);
      return { invite: null, error: error.message };
    }
  },

  deactivate: async function (inviteId = null) {
    try {
      const invite = await authPrisma.invites.update({
        where: { id: Number(inviteId) },
        data: {
          status: "disabled",
          revokedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });
      return { success: true, invite: sanitize(invite), error: null };
    } catch (error) {
      console.error(error.message);
      return { success: false, invite: null, error: error.message };
    }
  },

  markClaimed: async function (inviteId = null, user) {
    try {
      const invite = await authPrisma.invites.update({
        where: { id: Number(inviteId) },
        data: {
          status: "claimed",
          claimedBy: user.id,
          usedByUserId: user.id,
          consumedAt: new Date(),
          lastUpdatedAt: new Date(),
        },
      });

      try {
        if (!!invite?.workspaceIds) {
          const { Workspace } = require("./workspace");
          const { WorkspaceUser } = require("./workspaceUsers");
          const workspaceIds = (await Workspace.where({})).map(
            (workspace) => workspace.id
          );
          const ids = safeJsonParse(invite.workspaceIds, [])
            .map((id) => Number(id))
            .filter((id) => workspaceIds.includes(id));
          if (ids.length !== 0) await WorkspaceUser.createMany(user.id, ids);
        }
      } catch (e) {
        console.error(
          "Could not add user to workspaces automatically",
          e.message
        );
      }

      return { success: true, invite: sanitize(invite), error: null };
    } catch (error) {
      console.error(error.message);
      return { success: false, invite: null, error: error.message };
    }
  },

  get: async function (clause = {}) {
    try {
      const invite = await authPrisma.invites.findFirst({ where: clause });
      return invite || null;
    } catch (error) {
      throwModelDataAccessError("invite.get", error);
    }
  },

  getByToken: async function (token = "") {
    try {
      const value = String(token || "").trim();
      if (!value || value.length > 256) return null;
      const hashed = hashToken(value);
      const invite = await authPrisma.invites.findFirst({
        where: { tokenHash: hashed },
      });
      if (invite) return invite;

      // Compatibility for historical invites that stored the usable code in plaintext.
      return await authPrisma.invites.findFirst({
        where: { code: value, tokenHash: null },
      });
    } catch (error) {
      throwModelDataAccessError("invite.getByToken", error);
    }
  },

  isUsable: function (invite = null) {
    return Boolean(invite && statusFor(invite) === "pending");
  },

  count: async function (clause = {}) {
    try {
      return await authPrisma.invites.count({ where: clause });
    } catch (error) {
      throwModelDataAccessError("invite.count", error);
    }
  },

  delete: async function (clause = {}) {
    try {
      await authPrisma.invites.deleteMany({ where: clause });
      return true;
    } catch (error) {
      throwModelDataAccessError("invite.delete", error);
    }
  },

  where: async function (clause = {}, limit, offset = null) {
    try {
      const invites = await authPrisma.invites.findMany({
        where: clause,
        take: limit || undefined,
        ...(offset !== null ? { skip: offset } : {}),
        orderBy: { createdAt: "desc" },
      });
      return invites;
    } catch (error) {
      throwModelDataAccessError("invite.where", error);
    }
  },

  whereWithUsers: async function (clause = {}, limit, offset = null) {
    const { User } = require("./user");
    try {
      const invites = await this.where(clause, limit, offset);
      const safeInvites = [];
      for (const invite of invites) {
        const safeInvite = sanitize(invite);
        if (invite.claimedBy || invite.usedByUserId) {
          const acceptedUser = await User.get({
            id: invite.usedByUserId || invite.claimedBy,
          });
          safeInvite.claimedBy = acceptedUser
            ? {
                id: acceptedUser.id,
                username: acceptedUser.username,
                displayName: acceptedUser.displayName,
              }
            : null;
        }

        if (invite.createdBy || invite.createdByAdminId) {
          const createdUser = await User.get({
            id: invite.createdByAdminId || invite.createdBy,
          });
          safeInvite.createdBy = createdUser
            ? {
                id: createdUser.id,
                username: createdUser.username,
                displayName: createdUser.displayName,
              }
            : null;
        }
        safeInvites.push(safeInvite);
      }
      return safeInvites;
    } catch (error) {
      throwModelDataAccessError("invite.whereWithUsers", error);
    }
  },
};

module.exports = { Invite };
