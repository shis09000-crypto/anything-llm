const crypto = require("crypto");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const {
  EmailVerificationCode,
  EmailVerificationRateLimit,
} = require("../models/emailVerification");
const { Invite } = require("../models/invite");
const { User } = require("../models/user");
const { AuthIdentity } = require("../models/authIdentity");
const { reqBody } = require("../utils/http");
const { generateRecoveryCodes } = require("../utils/PasswordRecovery");
const {
  issueUserSessionToken,
  sessionTokenOptionsFromClientContext,
} = require("../utils/sessionIdle");
const { getClientContext } = require("../utils/clientIdentity");
const { ROLES, LOGIN_GENERIC_ERROR } = require("../utils/authz/accountRoles");
const {
  isConfigured: emailSmtpConfigured,
  maskedEmail,
  sendVerificationCode,
} = require("../utils/email/mailer");
const {
  simpleSSOLoginDisabledMiddleware,
} = require("../utils/middleware/simpleSSOEnabled");

const INVITE_REGISTER_PURPOSE = "register";
const INVITE_RATE_LIMIT_PURPOSE = "invite_register";
const INVITE_GENERIC_ERROR = "无法完成邀请注册，请检查信息后重试。";
const INVITE_CODE_SENT = "如果该邀请和邮箱可以注册，验证码已发送，请检查邮箱。";
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const IP_HOURLY_LIMIT = Number(
  process.env.INVITE_REGISTER_IP_HOURLY_LIMIT || 20
);
const EMAIL_HOURLY_LIMIT = Number(
  process.env.INVITE_REGISTER_EMAIL_HOURLY_LIMIT || 5
);
const USERNAME_HOURLY_LIMIT = Number(
  process.env.INVITE_REGISTER_USERNAME_HOURLY_LIMIT || 10
);
const inviteRateBuckets = new Map();

function normalizeEmail(email = "") {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function validEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
}

function requestLanguage(request = {}) {
  const header = String(request?.headers?.["accept-language"] || "en");
  const primary = header.split(",")[0]?.trim().toLowerCase() || "en";
  if (primary.startsWith("zh")) return "zh";
  return primary.split("-")[0] || "en";
}

function emailSecurityContext(request = {}, clientContext = null) {
  const platform = clientContext?.platform || "";
  const device =
    clientContext?.surface ||
    clientContext?.layoutMode ||
    (platform ? `${platform} client` : "");
  return {
    device,
    platform,
    ip: request?.ip || "Unknown IP",
    time: new Date().toISOString(),
    requestId: clientContext?.requestId || "",
  };
}

function sixDigitCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function codeIsSixDigits(code = "") {
  return /^\d{6}$/.test(String(code || ""));
}

function verificationClientMatches(verification = null, clientContext = null) {
  if (!verification?.client_id) return true;
  const clientId = String(clientContext?.clientId || "").trim();
  if (!clientId || clientId === "legacy") return true;
  return verification.client_id === clientId;
}

function rateLimited(key, limit) {
  const now = Date.now();
  const bucket = inviteRateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    inviteRateBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  if (bucket.count >= limit) return true;
  bucket.count += 1;
  return false;
}

async function durableInviteRateLimited({
  bucketType,
  value,
  limit,
  fallbackKey,
}) {
  if (!value) return false;
  try {
    return await EmailVerificationRateLimit.hit({
      bucketType,
      purpose: INVITE_RATE_LIMIT_PURPOSE,
      value,
      limit,
      windowMs: RATE_LIMIT_WINDOW_MS,
    });
  } catch (error) {
    console.warn(
      "INVITE REGISTRATION RATE LIMIT FALLING BACK TO MEMORY.",
      error?.code || error?.name || "UnknownRateLimitError"
    );
    return rateLimited(fallbackKey, limit);
  }
}

async function inviteRegisterRateLimited({
  ip = "",
  email = "",
  username = "",
}) {
  const safeIp = String(ip || "unknown").slice(0, 128);
  if (
    await durableInviteRateLimited({
      bucketType: "ip",
      value: safeIp,
      limit: IP_HOURLY_LIMIT,
      fallbackKey: `invite:ip:${safeIp}`,
    })
  )
    return true;
  if (
    email &&
    (await durableInviteRateLimited({
      bucketType: "email",
      value: normalizeEmail(email),
      limit: EMAIL_HOURLY_LIMIT,
      fallbackKey: `invite:email:${normalizeEmail(email)}`,
    }))
  )
    return true;
  if (
    username &&
    (await durableInviteRateLimited({
      bucketType: "username",
      value: String(username).trim().toLowerCase(),
      limit: USERNAME_HOURLY_LIMIT,
      fallbackKey: `invite:username:${String(username).trim().toLowerCase()}`,
    }))
  )
    return true;
  return false;
}

