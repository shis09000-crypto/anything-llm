const VALID_ENVS = Object.freeze(["production", "development"]);
const VALID_ROLES = Object.freeze([
  "disabled",
  "user",
  "developer",
  "admin",
  "owner",
]);

const ROLES = Object.freeze({
  all: "<all>",
  disabled: "disabled",
  user: "user",
  developer: "developer",
  admin: "admin",
  owner: "owner",
  // Legacy aliases kept so older route code cannot reintroduce free-form roles.
  default: "default",
  manager: "manager",
});

const STATUS = Object.freeze({
  active: "active",
  disabled: "disabled",
});

const OWNER_TYPES = Object.freeze({
  primary: "primary",
  secondary: "secondary",
});

const PRIMARY_OWNER = Object.freeze({
  username: "shis500225",
  email: "shis500225@gmail.com",
});

const MAX_ACTIVE_OWNERS = 3;

const ROLE_RANK = Object.freeze({
  disabled: 0,
  user: 1,
  developer: 2,
  admin: 3,
  owner: 4,
});

const LOGIN_GENERIC_ERROR = "账号或密码不正确";
const LOGIN_DISABLED_ERROR = "账号已被禁用";

function normalizeRole(role = ROLES.user) {
  const value = String(role || ROLES.user)
    .trim()
    .toLowerCase();
  if (value === "default") return ROLES.user;
  if (value === "manager") return ROLES.admin;
  if (VALID_ROLES.includes(value)) return value;
  return ROLES.user;
}

function assertValidRole(role) {
  const value = String(role || "")
    .trim()
    .toLowerCase();
  if (!VALID_ROLES.includes(value)) {
    throw new Error(
      `Invalid role. Allowed roles are: ${VALID_ROLES.join(", ")}`
    );
  }
  return value;
}

function normalizeStatus(
  status = STATUS.active,
  role = ROLES.user,
  suspended = 0
) {
  if (normalizeRole(role) === ROLES.disabled) return STATUS.disabled;
  if (Number(Boolean(suspended)) === 1) return STATUS.disabled;
  return String(status || STATUS.active)
    .trim()
    .toLowerCase() === STATUS.disabled
    ? STATUS.disabled
    : STATUS.active;
}

function isPrimaryOwnerIdentity(user = {}) {
  const username = String(user?.username || "")
    .trim()
    .toLowerCase();
  const email = String(user?.email || "")
    .trim()
    .toLowerCase();
  return username === PRIMARY_OWNER.username || email === PRIMARY_OWNER.email;
}

function normalizeOwnerType(ownerType = null, role = ROLES.user, user = {}) {
  if (normalizeRole(role) !== ROLES.owner) return null;
  if (isPrimaryOwnerIdentity(user)) return OWNER_TYPES.primary;
  const value = String(ownerType || "")
    .trim()
    .toLowerCase();
  return value === OWNER_TYPES.primary
    ? OWNER_TYPES.secondary
    : OWNER_TYPES.secondary;
}

function normalizeEnv(env = "development") {
  const value = String(env || "")
    .trim()
    .toLowerCase();
  return VALID_ENVS.includes(value) ? value : "development";
}

function roleOriginEnv(role = ROLES.user, fallback = null) {
  const normalized = normalizeRole(role);
  if (normalized === ROLES.developer) return "development";
  if (normalized === ROLES.user) return "production";
  return fallback ? normalizeEnv(fallback) : "production";
}

function roleAllowedEnvs(role = ROLES.user) {
  switch (normalizeRole(role)) {
    case ROLES.disabled:
      return [];
    case ROLES.developer:
      return ["development"];
    case ROLES.admin:
    case ROLES.owner:
      return ["production", "development"];
    case ROLES.user:
    default:
      return ["production"];
  }
}

function normalizeAllowedEnvs(value = null, role = ROLES.user) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = parsed
        .split(",")
        .map((env) => env.trim())
        .filter(Boolean);
    }
  }

  const envs = Array.isArray(parsed)
    ? parsed.map(normalizeEnv).filter((env) => VALID_ENVS.includes(env))
    : roleAllowedEnvs(role);
  return [...new Set(envs)];
}

function serializeAllowedEnvs(value = null, role = ROLES.user) {
  return JSON.stringify(normalizeAllowedEnvs(value, role));
}

