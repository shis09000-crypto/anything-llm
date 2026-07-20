const PROFILE_FIELDS = new Set([
  "username",
  "displayName",
  "pfpFilename",
  "email",
  "email_verified_at",
  "phone",
  "phone_verified_at",
  "bio",
]);

const SECURITY_POLICY_FIELDS = new Set([
  "password",
  "role",
  "status",
  "allowedEnvs",
  "ownerType",
  "suspended",
  "bannedAt",
]);

const ENTITLEMENT_FIELDS = new Set([
  "dailyMessageLimit",
  "role",
  "status",
  "suspended",
]);

const NOTIFICATION_FIELDS = new Set(["web_push_subscription_config"]);

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasAnyField(fields = [], candidates = new Set()) {
  return fields.some((field) => candidates.has(field));
}

function userProfileProjection(user = {}) {
  if (!user?.id) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    pfpFilename: user.pfpFilename,
    email: user.email,
    email_verified_at: user.email_verified_at,
    phone: user.phone,
    phone_verified_at: user.phone_verified_at,
    bio: user.bio,
  };
}

function userSecurityPolicyProjection(user = {}) {
  if (!user?.id) return null;
  return {
    id: user.id,
    role: user.role,
    status: user.status,
    allowedEnvs: parseJsonArray(user.allowedEnvs),
    ownerType: user.ownerType,
    suspended: Boolean(user.suspended),
    bannedAt: user.bannedAt || null,
    passwordConfigured: Boolean(user.password),
  };
}

function userEntitlementProjection(user = {}) {
  if (!user?.id) return null;
  const role = String(user.role || "").toLowerCase();
  const active = user.status !== "disabled" && !Boolean(user.suspended);
  return {
    id: user.id,
    dailyMessageLimit: user.dailyMessageLimit ?? null,
    unlimitedMessages: active && ["admin", "owner"].includes(role),
    active,
  };
}

function userNotificationProjection(user = {}) {
  if (!user?.id) return null;
  return {
    id: user.id,
    webPushConfigured: Boolean(user.web_push_subscription_config),
  };
}

module.exports = {
  ENTITLEMENT_FIELDS,
  NOTIFICATION_FIELDS,
  PROFILE_FIELDS,
  SECURITY_POLICY_FIELDS,
  hasAnyField,
  userEntitlementProjection,
  userNotificationProjection,
  userProfileProjection,
  userSecurityPolicyProjection,
};
