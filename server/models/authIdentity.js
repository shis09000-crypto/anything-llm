const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const prisma = require("../utils/prisma");
const authPrisma = require("../utils/authPrisma");
const { appEnvironment, storageBaseDir } = require("../utils/environment");
const {
  CREDENTIAL_TYPES,
  hashPassword,
  verifyPassword,
} = require("../utils/security/passwordCredential");
const {
  ROLES,
  assertValidRole,
  canLogin,
  capabilitiesFor,
  deriveRoleDefaults,
  normalizeAllowedEnvs,
  normalizeEnv,
  normalizeOwnerType,
  normalizeRole,
  normalizeStatus,
} = require("../utils/authz/accountRoles");

const ORIGIN_ENVS = Object.freeze({
  production: "production",
  development: "development",
});
const LOCAL_SHADOW_PASSWORD_REPAIR_ENVS = Object.freeze([
  ORIGIN_ENVS.development,
  ORIGIN_ENVS.production,
]);

const SYNC_FIELDS = [
  "username",
  "displayName",
  "password",
  "credentialType",
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
];

function normalizeEmail(email = "") {
  const value = String(email || "")
    .trim()
    .toLowerCase();
  return value || null;
}

function normalizePhone(phone = "") {
  const value = String(phone || "").trim();
  return value || null;
}

function normalizeOriginEnv(value = appEnvironment()) {
  const origin = String(value || "")
    .trim()
    .toLowerCase();
  return Object.values(ORIGIN_ENVS).includes(origin)
    ? origin
    : ORIGIN_ENVS.development;
}

function sqliteUrl(dbPath) {
  const url = new URL(`file:${dbPath}`);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "10");
  return url.toString();
}

function localShadowIdentityClauses(authUser = {}) {
  const clauses = [];
  if (authUser.id) clauses.push({ authUserId: Number(authUser.id) });
  if (authUser.username) clauses.push({ username: authUser.username });
  if (authUser.email) clauses.push({ email: normalizeEmail(authUser.email) });
  if (authUser.phone) clauses.push({ phone: normalizePhone(authUser.phone) });
  return clauses;
}

function canLoginInCurrentEnv(authUser = null) {
  return canLogin(authUser, appEnvironment());
}

async function isDeletedInCurrentEnv(authUserId = null) {
  const id = Number(authUserId);
  if (!Number.isFinite(id)) return false;
  const deletion = await authPrisma.authEnvironmentDeletion.findUnique({
    where: {
      authUserId_env: {
        authUserId: id,
        env: normalizeEnv(appEnvironment()),
      },
    },
  });
  return Boolean(deletion);
}

async function canLoginInCurrentEnvAsync(authUser = null) {
  if (!canLoginInCurrentEnv(authUser)) return false;
  return !(await isDeletedInCurrentEnv(authUser.id));
}

function copyAuthFields(authUser = {}) {
  const copy = {};
  for (const field of SYNC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(authUser, field))
      copy[field] = authUser[field];
  }
  const roleDefaults = deriveRoleDefaults({
    role: authUser.role,
    status: authUser.status,
    originEnv: authUser.originEnv,
    allowedEnvs: authUser.allowedEnvs,
    suspended: authUser.suspended,
    ownerType: authUser.ownerType,
    username: authUser.username,
    email: authUser.email,
  });
  copy.role = roleDefaults.role;
  copy.status = roleDefaults.status;
  copy.allowedEnvs = roleDefaults.allowedEnvs;
  copy.ownerType = roleDefaults.ownerType;
  copy.suspended = roleDefaults.suspended;
  copy.authUserId = authUser.id;
  copy.originEnv = normalizeOriginEnv(roleDefaults.originEnv);
  return copy;
}