function authUserRole(authUser = {}) {
  return normalizeStatus(authUser.status, authUser.role, authUser.suspended) ===
    STATUS.disabled
    ? ROLES.disabled
    : normalizeRole(authUser.role);
}

function deriveRoleDefaults({
  role = ROLES.user,
  status = null,
  originEnv = null,
  allowedEnvs = null,
  suspended = 0,
  ownerType = null,
  username = null,
  email = null,
} = {}) {
  const normalizedRole = normalizeRole(role);
  const normalizedStatus = normalizeStatus(
    status || STATUS.active,
    normalizedRole,
    suspended
  );
  const finalRole =
    normalizedStatus === STATUS.disabled ? ROLES.disabled : normalizedRole;
  return {
    role: finalRole,
    status: normalizedStatus,
    suspended: normalizedStatus === STATUS.disabled ? 1 : 0,
    originEnv: roleOriginEnv(finalRole, originEnv),
    ownerType: normalizeOwnerType(ownerType, finalRole, { username, email }),
    allowedEnvs: serializeAllowedEnvs(
      allowedEnvs === null || allowedEnvs === undefined
        ? roleAllowedEnvs(finalRole)
        : allowedEnvs,
      finalRole
    ),
  };
}

function isPrimaryOwner(user = {}) {
  return (
    authUserRole(user || {}) === ROLES.owner &&
    normalizeOwnerType(user?.ownerType, ROLES.owner, user) ===
      OWNER_TYPES.primary
  );
}

function isSecondaryOwner(user = {}) {
  return (
    authUserRole(user || {}) === ROLES.owner &&
    normalizeOwnerType(user?.ownerType, ROLES.owner, user) ===
      OWNER_TYPES.secondary
  );
}

function canLogin(authUser = null, env = "development") {
  if (!authUser) return false;
  const role = authUserRole(authUser);
  const status = normalizeStatus(authUser.status, role, authUser.suspended);
  if (role === ROLES.disabled || status === STATUS.disabled) return false;
  return normalizeAllowedEnvs(authUser.allowedEnvs, role).includes(
    normalizeEnv(env)
  );
}

function canAccessAdmin(authUser = null) {
  const role = authUserRole(authUser || {});
  return (
    (canLogin(authUser, "production") || canLogin(authUser, "development")) &&
    [ROLES.admin, ROLES.owner].includes(role)
  );
}

function canAccessOwner(authUser = null) {
  return (
    authUserRole(authUser || {}) === ROLES.owner &&
    (canLogin(authUser, "production") || canLogin(authUser, "development"))
  );
}

function roleAtLeast(role, minimumRole) {
  return (
    ROLE_RANK[normalizeRole(role)] >= ROLE_RANK[normalizeRole(minimumRole)]
  );
}

function isActiveOwner(user = {}, env = "development") {
  return (
    authUserRole(user || {}) === ROLES.owner &&
    normalizeStatus(user?.status, user?.role, user?.suspended) !==
      STATUS.disabled &&
    normalizeAllowedEnvs(user?.allowedEnvs, user?.role).includes(
      normalizeEnv(env)
    )
  );
}

function canCreateRole(actor = {}, targetRole = ROLES.user) {
  const actorRole = authUserRole(actor);
  const role = normalizeRole(targetRole);
  if (actorRole === ROLES.owner) {
    if (role === ROLES.owner) return isPrimaryOwner(actor);
    return [ROLES.user, ROLES.developer, ROLES.admin].includes(role);
  }
  if (actorRole === ROLES.admin)
    return [ROLES.user, ROLES.developer, ROLES.admin].includes(role);
  return false;
}

function canPromoteOwner(actor = {}) {
  return isPrimaryOwner(actor);
}

function canSelfDeleteAccount(user = {}) {
  const role = authUserRole(user || {});
  if (![ROLES.user, ROLES.developer, ROLES.admin, ROLES.owner].includes(role))
    return false;
  if (isPrimaryOwner(user)) return false;
  return true;
}

function canDeleteAccount(actor = {}, target = {}) {
  const actorId = Number(actor?.authUserId || actor?.id);
  const targetId = Number(target?.authUserId || target?.id);
  if (actorId && targetId && actorId === targetId)
    return canSelfDeleteAccount(target);

  const actorRole = authUserRole(actor || {});
  const targetRole = authUserRole(target || {});
  if (actorRole !== ROLES.owner) return false;
  if (isPrimaryOwner(target)) return false;
  if (isPrimaryOwner(actor)) return targetRole !== ROLES.owner || isSecondaryOwner(target);
  if (isSecondaryOwner(actor)) return targetRole !== ROLES.owner;
  return false;
}

