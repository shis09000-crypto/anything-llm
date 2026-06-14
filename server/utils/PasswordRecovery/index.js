const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { v4, validate } = require("uuid");
const { User } = require("../../models/user");
const { AuthIdentity } = require("../../models/authIdentity");
const { EventLogs } = require("../../models/eventLogs");
const {
  RecoveryCode,
  PasswordResetToken,
} = require("../../models/passwordRecovery");
const { EmailVerificationCode } = require("../../models/emailVerification");
const {
  isConfigured: emailSmtpConfigured,
  maskedEmail,
  sendSecurityNotification,
  sendVerificationCode,
} = require("../email/mailer");

const EMAIL_PURPOSES = {
  bindEmail: "bind_email",
  passwordReset: "password_reset",
};
const EMAIL_RECOVERY_GENERIC_RESPONSE =
  "If the account and verified email exist, a verification code has been sent.";
const EMAIL_RESEND_COOLDOWN_SECONDS = Math.ceil(
  EmailVerificationCode.resendCooldownMs / 1000
);
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const IP_HOURLY_LIMIT = Number(
  process.env.EMAIL_VERIFICATION_IP_HOURLY_LIMIT || 20
);
const USERNAME_HOURLY_LIMIT = Number(
  process.env.EMAIL_VERIFICATION_USERNAME_HOURLY_LIMIT || 5
);
const rateBuckets = new Map();

const EMAIL_VERIFICATION_ERRORS = {
  notFound: {
    error: "Verification code not found. Please request a new code.",
    errorCode: "verification_code_not_found",
  },
  invalidFormat: {
    error: "Enter the 6-digit verification code.",
    errorCode: "verification_code_invalid_format",
  },
  expired: {
    error: "Verification code expired. Please request a new code.",
    errorCode: "verification_code_expired",
  },
  consumed: {
    error: "Verification code already used. Please request a new code.",
    errorCode: "verification_code_consumed",
  },
  attemptsExceeded: {
    error: "Too many failed attempts. Please request a new code.",
    errorCode: "verification_code_attempts_exceeded",
  },
  mismatch: {
    error: "Invalid verification code.",
    errorCode: "verification_code_mismatch",
  },
  resendCooldown: {
    error: "Please wait before requesting another verification code.",
    errorCode: "verification_resend_cooldown",
  },
};

function normalizeEmail(email = "") {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function validEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
}

function sixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function requestIp(requestIp = "") {
  return String(requestIp || "unknown").slice(0, 128);
}

function rateLimited(key, limit) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (bucket.count >= limit) return true;
  bucket.count += 1;
  return false;
}

function verificationRateLimited({ ip, username }) {
  const normalizedIp = requestIp(ip);
  const normalizedUsername = String(username || "")
    .trim()
    .toLowerCase();
  const ipLimited = rateLimited(`ip:${normalizedIp}`, IP_HOURLY_LIMIT);
  const usernameLimited = normalizedUsername
    ? rateLimited(`username:${normalizedUsername}`, USERNAME_HOURLY_LIMIT)
    : false;
  return ipLimited || usernameLimited;
}

function codeIsSixDigits(code = "") {
  return /^\d{6}$/.test(String(code || ""));
}