function authUserCreateData({
  username,
  passwordHash,
  credentialType = CREDENTIAL_TYPES.PASSWORD,
  role = ROLES.user,
  status = null,
  allowedEnvs = null,
  displayName = null,
  dailyMessageLimit = null,
  bio = "",
  email = null,
  emailVerifiedAt = null,
  phone = null,
  phoneVerifiedAt = null,
  pfpFilename = null,
  suspended = 0,
  ownerType = null,
  seenRecoveryCodes = false,
  originEnv = appEnvironment(),
}) {
  const rawRole = String(role || ROLES.user)
    .trim()
    .toLowerCase();
  if (
    !["default", "manager"].includes(rawRole) &&
    !["disabled", "user", "developer", "admin", "owner"].includes(rawRole)
  ) {
    assertValidRole(rawRole);
  }
  const roleDefaults = deriveRoleDefaults({
    role: rawRole,
    status,
    originEnv,
    allowedEnvs,
    suspended,
    ownerType,
    username,
    email,
  });
  return {
    username,
    displayName: displayName || username,
    password: passwordHash,
    credentialType,
    role: roleDefaults.role,
    status: roleDefaults.status,
    allowedEnvs: roleDefaults.allowedEnvs,
    ownerType: roleDefaults.ownerType,
    suspended: roleDefaults.suspended,
    dailyMessageLimit,
    bio: bio || "",
    ...(email ? { email: normalizeEmail(email) } : {}),
    ...(emailVerifiedAt ? { email_verified_at: emailVerifiedAt } : {}),
    ...(phone ? { phone: normalizePhone(phone) } : {}),
    ...(phoneVerifiedAt ? { phone_verified_at: phoneVerifiedAt } : {}),
    ...(pfpFilename ? { pfpFilename } : {}),
    seen_recovery_codes: Boolean(seenRecoveryCodes),
    originEnv: normalizeOriginEnv(roleDefaults.originEnv),
  };
}

async function findByLoginIdentifier(identifier = "") {
  const value = String(identifier || "").trim();
  if (!value) return null;

  const byUsername = await authPrisma.users.findFirst({
    where: { username: value },
  });
  if (byUsername) return byUsername;

  const byEmail = await authPrisma.users.findFirst({
    where: { email: normalizeEmail(value) },
  });
  if (byEmail) return byEmail;

  return authPrisma.users.findFirst({
    where: { phone: normalizePhone(value) },
  });
}

async function findById(id = null) {
  const authUserId = Number(id);
  if (!Number.isFinite(authUserId)) return null;
  return authPrisma.users.findUnique({ where: { id: authUserId } });
}

async function identityExists(clause = {}) {
  if (!clause || Object.keys(clause).length === 0) return false;
  return Boolean(await authPrisma.users.findFirst({ where: clause }));
}

async function createAuthUser(params = {}) {
  const passwordHash =
    params.passwordHash || (await hashPassword(String(params.password || "")));
  return authPrisma.users.create({
    data: authUserCreateData({ ...params, passwordHash }),
  });
}