function canBanAccount(actor = {}, target = {}) {
  const actorId = Number(actor?.authUserId || actor?.id);
  const targetId = Number(target?.authUserId || target?.id);
  if (actorId && targetId && actorId === targetId) return false;
  if (isPrimaryOwner(target)) return false;

  const actorRole = authUserRole(actor || {});
  const targetRole = authUserRole(target || {});
  if (actorRole === ROLES.admin)
    return [ROLES.user, ROLES.developer].includes(targetRole);
  if (isPrimaryOwner(actor))
    return [ROLES.user, ROLES.developer, ROLES.admin, ROLES.owner].includes(
      targetRole
    );
  if (isSecondaryOwner(actor))
    return [ROLES.user, ROLES.developer, ROLES.admin].includes(targetRole);
  return false;
}

function canUnbanAccount(actor = {}, target = {}, options = {}) {
  const legacyRestoreRole =
    normalizeRole(target?.role) === ROLES.disabled && !target?.previousRole
      ? ROLES.user
      : target?.role;
  const restoreRole = normalizeRole(
    options.restoreRole || target?.previousRole || legacyRestoreRole
  );
  const actorRole = authUserRole(actor || {});
  const banActorRole = target?.banActorRole
    ? normalizeRole(target.banActorRole)
    : null;
  const targetWasOwner =
    normalizeRole(target?.role) === ROLES.owner ||
    normalizeRole(target?.previousRole) === ROLES.owner ||
    restoreRole === ROLES.owner;

  if (restoreRole === ROLES.owner) {
    return (
      isPrimaryOwner(actor) &&
      targetWasOwner &&
      normalizeOwnerType(
        target?.previousOwnerType || target?.ownerType,
        ROLES.owner,
        target
      ) === OWNER_TYPES.secondary
    );
  }
  if (targetWasOwner) return isPrimaryOwner(actor);

  if (banActorRole === ROLES.owner) {
    return (
      actorRole === ROLES.owner &&
      [ROLES.user, ROLES.developer, ROLES.admin].includes(restoreRole)
    );
  }

  if (actorRole === ROLES.admin)
    return [ROLES.user, ROLES.developer].includes(restoreRole);
  if (authUserRole(actor) === ROLES.owner)
    return [ROLES.user, ROLES.developer, ROLES.admin].includes(restoreRole);
  return false;
}

function assertPrimaryOwnerProtected(target = {}) {
  if (isPrimaryOwner(target)) {
    throw new Error("Primary owner cannot be deleted, disabled, or downgraded.");
  }
  return true;
}

async function assertOwnerWillRemainAfterMutation({
  authPrisma,
  targetAuthUserId = null,
  env = "development",
  deleting = false,
  nextRole = null,
  nextStatus = null,
  nextAllowedEnvs = null,
  nextSuspended = null,
} = {}) {
  if (!authPrisma) throw new Error("Auth DB client is required.");
  const owners = await authPrisma.users.findMany({
    where: { role: ROLES.owner },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      status: true,
      suspended: true,
      allowedEnvs: true,
      ownerType: true,
    },
  });
  const targetId = Number(targetAuthUserId);
  const remainingOwners = owners.filter((owner) => {
    if (Number(owner.id) !== targetId)
      return isActiveOwner(owner, env);
    if (deleting) return false;
    const resulting = {
      ...owner,
      ...(nextRole !== null && nextRole !== undefined
        ? { role: normalizeRole(nextRole) }
        : {}),
      ...(nextStatus !== null && nextStatus !== undefined
        ? { status: nextStatus }
        : {}),
      ...(nextAllowedEnvs !== null && nextAllowedEnvs !== undefined
        ? { allowedEnvs: serializeAllowedEnvs(nextAllowedEnvs, nextRole || owner.role) }
        : {}),
      ...(nextSuspended !== null && nextSuspended !== undefined
        ? { suspended: Number(Boolean(nextSuspended)) }
        : {}),
    };
    return isActiveOwner(resulting, env);
  });

  if (remainingOwners.length <= 0)
    throw new Error("At least one active owner must remain.");
  if (remainingOwners.length > MAX_ACTIVE_OWNERS)
    throw new Error(`Active owner count cannot exceed ${MAX_ACTIVE_OWNERS}.`);
  return true;
}

