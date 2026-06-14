export const ACCOUNT_ROLES = Object.freeze({
  disabled: "disabled",
  user: "user",
  developer: "developer",
  admin: "admin",
  owner: "owner",
});

export const OWNER_TYPES = Object.freeze({
  primary: "primary",
  secondary: "secondary",
});

export const PRIMARY_OWNER = Object.freeze({
  username: "shis500225",
  email: "shis500225@gmail.com",
});

export function normalizeRole(role = ACCOUNT_ROLES.user) {
  const value = String(role || ACCOUNT_ROLES.user)
    .trim()
    .toLowerCase();
  if (value === "default") return ACCOUNT_ROLES.user;
  if (value === "manager") return ACCOUNT_ROLES.admin;
  if (Object.values(ACCOUNT_ROLES).includes(value)) return value;
  return ACCOUNT_ROLES.user;
}

export function roleMatches(user, roles = []) {
  const role = normalizeRole(user?.role);
  const allowed = roles.map(normalizeRole);
  if (allowed.includes(role)) return true;
  return role === ACCOUNT_ROLES.owner && allowed.includes(ACCOUNT_ROLES.admin);
}

export function canSeeWorkspace(user) {
  return roleMatches(user, [
    ACCOUNT_ROLES.user,
    ACCOUNT_ROLES.developer,
    ACCOUNT_ROLES.admin,
    ACCOUNT_ROLES.owner,
  ]);
}

export function canSeeExperiment(user) {
  return roleMatches(user, [
    ACCOUNT_ROLES.developer,
    ACCOUNT_ROLES.admin,
    ACCOUNT_ROLES.owner,
  ]);
}

export function canSeeAdmin(user) {
  return roleMatches(user, [ACCOUNT_ROLES.admin, ACCOUNT_ROLES.owner]);
}

export function canSeeOwnerSecurity(user) {
  return normalizeRole(user?.role) === ACCOUNT_ROLES.owner;
}

export function isPrimaryOwner(user) {
  if (normalizeRole(user?.role) !== ACCOUNT_ROLES.owner) return false;
  const username = String(user?.username || "")
    .trim()
    .toLowerCase();
  const email = String(user?.email || "")
    .trim()
    .toLowerCase();
  return (
    user?.ownerType === OWNER_TYPES.primary ||
    username === PRIMARY_OWNER.username ||
    email === PRIMARY_OWNER.email
  );
}

export function isSecondaryOwner(user) {
  return (
    normalizeRole(user?.role) === ACCOUNT_ROLES.owner && !isPrimaryOwner(user)
  );
}

export function canPromoteOwner(user) {
  return isPrimaryOwner(user);
}

export function roleLabel(role) {
  switch (normalizeRole(role)) {
    case ACCOUNT_ROLES.disabled:
      return "已禁用";
    case ACCOUNT_ROLES.developer:
      return "开发者";
    case ACCOUNT_ROLES.admin:
      return "管理员";
    case ACCOUNT_ROLES.owner:
      return "所有者";
    case ACCOUNT_ROLES.user:
    default:
      return "成员";
  }
}

export function accountRoleLabel(user = {}) {
  if (isPrimaryOwner(user)) return "主 Owner";
  if (isSecondaryOwner(user)) return "次 Owner";
  return roleLabel(user?.role);
}