function genericInviteFailure(response) {
  return response.status(400).json({
    success: false,
    error: INVITE_GENERIC_ERROR,
  });
}

function invitePayload(invite) {
  const safeInvite = Invite.publicInvite(invite);
  if (!safeInvite) return null;
  return {
    id: safeInvite.id,
    role: safeInvite.role || ROLES.user,
    status: safeInvite.status,
    expiresAt: safeInvite.expiresAt,
  };
}

function inviteRoleLabel(role = "default") {
  if (role === ROLES.owner) return "系统所有者";
  if (role === "admin") return "管理员";
  if (role === ROLES.developer) return "开发者";
  return "普通用户";
}

async function completeInviteRegistration({ token, body, request, response }) {
  const {
    username,
    email,
    password,
    confirmPassword,
    emailCode,
    emailChallengeId,
  } = body || {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = String(username || "").trim();
  const invite = await Invite.getByToken(token);

  if (
    !Invite.isUsable(invite) ||
    (await inviteRegisterRateLimited({
      ip: request.ip,
      email: normalizedEmail,
      username: normalizedUsername,
    }))
  ) {
    await EventLogs.logEvent("invite_abuse_blocked", {
      flow: "invite_register_finish",
      email: maskedEmail(normalizedEmail),
      username: normalizedUsername || null,
      ip: request.ip || "Unknown IP",
    });
    return genericInviteFailure(response);
  }

  if (
    !validEmail(normalizedEmail) ||
    !codeIsSixDigits(emailCode) ||
    !normalizedUsername ||
    String(password || "") !== String(confirmPassword || "")
  )
    return genericInviteFailure(response);

  try {
    User.validations.username(normalizedUsername);
  } catch {
    return genericInviteFailure(response);
  }

  const existingEmail = await AuthIdentity.identityExists({
    email: normalizedEmail,
  });
  const existingUsername = await AuthIdentity.identityExists({
    username: normalizedUsername,
  });
  if (existingEmail || existingUsername) return genericInviteFailure(response);

  const clientContext = getClientContext(request);
  const verification = emailChallengeId
    ? await EmailVerificationCode.findByChallenge({
        challengeId: emailChallengeId,
        userId: null,
        email: normalizedEmail,
        purpose: INVITE_REGISTER_PURPOSE,
      })
    : await EmailVerificationCode.latest({
        userId: null,
        email: normalizedEmail,
        purpose: INVITE_REGISTER_PURPOSE,
      });
  if (
    !verification ||
    !verificationClientMatches(verification, clientContext) ||
    verification.consumedAt ||
    verification.expiresAt < new Date() ||
    verification.attempts >= EmailVerificationCode.maxAttempts
  )
    return genericInviteFailure(response);

  if (
    !EmailVerificationCode.verifyCode(String(emailCode), verification.code_hash)
  ) {
    await EmailVerificationCode.incrementAttempts(verification.id);
    await EventLogs.logEvent("register_failed", {
      reason: "invite_code_mismatch",
      inviteId: invite.id,
      inviteRole: invite.role,
      email: maskedEmail(normalizedEmail),
      username: normalizedUsername || null,
      ip: request.ip || "Unknown IP",
    });
    return genericInviteFailure(response);
  }

  const consumedCode = await EmailVerificationCode.consume(verification.id);
  if (!consumedCode) return genericInviteFailure(response);

  const inviteRole = Invite.normalizeRole(invite.role);
  const { user, error } = await User.create({
    username: normalizedUsername,
    password,
    role: inviteRole,
    email: normalizedEmail,
    emailVerifiedAt: new Date(),
  });
  if (!user) {
    await EventLogs.logEvent("register_failed", {
      reason: "invite_create_failed",
      inviteId: invite.id,
      inviteRole,
      email: maskedEmail(normalizedEmail),
      username: normalizedUsername || null,
      result: error || null,
      ip: request.ip || "Unknown IP",
    });
    return genericInviteFailure(response);
  }

  await Invite.markClaimed(invite.id, user);
  await EventLogs.logEvent(
    inviteRole === ROLES.user
      ? "invite_consumed"
      : "admin_registered_by_invite",
    {
      inviteId: invite.id,
      role: inviteRole,
      roleLabel: inviteRoleLabel(inviteRole),
      username: user.username,
      email: maskedEmail(normalizedEmail),
    },
    user.id
  );
  if (inviteRole !== ROLES.user) {
    await EventLogs.logEvent(
      "invite_consumed",
      {
        inviteId: invite.id,
        role: inviteRole,
        username: user.username,
      },
      user.id
    );
  }

  const authUser = user.authUserId
    ? await AuthIdentity.findById(user.authUserId)
    : null;
  if (!(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))) {
    return response.status(200).json({
      success: true,
      valid: false,
      user,
      token: null,
      message: LOGIN_GENERIC_ERROR,
    });
  }

  const sessionToken = issueUserSessionToken(user, {
    ...sessionTokenOptionsFromClientContext(getClientContext(request)),
  });
  const recoveryCodes = await generateRecoveryCodes(user.id);
  return response.status(200).json({
    success: true,
    valid: true,
    user,
    token: sessionToken,
    recoveryCodes,
  });
}