function resendCooldownSecondsRemaining(latest) {
  const elapsedMs = Date.now() - new Date(latest?.createdAt || 0).getTime();
  const remainingMs = EmailVerificationCode.resendCooldownMs - elapsedMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

async function logEmailEvent(
  event,
  { user = null, email = "", purpose, ip, result = null }
) {
  await EventLogs.logEvent(
    event,
    {
      username: user?.username || null,
      email: maskedEmail(email),
      purpose,
      ip: requestIp(ip),
      ...(result ? { result } : {}),
    },
    user?.id || null
  );
}

async function sendSecurityNotice(user, subject, text) {
  if (!user?.email || !user?.email_verified_at || !emailSmtpConfigured())
    return false;

  try {
    await sendSecurityNotification({ to: user.email, subject, text });
    await logEmailEvent("security_notification_sent", {
      user,
      email: user.email,
      purpose: "security_notification",
      result: "sent",
    });
    return true;
  } catch (error) {
    await logEmailEvent("security_notification_failed", {
      user,
      email: user.email,
      purpose: "security_notification",
      result: error.message,
    });
    return false;
  }
}

async function sendAndStoreVerification({
  user,
  email,
  purpose,
  ip,
  language = "",
}) {
  const authUserId = await authUserIdForUser(user);
  const code = sixDigitCode();
  await EmailVerificationCode.expireOpenCodes({ userId: authUserId, purpose });
  const { verification, error } = await EmailVerificationCode.create({
    userId: authUserId,
    email,
    purpose,
    code,
    requestIp: requestIp(ip),
  });
  if (error) return { success: false, error };

  try {
    await sendVerificationCode({
      to: email,
      code,
      purpose,
      language,
    });
    await logEmailEvent("email_verification_sent", {
      user,
      email,
      purpose,
      ip,
      result: "sent",
    });
    return { success: true, verification, error: null };
  } catch (error) {
    await EmailVerificationCode.consume(verification.id);
    await logEmailEvent("email_verification_send_failed", {
      user,
      email,
      purpose,
      ip,
      result: error.message,
    });
    return { success: false, error: error.message };
  }
}

async function verifyEmailCode({ user, email, purpose, code, ip }) {
  const authUserId = await authUserIdForUser(user);
  if (!codeIsSixDigits(code))
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.invalidFormat };

  const verification = await EmailVerificationCode.latest({
    userId: authUserId,
    email,
    purpose,
  });
  if (!verification)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.notFound };
  if (verification.consumedAt)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.consumed };
  if (verification.expiresAt < new Date())
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.expired };
  if (verification.attempts >= EmailVerificationCode.maxAttempts)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.attemptsExceeded };

  const validCode = bcrypt.compareSync(String(code), verification.code_hash);
  if (!validCode) {
    await EmailVerificationCode.incrementAttempts(verification.id);
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.mismatch };
  }

  const consumed = await EmailVerificationCode.consume(verification.id);
  if (!consumed)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.consumed };

  await logEmailEvent("email_verification_succeeded", {
    user,
    email,
    purpose,
    ip,
    result: "verified",
  });
  return { success: true, verification };
}

async function generateRecoveryCodes(userId) {
  const user = await User._get({ id: Number(userId) });
  const authUserId = await authUserIdForUser(user);
  if (!authUserId) throw new Error("Failed to resolve auth user.");
  const newRecoveryCodes = [];
  const plainTextCodes = [];
  for (let i = 0; i < 4; i++) {
    const code = v4();
    const hashedCode = bcrypt.hashSync(code, 10);
    newRecoveryCodes.push({
      user_id: authUserId,
      code_hash: hashedCode,
    });
    plainTextCodes.push(code);
  }

  const { error } = await RecoveryCode.createMany(newRecoveryCodes);
  if (!!error) throw new Error(error);

  const { user: success } = await User._update(userId, {
    seen_recovery_codes: true,
  });
  if (!success) throw new Error("Failed to generate user recovery codes!");

  return plainTextCodes;
}

async function recoverAccount(username = "", recoveryCodes = []) {
  const identity = await resolveAuthAndShadowByUsername(String(username));
  if (!identity || !identity.canLogin)
    return { success: false, error: "Invalid recovery codes." };
  const recoveryUserId = identity.authUserId;

  // If hashes do not exist for a user
  // because this is a user who has not logged out and back in since upgrade.
  const allUserHashes = await RecoveryCode.hashesForUser(recoveryUserId);
  if (allUserHashes.length < 4)
    return { success: false, error: "Invalid recovery codes." };

  // If they tried to send more than two unique codes, we only take the first two
  const uniqueRecoveryCodes = [...new Set(recoveryCodes)]
    .map((code) => code.trim())
    .filter((code) => validate(code)) // we know that any provided code must be a uuid v4.
    .slice(0, 2);
  if (uniqueRecoveryCodes.length !== 2)
    return { success: false, error: "Invalid recovery codes." };

  const validCodes = uniqueRecoveryCodes.every((code) => {
    let valid = false;
    allUserHashes.forEach((hash) => {
      if (bcrypt.compareSync(code, hash)) valid = true;
    });
    return valid;
  });
  if (!validCodes) return { success: false, error: "Invalid recovery codes." };

  const { passwordResetToken, error } = await PasswordResetToken.create(
    recoveryUserId
  );
  if (!!error) return { success: false, error };
  return { success: true, resetToken: passwordResetToken.token };
}

async function emailStatus(userId = null) {
  const user = await User._get({ id: Number(userId) });
  if (!user) return { success: false, error: "User not found." };

  const pending = await EmailVerificationCode.latestPendingForUser({
    userId: await authUserIdForUser(user),
    purpose: EMAIL_PURPOSES.bindEmail,
  });
  return {
    success: true,
    email: user.email || "",
    verified: Boolean(user.email && user.email_verified_at),
    verifiedAt: user.email_verified_at || null,
    pendingEmail: pending && pending.email !== user.email ? pending.email : "",
  };
}

