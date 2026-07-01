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
const {
  EmailVerificationCode,
  EmailVerificationGrant,
  EmailVerificationRateLimit,
} = require("../../models/emailVerification");
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
const EMAIL_HOURLY_LIMIT = Number(
  process.env.EMAIL_VERIFICATION_EMAIL_HOURLY_LIMIT || 5
);
const DEVICE_HOURLY_LIMIT = Number(
  process.env.EMAIL_VERIFICATION_DEVICE_HOURLY_LIMIT || 10
);
const PASSWORD_RESET_GRANT_SCOPE = "password_reset";
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

function fakeChallengeId() {
  return crypto.randomUUID();
}

function requestIp(requestIp = "") {
  return String(requestIp || "unknown").slice(0, 128);
}

function emailSecurityContext({ ip, clientContext = null } = {}) {
  const platform = clientContext?.platform || "";
  const device =
    clientContext?.surface ||
    clientContext?.layoutMode ||
    (platform ? `${platform} client` : "");
  return {
    device,
    platform,
    ip: requestIp(ip),
    time: new Date().toISOString(),
    requestId: clientContext?.requestId || "",
  };
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

async function durableRateLimited({
  bucketType,
  purpose,
  value,
  limit,
  fallbackKey,
}) {
  if (!value) return false;
  try {
    return await EmailVerificationRateLimit.hit({
      bucketType,
      purpose,
      value,
      limit,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
  } catch (error) {
    console.warn(
      "EMAIL VERIFICATION RATE LIMIT FALLING BACK TO MEMORY.",
      error?.code || error?.name || "UnknownRateLimitError"
    );
    return rateLimited(fallbackKey, limit);
  }
}

async function verificationRateLimited({
  ip,
  username,
  email = "",
  clientId = "",
  purpose = "email_verification",
}) {
  const normalizedIp = requestIp(ip);
  const normalizedUsername = String(username || "")
    .trim()
    .toLowerCase();
  const normalizedEmail = normalizeEmail(email);
  const normalizedClientId = String(clientId || "").trim();
  const ipLimited = await durableRateLimited({
    bucketType: "ip",
    purpose,
    value: normalizedIp,
    limit: IP_HOURLY_LIMIT,
    fallbackKey: `ip:${normalizedIp}`,
  });
  const usernameLimited = await durableRateLimited({
    bucketType: "username",
    purpose,
    value: normalizedUsername,
    limit: USERNAME_HOURLY_LIMIT,
    fallbackKey: `username:${normalizedUsername}`,
  });
  const emailLimited = await durableRateLimited({
    bucketType: "email",
    purpose,
    value: normalizedEmail,
    limit: EMAIL_HOURLY_LIMIT,
    fallbackKey: `email:${normalizedEmail}`,
  });
  const deviceLimited = await durableRateLimited({
    bucketType: "device",
    purpose,
    value:
      normalizedClientId && normalizedClientId !== "legacy"
        ? normalizedClientId
        : "",
    limit: DEVICE_HOURLY_LIMIT,
    fallbackKey: `device:${normalizedClientId}`,
  });
  return ipLimited || usernameLimited || emailLimited || deviceLimited;
}

function codeIsSixDigits(code = "") {
  return /^\d{6}$/.test(String(code || ""));
}

function resendCooldownSecondsRemaining(latest) {
  const elapsedMs = Date.now() - new Date(latest?.createdAt || 0).getTime();
  const remainingMs = EmailVerificationCode.resendCooldownMs - elapsedMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function verificationClientMatches(verification = null, clientContext = null) {
  if (!verification?.client_id) return true;
  const clientId = String(clientContext?.clientId || "").trim();
  if (!clientId || clientId === "legacy") return true;
  return verification.client_id === clientId;
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
  clientContext = null,
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
    clientId:
      clientContext?.clientId && clientContext.clientId !== "legacy"
        ? clientContext.clientId
        : null,
    deviceId:
      clientContext?.clientId && clientContext.clientId !== "legacy"
        ? clientContext.clientId
        : null,
  });
  if (error) return { success: false, error };

  try {
    await sendVerificationCode({
      to: email,
      code,
      purpose,
      language,
      securityContext: emailSecurityContext({ ip, clientContext }),
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

async function verifyEmailCode({
  user,
  email,
  purpose,
  code,
  ip,
  challengeId = null,
  clientContext = null,
}) {
  const authUserId = await authUserIdForUser(user);
  if (!codeIsSixDigits(code))
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.invalidFormat };

  const verification = challengeId
    ? await EmailVerificationCode.findByChallenge({
        challengeId,
        userId: authUserId,
        email,
        purpose,
      })
    : await EmailVerificationCode.latest({
        userId: authUserId,
        email,
        purpose,
      });
  if (!verification)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.notFound };
  if (!verificationClientMatches(verification, clientContext))
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.notFound };
  if (verification.consumedAt)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.consumed };
  if (verification.expiresAt < new Date())
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.expired };
  if (verification.attempts >= EmailVerificationCode.maxAttempts)
    return { success: false, ...EMAIL_VERIFICATION_ERRORS.attemptsExceeded };

  const validCode = EmailVerificationCode.verifyCode(
    String(code),
    verification.code_hash
  );
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

  const { grant, error } = await EmailVerificationGrant.create({
    userId: recoveryUserId,
    purpose: "recovery_code_reset",
    scope: PASSWORD_RESET_GRANT_SCOPE,
    email: identity.user?.email || "",
  });
  if (!!error) return { success: false, error };
  return { success: true, resetToken: grant.token };
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
    pendingChallengeId: pending?.challenge_id || null,
  };
}