function inviteEndpoints(app) {
  if (!app) return;

  app.get("/invite/:code", async (request, response) => {
    try {
      const { code } = request.params;
      const invite = await Invite.getByToken(code);
      if (!Invite.isUsable(invite)) {
        response
          .status(200)
          .json({ invite: null, error: "Invite is invalid." });
        return;
      }

      response.status(200).json({
        invite: invitePayload(invite),
        error: null,
      });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  app.post("/invite/:code/email/request", async (request, response) => {
    try {
      const { code } = request.params;
      const { email } = reqBody(request);
      const normalizedEmail = normalizeEmail(email);
      const generic = {
        success: true,
        message: INVITE_CODE_SENT,
        resendCooldownSeconds: Math.ceil(
          EmailVerificationCode.resendCooldownMs / 1000
        ),
        challengeId: crypto.randomUUID(),
      };

      const invite = await Invite.getByToken(code);
      if (
        !Invite.isUsable(invite) ||
        (await inviteRegisterRateLimited({
          ip: request.ip,
          email: normalizedEmail,
        }))
      ) {
        await EventLogs.logEvent("invite_abuse_blocked", {
          flow: "invite_register_code",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        response.status(200).json(generic);
        return;
      }

      if (!validEmail(normalizedEmail)) {
        response.status(200).json(generic);
        return;
      }

      const existing = await User._get({ email: normalizedEmail });
      if (existing || !emailSmtpConfigured()) {
        response.status(200).json(generic);
        return;
      }

      const latest = await EmailVerificationCode.latest({
        userId: null,
        email: normalizedEmail,
        purpose: INVITE_REGISTER_PURPOSE,
      });
      if (
        latest &&
        !latest.consumedAt &&
        Date.now() - new Date(latest.createdAt).getTime() <
          EmailVerificationCode.resendCooldownMs
      ) {
        response.status(200).json({
          ...generic,
          challengeId: latest.challenge_id || generic.challengeId,
        });
        return;
      }

      const verificationCode = sixDigitCode();
      const clientContext = getClientContext(request);
      await EmailVerificationCode.expireOpenCodes({
        userId: null,
        email: normalizedEmail,
        purpose: INVITE_REGISTER_PURPOSE,
      });
      const { verification } = await EmailVerificationCode.create({
        userId: null,
        email: normalizedEmail,
        purpose: INVITE_REGISTER_PURPOSE,
        code: verificationCode,
        requestIp: request.ip || "Unknown IP",
        clientId:
          clientContext.clientId !== "legacy" ? clientContext.clientId : null,
        deviceId:
          clientContext.clientId !== "legacy" ? clientContext.clientId : null,
      });

      try {
        await sendVerificationCode({
          to: normalizedEmail,
          code: verificationCode,
          purpose: INVITE_REGISTER_PURPOSE,
          language: requestLanguage(request),
          securityContext: emailSecurityContext(request, clientContext),
        });
      } catch (error) {
        if (verification) await EmailVerificationCode.consume(verification.id);
        console.error(
          "FAILED TO SEND INVITE REGISTRATION CODE.",
          error.message
        );
      }

      response.status(200).json({
        ...generic,
        challengeId: verification?.challenge_id || generic.challengeId,
      });
    } catch (e) {
      console.error(e);
      response
        .status(500)
        .json({ success: false, error: INVITE_GENERIC_ERROR });
    }
  });

  app.post(
    "/invite/:code",
    [simpleSSOLoginDisabledMiddleware],
    async (request, response) => {
      try {
        const { code } = request.params;
        return completeInviteRegistration({
          token: code,
          body: reqBody(request),
          request,
          response,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/auth/admin-invite/register",
    [simpleSSOLoginDisabledMiddleware],
    async (request, response) => {
      try {
        const { token, ...body } = reqBody(request);
        return completeInviteRegistration({
          token,
          body,
          request,
          response,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { inviteEndpoints };