async function requestAuthenticatedEmailVerification({
  userId,
  email = "",
  ip = "",
  language = "",
}) {
  const user = await User._get({ id: Number(userId) });
  const normalizedEmail = normalizeEmail(email);
  if (!user) return { success: false, error: "User not found." };
  if (!validEmail(normalizedEmail))
    return { success: false, error: "Invalid email address." };
  if (verificationRateLimited({ ip, username: user.username }))
    return {
      success: false,
      error: "Too many verification requests. Try again later.",
    };
  if (!emailSmtpConfigured())
    return { success: false, error: "email_smtp_not_configured" };

  const authUserId = await authUserIdForUser(user);
  const existing = await safeFindAuthIdentity(normalizedEmail);
  if (existing && existing.id !== authUserId)
    return { success: false, error: "Email is already bound to another user." };
  if (existing && existing.id === authUserId && existing.email_verified_at)
    return { success: false, error: "Email is already verified." };

  const latest = await EmailVerificationCode.latest({
    userId: authUserId,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.bindEmail,
  });
  if (
    latest &&
    !latest.consumedAt &&
    Date.now() - new Date(latest.createdAt).getTime() <
      EmailVerificationCode.resendCooldownMs
  ) {
    return {
      success: false,
      ...EMAIL_VERIFICATION_ERRORS.resendCooldown,
      resendCooldownSeconds: resendCooldownSecondsRemaining(latest),
    };
  }

  const result = await sendAndStoreVerification({
    user,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.bindEmail,
    ip,
    language,
  });
  if (!result.success) return result;
  return {
    success: true,
    pendingEmail: normalizedEmail,
    resendCooldownSeconds: EMAIL_RESEND_COOLDOWN_SECONDS,
  };
}

async function confirmAuthenticatedEmailVerification({
  userId,
  email = "",
  code = "",
  ip = "",
}) {
  const user = await User._get({ id: Number(userId) });
  const normalizedEmail = normalizeEmail(email);
  if (!user) return { success: false, error: "User not found." };
  if (!validEmail(normalizedEmail))
    return { success: false, error: "Invalid email address." };

  const authUserId = await authUserIdForUser(user);
  const existing = await safeFindAuthIdentity(normalizedEmail);
  if (existing && existing.id !== authUserId)
    return { success: false, error: "Email is already bound to another user." };

  const verified = await verifyEmailCode({
    user,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.bindEmail,
    code,
    ip,
  });
  if (!verified.success) return verified;

  const wasVerified = Boolean(user.email && user.email_verified_at);
  const wasChange = wasVerified && user.email !== normalizedEmail;
  const { user: updatedUser, message } = await User._update(user.id, {
    email: normalizedEmail,
    email_verified_at: new Date(),
  });
  if (!updatedUser) return { success: false, error: message };

  await logEmailEvent(wasChange ? "user_email_changed" : "user_email_bound", {
    user: updatedUser,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.bindEmail,
    ip,
    result: "success",
  });
  await sendSecurityNotice(
    updatedUser,
    "Athena 安全通知：邮箱已更新",
    `你的 Athena 账号邮箱已${wasChange ? "更换" : "绑定"}为 ${maskedEmail(
      normalizedEmail
    )}。如果这不是你本人操作，请立即修改密码。`
  );

  return {
    success: true,
    email: updatedUser.email,
    verified: true,
    verifiedAt: updatedUser.email_verified_at,
  };
}