async function requestAuthenticatedEmailVerification({
  userId,
  email = "",
  ip = "",
  language = "",
  clientContext = null,
}) {
  const user = await User._get({ id: Number(userId) });
  const normalizedEmail = normalizeEmail(email);
  if (!user) return { success: false, error: "User not found." };
  if (!validEmail(normalizedEmail))
    return { success: false, error: "Invalid email address." };
  if (
    await verificationRateLimited({
      ip,
      username: user.username,
      email: normalizedEmail,
      clientId: clientContext?.clientId,
      purpose: EMAIL_PURPOSES.bindEmail,
    })
  )
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
      challengeId: latest.challenge_id || null,
    };
  }

  const result = await sendAndStoreVerification({
    user,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.bindEmail,
    ip,
    language,
    clientContext,
  });
  if (!result.success) return result;
  return {
    success: true,
    pendingEmail: normalizedEmail,
    challengeId: result.verification?.challenge_id || null,
    resendCooldownSeconds: EMAIL_RESEND_COOLDOWN_SECONDS,
  };
}

async function confirmAuthenticatedEmailVerification({
  userId,
  email = "",
  code = "",
  ip = "",
  challengeId = null,
  clientContext = null,
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
    challengeId,
    clientContext,
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
  clientContext = null,
}) {
  const normalizedUsername = String(username || "").trim();
  const normalizedEmail = normalizeEmail(email);
  const generic = {
    success: true,
    message: EMAIL_RECOVERY_GENERIC_RESPONSE,
    resendCooldownSeconds: EMAIL_RESEND_COOLDOWN_SECONDS,
    challengeId: fakeChallengeId(),
  };

  if (
    await verificationRateLimited({
      ip,
      username: normalizedUsername,
      email: normalizedEmail,
      clientId: clientContext?.clientId,
      purpose: EMAIL_PURPOSES.passwordReset,
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
    return {
      ...generic,
      challengeId: latest.challenge_id || generic.challengeId,
    };

  const result = await sendAndStoreVerification({
    user,
    email: normalizedEmail,
    purpose: EMAIL_PURPOSES.passwordReset,
    ip,
    language,
    clientContext,
  });
  return {
    ...generic,
    challengeId: result?.verification?.challenge_id || generic.challengeId,
  };
}

async function confirmEmailPasswordReset({
  username = "",
  email = "",
  code = "",
  ip = "",
  challengeId = null,
  clientContext = null,
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
    challengeId,
    clientContext,
  });
  if (!verified.success) return verified;

  const { grant, error } = await EmailVerificationGrant.create({
    userId: identity.authUserId,
    purpose: EMAIL_PURPOSES.passwordReset,
    scope: PASSWORD_RESET_GRANT_SCOPE,
    email: normalizedEmail,
    challengeId: verified.verification?.challenge_id || null,
    clientId: verified.verification?.client_id || null,
    deviceId: verified.verification?.device_id || null,
    sessionId: verified.verification?.session_id || null,
  });
  if (error) return { success: false, error };
  return { success: true, resetToken: grant.token };
}

async function resetPassword(token, _newPassword = "", confirmPassword = "") {
  const newPassword = String(_newPassword).trim(); // No spaces in passwords
  if (!newPassword) throw new Error("Invalid password.");
  if (newPassword !== String(confirmPassword))
    throw new Error("Passwords do not match");

  const resetGrant = await EmailVerificationGrant.findValid({
    token: String(token),
    scope: PASSWORD_RESET_GRANT_SCOPE,
  });
  const resetToken = resetGrant
    ? null
    : await PasswordResetToken.findUnique({
        token: String(token),
      });
  const resetUserId = resetGrant?.user_id || resetToken?.user_id;
  if (!resetUserId || (resetToken && resetToken.expiresAt < new Date())) {
    return { success: false, message: "Invalid reset token" };
  }

  // JOI password rules will be enforced inside .update.
  const authUser = await AuthIdentity.findById(resetUserId);
  if (!authUser || !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    return { success: false, message: "Invalid reset token" };
  }
  const user = await AuthIdentity.ensureShadowUser(authUser);
  if (!user) return { success: false, message: "Invalid reset token" };

  if (resetGrant) {
    const consumed = await EmailVerificationGrant.consume(resetGrant.id);
    if (!consumed) return { success: false, message: "Invalid reset token" };
  }

  const { error } = await User.update(user.id, {
    password: newPassword,
  });

  // seen_recovery_codes is not publicly writable
  // so we have to do direct update here
  await User._update(user.id, {
    seen_recovery_codes: false,
  });

  if (error) return { success: false, message: error };
  await EmailVerificationGrant.consumeMany({
    userId: resetUserId,
    scope: PASSWORD_RESET_GRANT_SCOPE,
  });
  await PasswordResetToken.deleteMany({ user_id: resetUserId });
  await RecoveryCode.deleteMany({ user_id: resetUserId });
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
  } catch {
    return null;
  }
}

async function safeBootstrapAuthUserFromShadow(user = null) {
  try {
    return await AuthIdentity.bootstrapAuthUserFromShadow(user);
  } catch {
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
    fakeChallengeId,
    verificationClientMatches,
  },
};