function assertDeleteAllowed(actor = {}, target = {}) {
  if (!canDeleteAccount(actor, target)) {
    throw new Error("You do not have permission to delete this account.");
  }
  return true;
}

function assertBanAllowed(actor = {}, target = {}) {
  if (!canBanAccount(actor, target)) {
    throw new Error("You do not have permission to disable this account.");
  }
  return true;
}

function assertUnbanAllowed(actor = {}, target = {}, options = {}) {
  if (!canUnbanAccount(actor, target, options)) {
    throw new Error("You do not have permission to restore this account.");
  }
  return true;
}

async function assertOwnerWillRemain({
  authPrisma,
  targetAuthUserId = null,
  nextRole = null,
  nextStatus = null,
  deleting = false,
} = {}) {
  if (!authPrisma) throw new Error("Auth DB client is required.");
  const currentOwners = await authPrisma.users.findMany({
    where: { role: ROLES.owner },
    select: {
      id: true,
      username: true,
      email: true,
      ownerType: true,
      status: true,
      suspended: true,
    },
  });

  const targetOwner = currentOwners.find(
    (owner) => Number(owner.id) === Number(targetAuthUserId)
  );
  const targetIsPrimary = targetOwner && isPrimaryOwner(targetOwner);
  const targetWouldLoseOwner =
    deleting ||
    (nextRole !== null &&
      nextRole !== undefined &&
      normalizeRole(nextRole) !== ROLES.owner) ||
    normalizeStatus(nextStatus, ROLES.owner, targetOwner?.suspended) ===
      STATUS.disabled;
  if (targetIsPrimary && targetWouldLoseOwner) {
    throw new Error(
      "Primary owner cannot be downgraded, disabled, or deleted."
    );
  }

  const remaining = currentOwners.filter((owner) => {
    if (Number(owner.id) !== Number(targetAuthUserId)) {
      return (
        normalizeStatus(owner.status, ROLES.owner, owner.suspended) !==
        STATUS.disabled
      );
    }
    if (deleting) return false;
    const resultingRole =
      nextRole === null || nextRole === undefined
        ? ROLES.owner
        : normalizeRole(nextRole);
    const resultingStatus = normalizeStatus(
      nextStatus || owner.status,
      resultingRole,
      owner.suspended
    );
    return resultingRole === ROLES.owner && resultingStatus !== STATUS.disabled;
  });

  if (remaining.length <= 0) {
    throw new Error("At least one active owner must remain.");
  }
  return true;
}

async function assertOwnerCap({
  authPrisma,
  targetAuthUserId = null,
  nextRole = null,
  nextStatus = null,
  deleting = false,
} = {}) {
  if (!authPrisma) throw new Error("Auth DB client is required.");
  const currentOwners = await authPrisma.users.findMany({
    where: { role: ROLES.owner },
    select: { id: true, role: true, status: true, suspended: true },
  });
  const targetId = Number(targetAuthUserId);
  const targetExists = currentOwners.some(
    (owner) => Number(owner.id) === targetId
  );
  const targetNextRole =
    nextRole === null || nextRole === undefined
      ? null
      : normalizeRole(nextRole);
  const targetNextStatus = normalizeStatus(
    nextStatus,
    targetNextRole || ROLES.owner
  );
  let activeOwners = currentOwners.filter((owner) => {
    if (Number(owner.id) !== targetId) {
      return (
        normalizeStatus(owner.status, owner.role, owner.suspended) !==
        STATUS.disabled
      );
    }
    if (deleting) return false;
    const resultingRole = targetNextRole || ROLES.owner;
    const resultingStatus = normalizeStatus(
      nextStatus || owner.status,
      resultingRole,
      owner.suspended
    );
    return resultingRole === ROLES.owner && resultingStatus !== STATUS.disabled;
  }).length;

  if (
    !targetExists &&
    !deleting &&
    targetNextRole === ROLES.owner &&
    targetNextStatus !== STATUS.disabled
  ) {
    activeOwners += 1;
  }

  if (activeOwners > MAX_ACTIVE_OWNERS) {
    throw new Error(`Active owner count cannot exceed ${MAX_ACTIVE_OWNERS}.`);
  }
  return true;
}

