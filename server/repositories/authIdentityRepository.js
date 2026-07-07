const { AuthIdentity } = require("../models/authIdentity");
const { User } = require("../models/user");
const prisma = require("../utils/prisma");
const { appEnvironment } = require("../utils/environment");
const {
  normalizeAllowedEnvs,
  normalizeRole,
  normalizeStatus,
} = require("../utils/authz/accountRoles");

const SYNC_AUTH_TO_SHADOW_FIELDS = Object.freeze([
  "username",
  "displayName",
  "pfpFilename",
  "role",
  "status",
  "allowedEnvs",
  "ownerType",
  "suspended",
  "previousRole",
  "previousAllowedEnvs",
  "previousOwnerType",
  "banActorRole",
  "banActorOwnerType",
  "banActorAuthUserId",
  "bannedAt",
  "dailyMessageLimit",
  "bio",
  "email",
  "email_verified_at",
  "phone",
  "phone_verified_at",
  "seen_recovery_codes",
]);

const PASSWORD_SYNC_RULE = Object.freeze({
  source: "shared-auth",
  shadowRepair: "local-shadow-password-may-repair-shared-auth",
  exposePlaintext: false,
});

function compactAuthUser(authUser = null) {
  if (!authUser) return null;
  return {
    id: authUser.id,
    username: authUser.username,
    email: authUser.email || null,
    phone: authUser.phone || null,
    role: normalizeRole(authUser.role),
    status: normalizeStatus(authUser.status, authUser.role, authUser.suspended),
    allowedEnvs: normalizeAllowedEnvs(authUser.allowedEnvs, authUser.role),
    originEnv: authUser.originEnv || null,
    authUserId: authUser.authUserId || authUser.id || null,
  };
}

function compactShadowUser(user = null) {
  if (!user) return null;
  return {
    id: user.id,
    authUserId: user.authUserId || null,
    username: user.username,
    email: user.email || null,
    phone: user.phone || null,
    role: normalizeRole(user.role),
    status: normalizeStatus(user.status, user.role, user.suspended),
    allowedEnvs: normalizeAllowedEnvs(user.allowedEnvs, user.role),
    originEnv: user.originEnv || null,
  };
}

const AuthIdentityRepository = {
  dataDomain: "auth-identity",
  repositoryName: "AuthIdentityRepository",

  get model() {
    return AuthIdentity;
  },

  get shadowUser() {
    return User;
  },

  get localDb() {
    return {
      systemSettings: {
        findFirst: (options) => prisma.system_settings.findFirst(options),
        upsert: (options) => prisma.system_settings.upsert(options),
      },
      users: {
        findUnique: (options) => prisma.users.findUnique(options),
      },
      trustedLoginDevice: {
        findMany: (options) => prisma.trustedLoginDevice.findMany(options),
      },
    };
  },

  describeSyncPolicy() {
    return {
      currentEnvironment: appEnvironment(),
      sourceOfTruth: "shared-auth",
      localShadowPurpose: "runtime-compatibility-and-legacy-joins",
      password: PASSWORD_SYNC_RULE,
      authToShadowFields: [...SYNC_AUTH_TO_SHADOW_FIELDS],
      shadowToAuthRepair: [
        "password",
        "email_verified_at",
        "phone_verified_at",
        "seen_recovery_codes",
      ],
      forbidden: [
        "secret-plaintext",
        "password-plaintext",
        "cookie",
        "authorization",
      ],
    };
  },

  async findById(authUserId = null) {
    const authUser = await AuthIdentity.findById(authUserId);
    return compactAuthUser(authUser);
  },

  async findByLoginIdentifier(identifier = "") {
    const authUser = await AuthIdentity.findByLoginIdentifier(identifier);
    return compactAuthUser(authUser);
  },

  async shadowForAuthUser(authUser = null) {
    const authUserId = Number(authUser?.authUserId || authUser?.id);
    if (!Number.isFinite(authUserId)) return null;
    const shadow = await User._get({
      authUserId,
    });
    return compactShadowUser(shadow);
  },

  async authForShadowUser(shadowUser = null) {
    if (!shadowUser?.authUserId) return null;
    const authUser = await AuthIdentity.findById(shadowUser?.authUserId);
    return compactAuthUser(authUser);
  },

  async canLoginInCurrentEnvAsync(authUser = null) {
    return AuthIdentity.canLoginInCurrentEnvAsync(authUser);
  },

  async ensureShadowUser(authUser = null) {
    const shadow = await AuthIdentity.ensureShadowUser(authUser);
    return compactShadowUser(shadow);
  },

  async repairPasswordFromLocalShadow(shadowUser = null) {
    return AuthIdentity.repairPasswordFromLocalShadow(shadowUser);
  },
};

module.exports = { AuthIdentityRepository };
