const crypto = require("crypto");
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require("@simplewebauthn/server");
const authPrisma = require("../utils/authPrisma");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { AuthIdentity } = require("../models/authIdentity");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { reqBody } = require("../utils/http");
const {
  issueUserSessionToken,
  sessionTokenOptionsFromClientContext,
} = require("../utils/sessionIdle");
const { getClientContext } = require("../utils/clientIdentity");

const RP_NAME = process.env.PASSKEY_RP_NAME || "Athena";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const OPTIONS_LIMIT_PER_MINUTE = 20;
const VERIFY_FAILURE_LIMIT = 5;
const VERIFY_COOLDOWN_MS = 5 * 60 * 1000;

const optionRequestsByIp = new Map();
const verifyFailuresByIp = new Map();
const APPLE_PASSKEY_AAGUIDS = new Map([
  ["00000000-0000-0000-0000-000000000000", "Apple iCloud Keychain"],
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "Apple Passwords"],
  ["dd4ec289-e01d-41c9-bb89-70fa845d4bf2", "Apple Passwords (Managed)"],
]);
const GOOGLE_PASSKEY_AAGUIDS = new Map([
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  ["adce0002-35bc-c60a-648b-0b25f1f05503", "Chrome Profile Passkey"],
]);

function authPasskeyEndpoints(app) {
  app.post(
    "/auth/passkeys/register/options",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const ip = requestIp(request);
        const rateLimit = checkOptionsRateLimit(ip);
        if (!rateLimit.allowed) {
          return response.status(429).json({
            success: false,
            error: "Too many passkey requests. Please try again shortly.",
            retryAfter: rateLimit.retryAfter,
          });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const { origin, rpID } = passkeyRpConfig(request);
        assertSecurePasskeyOrigin(origin);
        const existingCredentials = await authPrisma.passkeyCredential.findMany(
          {
            where: { userId: authUserId },
            select: { credentialId: true, transports: true },
          }
        );
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID,
          userName: user.username || user.email || `user-${user.id}`,
          userID: userIdBytes(authUserId),
          attestationType: "none",
          excludeCredentials: existingCredentials.map((credential) => ({
            id: credential.credentialId,
            transports: parseTransports(credential.transports),
          })),
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
            authenticatorAttachment: "platform",
          },
        });

        await rememberChallenge({
          challenge: normalizeBase64Url(options.challenge),
          type: "register",
          userId: authUserId,
          request,
        });

        return response.status(200).json({ success: true, options });
      } catch (error) {
        console.error("[Passkey register options failed]", error.message);
        return response.status(500).json({
          success: false,
          error: "Could not start passkey registration.",
        });
      }
    }
  );

  app.post(
    "/auth/passkeys/register/verify",
    [validatedRequest],
    async (request, response) => {
      let challengeRecord = null;
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const body = reqBody(request);
        const attestationResponse = body?.response;
        const challenge = normalizeBase64Url(
          attestationResponse?.response?.clientDataJSON
            ? challengeFromClientData(
                attestationResponse.response.clientDataJSON
              )
            : null
        );

        challengeRecord = await consumeChallenge({
          challenge,
          type: "register",
          userId: authUserId,
        });
        if (!challengeRecord) {
          return response.status(400).json({
            success: false,
            error: "Passkey challenge has expired. Please try again.",
          });
        }

        const { origin, rpID } = passkeyRpConfig(request);
        assertSecurePasskeyOrigin(origin);
        const verification = await verifyRegistrationResponse({
          response: attestationResponse,
          expectedChallenge: challengeRecord.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });

        if (!verification.verified || !verification.registrationInfo) {
          return response.status(400).json({
            success: false,
            error: "Could not verify passkey registration.",
          });
        }

        const { aaguid, credential, credentialBackedUp, credentialDeviceType } =
          verification.registrationInfo;
        const credentialId = normalizeBase64Url(credential.id);
        const deviceType = normalizeDeviceType(
          body?.deviceType,
          credentialDeviceType
        );
        const browserName = normalizeDisplayLabel(body?.browserName, 40);
        const platformName = normalizeDisplayLabel(body?.platformName, 40);
        const provider = providerMetadata({
          aaguid,
          browserName,
          platformName,
          userAgent: request.get("user-agent") || "",
        });
        const deviceName = normalizeDeviceName({
          preferred: body?.deviceName,
          deviceType,
          browserName,
          platformName,
          providerName: provider.providerName,
        });
        const passkey = await authPrisma.passkeyCredential.create({
          data: {
            userId: authUserId,
            credentialId,
            publicKey: bytesToBase64Url(credential.publicKey),
            counter: Number(credential.counter || 0),
            transports: JSON.stringify(credential.transports || []),
            deviceType,
            deviceName,
            browserName,
            platformName,
            aaguid: normalizeAaguid(aaguid),
            provider: provider.provider,
            providerName: provider.providerName,
            backedUp: Boolean(credentialBackedUp),
          },
        });

        await EventLogs.logEvent(
          "passkey_registered",
          safeAuditMetadata(request, {
            passkeyId: passkey.id,
            credential: credentialFingerprint(credentialId),
            deviceName,
            deviceType,
            provider: provider.provider,
            providerName: provider.providerName,
          }),
          user.id
        );

        return response.status(200).json({
          success: true,
          passkey: sanitizePasskey(passkey),
        });
      } catch (error) {
        console.error("[Passkey register verify failed]", error.message);
        return response.status(400).json({
          success: false,
          error: "Could not verify passkey registration.",
        });
      }
    }
  );

  app.post("/auth/passkeys/login/options", async (request, response) => {
    try {
      if (!(await SystemSettings.isMultiUserMode())) {
        return response.status(404).json({ success: false });
      }

      const ip = requestIp(request);
      const rateLimit = checkOptionsRateLimit(ip);
      if (!rateLimit.allowed) {
        return response.status(429).json({
          success: false,
          error: "Too many passkey requests. Please try again shortly.",
          retryAfter: rateLimit.retryAfter,
        });
      }

      const { origin, rpID } = passkeyRpConfig(request);
      assertSecurePasskeyOrigin(origin);
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        allowCredentials: [],
      });

      await rememberChallenge({
        challenge: normalizeBase64Url(options.challenge),
        type: "login",
        userId: null,
        request,
      });

      return response.status(200).json({ success: true, options });
    } catch (error) {
      console.error("[Passkey login options failed]", error.message);
      return response.status(500).json({
        success: false,
        error: "Could not start passkey login.",
      });
    }
  });

  app.post("/auth/passkeys/login/verify", async (request, response) => {
    const ip = requestIp(request);
    try {
      if (!(await SystemSettings.isMultiUserMode())) {
        return response.status(404).json({ valid: false });
      }

      const cooldown = verifyCooldown(ip);
      if (cooldown.active) {
        return response.status(429).json({
          valid: false,
          user: null,
          token: null,
          message: "Too many failed passkey attempts. Please try again later.",
          retryAfter: cooldown.retryAfter,
        });
      }

      const body = reqBody(request);
      const authResponse = body?.response;
      const credentialId = normalizeBase64Url(authResponse?.id);
      const challenge = normalizeBase64Url(
        authResponse?.response?.clientDataJSON
          ? challengeFromClientData(authResponse.response.clientDataJSON)
          : null
      );
      const challengeRecord = await consumeChallenge({
        challenge,
        type: "login",
      });
      if (!challengeRecord) {
        await recordPasskeyLoginFailure(request, {
          reason: "missing_or_expired_challenge",
          credentialId,
        });
        markVerifyFailure(ip);
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "Passkey challenge has expired. Please try again.",
        });
      }

      const passkey = await authPrisma.passkeyCredential.findUnique({
        where: { credentialId },
        include: { user: true },
      });
      if (
        !passkey ||
        !passkey.user ||
        passkey.user.suspended ||
        !(await AuthIdentity.canLoginInCurrentEnvAsync(passkey.user))
      ) {
        await recordPasskeyLoginFailure(request, {
          reason: "unknown_or_suspended_credential",
          credentialId,
          userId: passkey?.userId,
        });
        markVerifyFailure(ip);
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "Could not verify passkey.",
        });
      }

      if (!userHandleMatches(authResponse, passkey.userId)) {
        await recordPasskeyLoginFailure(request, {
          reason: "user_handle_mismatch",
          credentialId,
          userId: passkey.userId,
        });
        markVerifyFailure(ip);
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "Could not verify passkey.",
        });
      }

      const { origin, rpID } = passkeyRpConfig(request);
      assertSecurePasskeyOrigin(origin);
      const verification = await verifyAuthenticationResponse({
        response: authResponse,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: base64UrlToBytes(passkey.publicKey),
          counter: Number(passkey.counter || 0),
          transports: parseTransports(passkey.transports),
        },
      });

      if (!verification.verified) {
        await recordPasskeyLoginFailure(request, {
          reason: "verification_failed",
          credentialId,
          userId: passkey.userId,
        });
        markVerifyFailure(ip);
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "Could not verify passkey.",
        });
      }

      clearVerifyFailures(ip);
      await authPrisma.passkeyCredential.update({
        where: { id: passkey.id },
        data: {
          counter: Number(
            verification.authenticationInfo?.newCounter ?? passkey.counter
          ),
          lastUsedAt: new Date(),
        },
      });

      const localUser = await AuthIdentity.ensureShadowUser(passkey.user);
      if (!localUser) {
        markVerifyFailure(ip);
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "Could not verify passkey.",
        });
      }

      await EventLogs.logEvent(
        "passkey_login_succeeded",
        safeAuditMetadata(request, {
          passkeyId: passkey.id,
          credential: credentialFingerprint(passkey.credentialId),
          deviceName: passkey.deviceName,
          deviceType: passkey.deviceType,
        }),
        localUser.id
      );

      const sessionToken = issueUserSessionToken(localUser, {
        ...sessionTokenOptionsFromClientContext(getClientContext(request)),
      });
      return response.status(200).json({
        valid: true,
        user: User.filterFields(localUser),
        token: sessionToken,
        message: null,
      });
    } catch (error) {
      await recordPasskeyLoginFailure(request, {
        reason: "verify_exception",
        credentialId: credentialIdFromRequest(request),
      });
      markVerifyFailure(ip);
      console.error("[Passkey login verify failed]", error.message);
      return response.status(200).json({
        valid: false,
        user: null,
        token: null,
        message: "Could not verify passkey.",
      });
    }
  });

  app.get("/auth/passkeys", [validatedRequest], async (_request, response) => {
    try {
      if (!response.locals.multiUserMode) {
        return response.status(404).json({ success: false });
      }

      const user = response.locals.user;
      const authUserId = await currentAuthUserId(user);
      const passkeys = await authPrisma.passkeyCredential.findMany({
        where: { userId: authUserId },
        orderBy: { createdAt: "desc" },
      });
      const risk = await loginMethodRisk(user, null);
      return response.status(200).json({
        success: true,
        passkeys: passkeys.map(sanitizePasskey),
        risk,
      });
    } catch (error) {
      console.error("[Passkey list failed]", error.message);
      return response.status(500).json({
        success: false,
        error: "无法读取通行密钥。",
      });
    }
  });

  app.delete(
    "/auth/passkeys/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const body = reqBody(request) || {};
        const passkey = await authPrisma.passkeyCredential.findFirst({
          where: { id: Number(request.params.id), userId: authUserId },
        });
        if (!passkey) {
          return response.status(404).json({
            success: false,
            error: "Passkey not found.",
          });
        }

        const risk = await loginMethodRisk(user, passkey.id);
        if (risk.requiresConfirmation && !body.confirmRisk) {
          return response.status(409).json({
            success: false,
            requiresRiskConfirmation: true,
            risk,
          });
        }

        await authPrisma.passkeyCredential.delete({
          where: { id: passkey.id },
        });
        await EventLogs.logEvent(
          "passkey_deleted",
          safeAuditMetadata(request, {
            passkeyId: passkey.id,
            credential: credentialFingerprint(passkey.credentialId),
            deviceName: passkey.deviceName,
            deviceType: passkey.deviceType,
          }),
          user.id
        );

        return response.status(200).json({ success: true });
      } catch (error) {
        console.error("[Passkey delete failed]", error.message);
        return response.status(500).json({
          success: false,
          error: "Could not delete passkey.",
        });
      }
    }
  );
}