function assertOwnerHierarchyMutationAllowed({
  actor = {},
  target = {},
  updates = {},
  deleting = false,
} = {}) {
  const actorRole = authUserRole(actor || {});
  const targetRole = authUserRole(target || {});
  const actorPrimary = isPrimaryOwner(actor);
  const targetPrimary = isPrimaryOwner(target);
  const nextRole = Object.prototype.hasOwnProperty.call(updates, "role")
    ? normalizeRole(updates.role)
    : targetRole;
  const nextStatus = Object.prototype.hasOwnProperty.call(updates, "status")
    ? normalizeStatus(updates.status, nextRole, updates.suspended)
    : normalizeStatus(target?.status, targetRole, target?.suspended);
  const nextSuspended = Object.prototype.hasOwnProperty.call(
    updates,
    "suspended"
  )
    ? Number(Boolean(updates.suspended))
    : Number(Boolean(target?.suspended));
  const disablesTarget =
    nextRole === ROLES.disabled ||
    nextStatus === STATUS.disabled ||
    nextSuspended === 1;

  if (deleting) {
    if (targetPrimary)
      throw new Error(
        "Primary owner cannot be downgraded, disabled, or deleted."
      );
    if (targetRole === ROLES.owner && !actorPrimary)
      throw new Error("Only the primary owner can delete a secondary owner.");
    return true;
  }

  if (targetPrimary && (nextRole !== ROLES.owner || disablesTarget)) {
    throw new Error(
      "Primary owner cannot be downgraded, disabled, or deleted."
    );
  }

  if (nextRole === ROLES.owner && targetRole !== ROLES.owner && !actorPrimary) {
    throw new Error("Only the primary owner can promote an account to owner.");
  }

  if (
    nextRole === ROLES.owner &&
    targetRole !== ROLES.owner &&
    targetRole !== ROLES.admin
  ) {
    throw new Error("Only admin accounts can be promoted to secondary owner.");
  }

  if (
    targetRole === ROLES.owner &&
    !actorPrimary &&
    actorRole === ROLES.owner
  ) {
    throw new Error("Secondary owners cannot modify owner accounts.");
  }

  if (targetRole === ROLES.owner && actorRole !== ROLES.owner) {
    throw new Error("Only owners can modify owner accounts.");
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "ownerType") &&
    updates.ownerType === OWNER_TYPES.primary &&
    !isPrimaryOwnerIdentity(target)
  ) {
    throw new Error("Primary owner cannot be transferred.");
  }

  return true;
}

function capabilitiesFor(user = {}) {
  const role = authUserRole(user);
  return {
    workspace: [ROLES.user, ROLES.developer, ROLES.admin, ROLES.owner].includes(
      role
    ),
    experiment: [ROLES.developer, ROLES.admin, ROLES.owner].includes(role),
    admin: [ROLES.admin, ROLES.owner].includes(role),
    owner: role === ROLES.owner,
  };
}

module.exports = {
  LOGIN_DISABLED_ERROR,
  LOGIN_GENERIC_ERROR,
  MAX_ACTIVE_OWNERS,
  OWNER_TYPES,
  PRIMARY_OWNER,
  ROLE_RANK,
  ROLES,
  STATUS,
  VALID_ENVS,
  VALID_ROLES,
  assertOwnerWillRemain,
  assertOwnerWillRemainAfterMutation,
  assertOwnerCap,
  assertOwnerHierarchyMutationAllowed,
  assertPrimaryOwnerProtected,
  assertDeleteAllowed,
  assertBanAllowed,
  assertUnbanAllowed,
  assertValidRole,
  authUserRole,
  canAccessAdmin,
  canAccessOwner,
  canBanAccount,
  canCreateRole,
  canDeleteAccount,
  canPromoteOwner,
  canSelfDeleteAccount,
  canUnbanAccount,
  canLogin,
  capabilitiesFor,
  deriveRoleDefaults,
  isPrimaryOwner,
  isPrimaryOwnerIdentity,
  isSecondaryOwner,
  isActiveOwner,
  normalizeAllowedEnvs,
  normalizeEnv,
  normalizeOwnerType,
  normalizeRole,
  normalizeStatus,
  roleAllowedEnvs,
  roleAtLeast,
  roleOriginEnv,
  serializeAllowedEnvs,
};
