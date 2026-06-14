const bcrypt = require("bcryptjs");
const prisma = require("../utils/prisma");
const authPrisma = require("../utils/authPrisma");
const { appEnvironment } = require("../utils/environment");
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

const SYNC_FIELDS = [
  "username",
  "displayName",
  "password",
  "pfpFilename",
  "role",
  "status",
  "allowedEnvs",
  "ownerType",
  "suspended",
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
  password,
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
    password: passwordHash || bcrypt.hashSync(String(password || ""), 10),
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
  return authPrisma.users.create({ data: authUserCreateData(params) });
}

async function ensureShadowUser(authUser = null) {
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
    return prisma.users.update({
      where: { id: shadow.id },
      data,
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
    normalizeEmail,
    normalizeOriginEnv,
    normalizePhone,
    updateAuthUser,
  },
};