async function ensureShadowUser(authUser = null, syncRepair = {}) {
  if (!authUser) return null;

  const authUserId = authUser.id;
  let shadow = await prisma.users.findFirst({ where: { authUserId } });

  if (!shadow && authUser.username) {
    shadow = await prisma.users.findFirst({
      where: { username: authUser.username },
    });
  }

  if (!shadow && authUser.email) {
    shadow = await prisma.users.findFirst({ where: { email: authUser.email } });
  }

  const data = copyAuthFields(authUser);
  if (shadow) {
    const changedFields = Object.keys(data).filter((field) => {
      const current = shadow[field];
      const next = data[field];
      if (current instanceof Date || next instanceof Date) {
        return (
          new Date(current || 0).getTime() !== new Date(next || 0).getTime()
        );
      }
      return JSON.stringify(current ?? null) !== JSON.stringify(next ?? null);
    });
    if (!changedFields.length) return shadow;

    const { SyncV2 } = require("./syncV2");
    const { nodeKeys } = require("../utils/syncV2/nodeRegistry");
    const {
      ENTITLEMENT_FIELDS,
      PROFILE_FIELDS,
      SECURITY_POLICY_FIELDS,
      hasAnyField,
      userEntitlementProjection,
      userProfileProjection,
      userSecurityPolicyProjection,
    } = require("../utils/syncV2/userProjection");
    const profileSync =
      SyncV2.enabled("profile") && hasAnyField(changedFields, PROFILE_FIELDS);
    const securitySync =
      SyncV2.enabled("security") &&
      hasAnyField(changedFields, SECURITY_POLICY_FIELDS);
    const entitlementSync =
      SyncV2.enabled("entitlements") &&
      hasAnyField(changedFields, ENTITLEMENT_FIELDS);
    const syncReady =
      (profileSync || securitySync || entitlementSync) &&
      (await SyncV2.schemaReady());
    if (!syncReady) {
      return prisma.users.update({ where: { id: shadow.id }, data });
    }
    return prisma.$transaction(async (tx) => {
      const repaired = await tx.users.update({
        where: { id: shadow.id },
        data,
      });
      const compensatedMutationId = syncRepair.compensatedMutationId || null;
      const common = {
        audience: [Number(shadow.id)],
        ...(compensatedMutationId
          ? {
              payloadHint: {
                compensatedMutation: true,
                compensatedMutationId,
                reason: syncRepair.reason || "shared_auth_replication_failed",
              },
            }
          : {}),
      };
      if (profileSync) {
        await SyncV2.recordNodeChange(tx, {
          ...common,
          nodeKey: nodeKeys.userProfile(shadow.id),
          content: userProfileProjection(repaired),
          changedPaths: changedFields.filter((field) =>
            PROFILE_FIELDS.has(field)
          ),
          eventType: compensatedMutationId
            ? "user.profile.mutation_compensated"
            : "user.profile.authority_repaired",
        });
      }
      if (securitySync) {
        await SyncV2.recordNodeChange(tx, {
          ...common,
          nodeKey: nodeKeys.userSecurityPolicies(shadow.id),
          content: userSecurityPolicyProjection(repaired),
          changedPaths: changedFields
            .filter((field) => SECURITY_POLICY_FIELDS.has(field))
            .map((field) => (field === "password" ? "credentials" : field)),
          eventType: compensatedMutationId
            ? "user.security_policy.mutation_compensated"
            : "user.security_policy.authority_repaired",
        });
      }
      if (entitlementSync) {
        await SyncV2.recordNodeChange(tx, {
          ...common,
          nodeKey: nodeKeys.userEntitlements(shadow.id),
          content: userEntitlementProjection(repaired),
          changedPaths: changedFields.filter((field) =>
            ENTITLEMENT_FIELDS.has(field)
          ),
          eventType: compensatedMutationId
            ? "user.entitlements.mutation_compensated"
            : "user.entitlements.authority_repaired",
        });
      }
      return repaired;
    });
  }

  return prisma.users.create({ data });
}

async function updateAuthUser(authUserId = null, updates = {}) {
  const id = Number(authUserId);
  if (!Number.isFinite(id) || !updates || Object.keys(updates).length === 0)
    return null;

  const data = {};
  for (const [field, value] of Object.entries(updates)) {
    if (!SYNC_FIELDS.includes(field)) continue;
    if (field === "email") data.email = normalizeEmail(value);
    else if (field === "phone") data.phone = normalizePhone(value);
    else if (field === "role") {
      const rawRole = String(value || "")
        .trim()
        .toLowerCase();
      if (
        !["default", "manager"].includes(rawRole) &&
        !["disabled", "user", "developer", "admin", "owner"].includes(rawRole)
      ) {
        assertValidRole(rawRole);
      }
      data.role = normalizeRole(rawRole);
    } else if (field === "status")
      data.status = normalizeStatus(value, updates.role);
    else if (field === "allowedEnvs")
      data.allowedEnvs = JSON.stringify(
        normalizeAllowedEnvs(value, updates.role)
      );
    else if (field === "ownerType")
      data.ownerType = normalizeOwnerType(value, updates.role);
    else data[field] = value;
  }

  if (
    Object.prototype.hasOwnProperty.call(data, "role") ||
    Object.prototype.hasOwnProperty.call(data, "status") ||
    Object.prototype.hasOwnProperty.call(data, "allowedEnvs") ||
    Object.prototype.hasOwnProperty.call(data, "ownerType") ||
    Object.prototype.hasOwnProperty.call(data, "suspended")
  ) {
    const current = await findById(id);
    const roleDefaults = deriveRoleDefaults({
      role: data.role ?? current?.role,
      status: data.status ?? current?.status,
      originEnv: data.originEnv ?? current?.originEnv,
      allowedEnvs: data.allowedEnvs ?? current?.allowedEnvs,
      suspended: data.suspended ?? current?.suspended,
      ownerType: data.ownerType ?? current?.ownerType,
      username: data.username ?? current?.username,
      email: data.email ?? current?.email,
    });
    data.role = roleDefaults.role;
    data.status = roleDefaults.status;
    data.allowedEnvs = roleDefaults.allowedEnvs;
    data.ownerType = roleDefaults.ownerType;
    data.suspended = roleDefaults.suspended;
    data.originEnv = roleDefaults.originEnv;
  }

  if (Object.keys(data).length === 0) return null;
  return authPrisma.users.update({ where: { id }, data });
}