async function requestEmailPasswordReset({
  username = "",
  email = "",
  ip = "",
  language = "",
}) {
  const normalizedUsername = String(username || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const generic = {
    success: true,
    message: EMAIL_RECOVERY_GENERIC_RESPONSE,
    resendCooldownSeconds: EMAIL_RESEND_COOLDOWN_SECONDS,
  };

  if (
    verificationRateLimited({
      ip,
      username: normalizedUsername,
    })
  )
    return generic;
  if (!validEmail(normalizedEmail) || !normalizedUsername) return generic;

  const identity = await resolveAuthAndShadowByUsername(normalizedUsername);
  if (
    !identity ||
    !identity.canLogin ||
    identity.user.email !== normalizedEmail ||
    !identity.user.email_verified_at ||
    !emailSmtpConfigured()
  )
    return generic;
  const user = identity.user;

  const latest = await EmailVerificationCode.latest({
    userId: identity.authUserId,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.passwordReset,
  });
  if (
    latest &&
    !latest.consumedAt &&
    Date.now() - new Date(latest.createdAt).getTime() <
      EmailVerificationCode.resendCooldownMs
  )
    return generic;

  await sendAndStoreVerification({
    user,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.passwordReset,
    ip,
    language,
  });
  return generic;
}

async function confirmEmailPasswordReset({
  username = "",
  email = "",
  code = "",
  ip = "",
}) {
  const normalizedUsername = String(username || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const identity = await resolveAuthAndShadowByUsername(normalizedUsername);
  if (
    !identity ||
    !identity.canLogin ||
    identity.user.email !== normalizedEmail ||
    !identity.user.email_verified_at
  )
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.mismatch };
  const user = identity.user;

  const verified = await verifyEmailCode({
    user,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.passwordReset,
    code,
    ip,
  });
  if (!verified.success) return verified;

  const { passwordResetToken, error } = await PasswordResetToken.create(
    identity.authUserId
  );
  if (error) return { success: false, error };
  return { success: true, resetToken: passwordResetToken.token };
}

async function resetPassword(token, _newPassword = "", confirmPassword = "") {
  const newPassword = String(_newPassword).trim(); // No spaces in passwords
  if (!newPassword) throw new Error("Invalid password.");
  if (newPassword !== String(confirmPassword))
    throw new Error("Passwords do not match");

  const resetToken = await PasswordResetToken.findUnique({
    token: String(token),
  });
  if (!resetToken || resetToken.expiresAt < new Date()) {
    return { success: false, message: "Invalid reset token" };
  }

  // JOI password rules will be enforced inside .update.
  const authUser = await AuthIdentity.findById(resetToken.user_id);
  if (!authUser || !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    return { success: false, message: "Invalid reset token" };
  }
  const user = await AuthIdentity.ensureShadowUser(authUser);
  if (!user) return { success: false, message: "Invalid reset token" };

  const { error } = await User.update(user.id, {
    password: newPassword,
  });

  // seen_recovery_codes is not publicly writable
  // so we have to do direct update here
  await User._update(user.id, {
    seen_recovery_codes: false,
  });

  if (error) return { success: false, message: error };
  await PasswordResetToken.deleteMany({ user_id: resetToken.user_id });
  await RecoveryCode.deleteMany({ user_id: resetToken.user_id });
  const updatedUser = await User._get({ id: user.id });
  await EventLogs.logEvent(
    "password_reset_succeeded",
    {
      username: updatedUser?.username || null,
      email: maskedEmail(updatedUser?.email || ""),
    },
    user.id
  );
  await sendSecurityNotice(
    updatedUser,
    "Athena 安全通知：密码已重置",
    "你的 Athena 账号密码刚刚被重置。如果这不是你本人操作，请立即联系管理员。"
  );

  // New codes are provided on first new login.
  return { success: true, message: "Password reset successful" };
}

async function authUserIdForUser(user = null) {
  if (!user) return null;
  if (user.authUserId) return Number(user.authUserId);
  const shadow = user.id ? await User._get({ id: Number(user.id) }) : null;
  if (shadow?.authUserId) return Number(shadow.authUserId);
  const authUser = await safeBootstrapAuthUserFromShadow(shadow || user);
  return authUser?.id || (user.id ? Number(user.id) : null);
}

async function resolveAuthAndShadowByUsername(username = "") {
  const authUser = await safeFindAuthIdentity(username);
  if (authUser) {
    const user = await AuthIdentity.ensureShadowUser(authUser);
    return {
      authUser,
      user,
      authUserId: authUser.id,
      canLogin: await AuthIdentity.canLoginInCurrentEnvAsync(authUser),
    };
  }

  const user = await User._get({ username });
  if (!user) return null;
  return {
    authUser: null,
    user,
    authUserId: await authUserIdForUser(user),
    canLogin: !user.suspended,
  };
}

async function safeFindAuthIdentity(identifier = "") {
  try {
    return await AuthIdentity.findByLoginIdentifier(identifier);
  } catch (error) {
    return null;
  }
}

async function safeBootstrapAuthUserFromShadow(user = null) {
  try {
    return await AuthIdentity.bootstrapAuthUserFromShadow(user);
  } catch (error) {
    return null;
  }
}

module.exports = {
  EMAIL_PURPOSES,
  EMAIL_RECOVERY_GENERIC_RESPONSE,
  confirmAuthenticatedEmailVerification,
  confirmEmailPasswordReset,
  emailStatus,
  recoverAccount,
  requestAuthenticatedEmailVerification,
  requestEmailPasswordReset,
  resetPassword,
  generateRecoveryCodes,
  _private: {
    normalizeEmail,
    validEmail,
    verificationRateLimited,
    rateBuckets,
  },
};