async function rememberChallenge({ challenge, type, userId, request }) {
  await cleanupExpiredChallenges();
  return authPrisma.passkeyChallenge.create({
    data: {
      challenge,
      type,
      userId,
      requestIp: requestIp(request),
      userAgent: request.get("user-agent") || null,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
}

async function consumeChallenge({ challenge, type, userId = undefined }) {
  if (!challenge) return null;
  const record = await authPrisma.passkeyChallenge.findFirst({
    where: {
      challenge,
      type,
      ...(userId !== undefined ? { userId } : {}),
      expiresAt: { gt: new Date() },
    },
  });
  if (!record) return null;
  await authPrisma.passkeyChallenge.delete({ where: { id: record.id } });
  return record;
}

function passkeyRpConfig(request) {
  const origin = process.env.PASSKEY_ORIGIN || requestOrigin(request);
  const rpID =
    process.env.PASSKEY_RP_ID ||
    new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
  return { origin, rpID };
}

function requestOrigin(request) {
  if (request.get("origin")) return request.get("origin");
  const host = request.get("x-forwarded-host") || request.get("host");
  const proto =
    request.get("x-forwarded-proto") ||
    (request.secure || process.env.ENABLE_HTTPS ? "https" : "http");
  return `${proto.split(",")[0]}://${String(host).split(",")[0]}`;
}

function assertSecurePasskeyOrigin(origin) {
  const url = new URL(origin);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLocalhost(url.hostname)) return;
  throw new Error("Passkeys require HTTPS outside localhost.");
}

function isLocalhost(hostname = "") {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function requestIp(request) {
  const forwarded = request.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.ip || request.socket?.remoteAddress || "unknown";
}

async function cleanupExpiredChallenges() {
  await authPrisma.passkeyChallenge.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}

function checkOptionsRateLimit(ip) {
  const now = Date.now();
  const recent = (optionRequestsByIp.get(ip) || []).filter(
    (timestamp) => now - timestamp < 60_000
  );
  if (recent.length >= OPTIONS_LIMIT_PER_MINUTE) {
    return {
      allowed: false,
      retryAfter: Math.ceil((60_000 - (now - recent[0])) / 1000),
    };
  }
  recent.push(now);
  optionRequestsByIp.set(ip, recent);
  return { allowed: true, retryAfter: 0 };
}

function verifyCooldown(ip) {
  const state = verifyFailuresByIp.get(ip);
  if (!state?.cooldownUntil) return { active: false, retryAfter: 0 };
  const now = Date.now();
  if (state.cooldownUntil <= now) {
    verifyFailuresByIp.delete(ip);
    return { active: false, retryAfter: 0 };
  }
  return {
    active: true,
    retryAfter: Math.ceil((state.cooldownUntil - now) / 1000),
  };
}

function markVerifyFailure(ip) {
  const now = Date.now();
  const current = verifyFailuresByIp.get(ip) || { count: 0, firstAt: now };
  const withinWindow = now - current.firstAt < VERIFY_COOLDOWN_MS;
  const next = withinWindow
    ? { ...current, count: current.count + 1 }
    : { count: 1, firstAt: now };
  if (next.count >= VERIFY_FAILURE_LIMIT) {
    next.cooldownUntil = now + VERIFY_COOLDOWN_MS;
  }
  verifyFailuresByIp.set(ip, next);
}

function clearVerifyFailures(ip) {
  verifyFailuresByIp.delete(ip);
}

async function currentAuthUserId(user = null) {
  if (!user?.id) return null;
  if (user.authUserId) return user.authUserId;
  const shadow = await User._get({ id: user.id });
  if (shadow?.authUserId) return shadow.authUserId;
  const authUser = await AuthIdentity.bootstrapAuthUserFromShadow(shadow);
  return authUser?.id || null;
}

async function loginMethodRisk(user, deletingPasskeyId) {
  const authUserId = await currentAuthUserId(user);
  const remainingPasskeys = await authPrisma.passkeyCredential.count({
    where: {
      userId: authUserId,
      ...(deletingPasskeyId ? { id: { not: deletingPasskeyId } } : {}),
    },
  });
  const recoveryCodes = await authPrisma.recovery_codes.count({
    where: { user_id: authUserId },
  });
  const methods = {
    password: Boolean(user.password),
    verifiedEmail: Boolean(user.email && user.email_verified_at),
    recoveryCodes: recoveryCodes > 0,
    passkeys: remainingPasskeys,
  };
  const methodCount =
    Number(methods.password) +
    Number(methods.verifiedEmail) +
    Number(methods.recoveryCodes) +
    remainingPasskeys;
  const requiresConfirmation =
    deletingPasskeyId && (methodCount <= 1 || remainingPasskeys === 0);

  return {
    methods,
    methodCount,
    requiresConfirmation: Boolean(requiresConfirmation),
    message: requiresConfirmation
      ? "删除后账户将不再有其它通行密钥，请确认你仍可使用密码、已验证邮箱或恢复码登录。"
      : null,
  };
}

function userHandleMatches(authResponse, userId) {
  const userHandle = authResponse?.response?.userHandle;
  if (!userHandle) return true;
  return (
    normalizeBase64Url(userHandle) === bytesToBase64Url(userIdBytes(userId))
  );
}

function challengeFromClientData(clientDataJSON) {
  try {
    const json = JSON.parse(base64UrlToBytes(clientDataJSON).toString("utf8"));
    return json.challenge;
  } catch {
    return null;
  }
}

function normalizeBase64Url(value) {
  if (!value) return null;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return bytesToBase64Url(value);
  }
  return String(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function bytesToBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlToBytes(value) {
  return Buffer.from(normalizeBase64Url(value), "base64url");
}

function userIdBytes(userId) {
  return Buffer.from(String(userId), "utf8");
}

function parseTransports(transports) {
  if (Array.isArray(transports)) return transports;
  try {
    const parsed = JSON.parse(transports || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDeviceType(preferred, fallback = "platform") {
  const value = String(preferred || fallback || "platform").toLowerCase();
  if (value.includes("iphone")) return "iphone";
  if (value.includes("ipad")) return "ipad";
  if (value.includes("mac")) return "mac";
  if (["singledevice", "single-device"].includes(value)) return "platform";
  if (["multidevice", "multi-device"].includes(value)) return "synced";
  return value.replace(/[^a-z0-9_-]/g, "") || "platform";
}

function normalizeDeviceName({
  preferred,
  deviceType,
  browserName,
  platformName,
  providerName,
}) {
  const name = normalizeDisplayLabel(preferred, 80);
  if (name) return name;
  if (browserName && platformName) return `${browserName} on ${platformName}`;
  if (providerName && providerName !== "来源待确认") return providerName;
  if (deviceType === "mac") return "Mac";
  if (deviceType === "iphone") return "iPhone";
  if (deviceType === "ipad") return "iPad";
  return "This Device";
}

function normalizeDisplayLabel(value, maxLength = 80) {
  const label = String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
  return label || null;
}

function normalizeAaguid(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

function providerMetadata({ aaguid, browserName, platformName, userAgent }) {
  const normalizedAaguid = normalizeAaguid(aaguid);
  const platform = String(platformName || "").toLowerCase();
  const browser = String(browserName || "").toLowerCase();
  const ua = String(userAgent || "").toLowerCase();

  if (APPLE_PASSKEY_AAGUIDS.has(normalizedAaguid)) {
    return {
      provider: "apple",
      providerName: APPLE_PASSKEY_AAGUIDS.get(normalizedAaguid),
    };
  }

  if (GOOGLE_PASSKEY_AAGUIDS.has(normalizedAaguid)) {
    return {
      provider: "google",
      providerName: GOOGLE_PASSKEY_AAGUIDS.get(normalizedAaguid),
    };
  }

  if (!normalizedAaguid) {
    const looksApple =
      platform.includes("mac") ||
      platform.includes("ios") ||
      platform.includes("ipad") ||
      platform.includes("iphone") ||
      ua.includes("mac os x") ||
      ua.includes("iphone") ||
      ua.includes("ipad");
    if (looksApple) {
      return {
        provider: "apple",
        providerName: "Apple iCloud Keychain",
      };
    }
  }

  if (browser.includes("chrome") || browser.includes("edge")) {
    return {
      provider: "browser",
      providerName: "浏览器或平台认证器",
    };
  }

  return {
    provider: "unknown",
    providerName: "来源待确认",
  };
}

function sanitizePasskey(passkey) {
  const provider = passkeyDisplayProvider(passkey);
  return {
    id: passkey.id,
    deviceName: passkey.deviceName,
    deviceType: passkey.deviceType,
    browserName: passkey.browserName,
    platformName: passkey.platformName,
    provider: provider.provider,
    providerName: provider.providerName,
    backedUp: passkey.backedUp,
    transports: parseTransports(passkey.transports),
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
  };
}

function passkeyDisplayProvider(passkey) {
  const normalizedAaguid = normalizeAaguid(passkey.aaguid);
  const inferred = providerMetadata({
    aaguid: normalizedAaguid,
    browserName: passkey.browserName,
    platformName: passkey.platformName,
    userAgent: "",
  });
  const hasKnownProviderAaguid =
    APPLE_PASSKEY_AAGUIDS.has(normalizedAaguid) ||
    GOOGLE_PASSKEY_AAGUIDS.has(normalizedAaguid);
  if (hasKnownProviderAaguid && ["apple", "google"].includes(inferred.provider))
    return inferred;
  if (passkey.provider && passkey.provider !== "unknown") {
    return {
      provider: passkey.provider,
      providerName: passkey.providerName || "来源待确认",
    };
  }
  if (["apple", "google"].includes(inferred.provider)) return inferred;
  return inferred;
}

function safeAuditMetadata(request, metadata = {}) {
  return {
    ...metadata,
    ip: requestIp(request),
    userAgent: request.get("user-agent") || null,
  };
}

function credentialFingerprint(credentialId) {
  if (!credentialId) return null;
  return crypto
    .createHash("sha256")
    .update(credentialId)
    .digest("hex")
    .slice(0, 16);
}

function credentialIdFromRequest(request) {
  try {
    return reqBody(request)?.response?.id;
  } catch {
    return null;
  }
}

async function recordPasskeyLoginFailure(request, metadata = {}) {
  await EventLogs.logEvent(
    "passkey_login_failed",
    safeAuditMetadata(request, {
      reason: metadata.reason || "unknown",
      userId: metadata.userId || null,
      credential: credentialFingerprint(
        normalizeBase64Url(metadata.credentialId)
      ),
    }),
    metadata.userId || null
  );
}

module.exports = {
  authPasskeyEndpoints,
  _passkeyTestUtils: {
    base64UrlToBytes,
    bytesToBase64Url,
    checkOptionsRateLimit,
    challengeFromClientData,
    clearVerifyFailures,
    consumeChallenge,
    markVerifyFailure,
    normalizeBase64Url,
    providerMetadata,
    sanitizePasskey,
    resetRateLimits: () => {
      optionRequestsByIp.clear();
      verifyFailuresByIp.clear();
    },
    userHandleMatches,
    verifyCooldown,
  },
};