async function matchingLocalShadowPassword(authUser = null, password = "") {
  if (appEnvironment() !== ORIGIN_ENVS.development) return null;
  if (!authUser || !String(password || "")) return null;

  const clauses = localShadowIdentityClauses(authUser);
  if (clauses.length === 0) return null;

  for (const envName of LOCAL_SHADOW_PASSWORD_REPAIR_ENVS) {
    const dbPath = path.join(storageBaseDir(), envName, "anythingllm.db");
    if (!fs.existsSync(dbPath)) continue;

    const envPrisma = new PrismaClient({
      datasources: { db: { url: sqliteUrl(dbPath) } },
      log: ["error"],
    });
    try {
      const shadow = await envPrisma.users.findFirst({
        where: { OR: clauses },
        select: {
          id: true,
          authUserId: true,
          username: true,
          email: true,
          password: true,
          credentialType: true,
        },
      });

      if (
        shadow?.password &&
        (!shadow.credentialType ||
          shadow.credentialType === CREDENTIAL_TYPES.PASSWORD) &&
        (await verifyPassword(String(password), shadow.password)).valid
      ) {
        return { envName, shadow };
      }
    } finally {
      await envPrisma.$disconnect().catch(() => {});
    }
  }

  return null;
}

async function repairPasswordFromLocalShadow(authUser = null, password = "") {
  const match = await matchingLocalShadowPassword(authUser, password);
  if (!match) return null;

  const passwordHash = await hashPassword(password);
  const repairedAuthUser = await authPrisma.users.update({
    where: { id: Number(authUser.id) },
    data: { password: passwordHash, credentialType: CREDENTIAL_TYPES.PASSWORD },
  });
  return { authUser: repairedAuthUser, repairedFromEnv: match.envName };
}

async function upgradePasswordHash(authUser = null, password = "") {
  if (!authUser?.id) return null;
  const passwordHash = await hashPassword(password);
  const upgraded = await authPrisma.users.update({
    where: { id: Number(authUser.id) },
    data: { password: passwordHash, credentialType: CREDENTIAL_TYPES.PASSWORD },
  });
  await prisma.users.updateMany({
    where: { authUserId: Number(authUser.id) },
    data: { password: passwordHash, credentialType: CREDENTIAL_TYPES.PASSWORD },
  });
  return upgraded;
}

async function bootstrapAuthUserFromShadow(shadowUser = null) {
  if (!shadowUser) return null;
  if (shadowUser.authUserId) return findById(shadowUser.authUserId);

  const authUser = await createAuthUser({
    ...shadowUser,
    passwordHash: shadowUser.password,
    emailVerifiedAt: shadowUser.email_verified_at,
    phoneVerifiedAt: shadowUser.phone_verified_at,
    seenRecoveryCodes: shadowUser.seen_recovery_codes,
    originEnv: shadowUser.originEnv || appEnvironment(),
  });

  await prisma.users.update({
    where: { id: shadowUser.id },
    data: {
      authUserId: authUser.id,
      originEnv: authUser.originEnv,
    },
  });

  return authUser;
}

module.exports = {
  AuthIdentity: {
    ORIGIN_ENVS,
    bootstrapAuthUserFromShadow,
    canLoginInCurrentEnv,
    canLoginInCurrentEnvAsync,
    capabilitiesFor,
    copyAuthFields,
    createAuthUser,
    ensureShadowUser,
    findById,
    findByLoginIdentifier,
    identityExists,
    isDeletedInCurrentEnv,
    matchingLocalShadowPassword,
    normalizeEmail,
    normalizeOriginEnv,
    normalizePhone,
    repairPasswordFromLocalShadow,
    upgradePasswordHash,
    updateAuthUser,
  },
};
