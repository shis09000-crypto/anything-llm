const crypto = require("crypto");
const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = require("@simplewebauthn/server");
const { decodeCredentialPublicKey } = require("@simplewebauthn/server/helpers");
const authPrisma = require("../utils/authPrisma");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { DataAccessCenter } = require("../utils/dataAccess");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { reqBody } = require("../utils/http");
const {
  createUserSessionToken,
  sessionTokenOptionsFromClientContext,
} = require("../utils/sessionIdle");
const { issueReauthToken } = require("../utils/authz/reauthTokens");
const { getClientContext } = require("../utils/clientIdentity");
const {
  completeDeviceBindingRecovery,
  evaluateDeviceBindingForLogin,
} = require("../utils/authz/deviceBindingRecovery");
const {
  reconcilePasskeysForShadowUser,
} = require("../utils/syncV2/securitySync");
const SystemSettings = DataAccessCenter.adminSystem;
const AuthIdentity = DataAccessCenter.authIdentity.model;
const User = DataAccessCenter.authIdentity.shadowUser;

const RP_NAME = process.env.PASSKEY_RP_NAME || "Athena";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const OPTIONS_LIMIT_PER_MINUTE = 20;
const VERIFY_FAILURE_LIMIT = 5;
const VERIFY_COOLDOWN_MS = 5 * 60 * 1000;
const NATIVE_WEB_HANDOFF_TTL_MS = 90 * 1000;

const optionRequestsByIp = new Map();
const verifyFailuresByIp = new Map();
const nativeWebHandoffs = new Map();
const nativeRegistrationHandoffs = new Map();
const nativeRegistrationExchanges = new Map();
const APPLE_PASSKEY_AAGUIDS = new Map([
  ["00000000-0000-0000-0000-000000000000", "Apple iCloud Keychain"],
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "Apple Passwords"],
  ["dd4ec289-e01d-41c9-bb89-70fa845d4bf2", "Apple Passwords (Managed)"],
]);
const GOOGLE_PASSKEY_AAGUIDS = new Map([
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  ["adce0002-35bc-c60a-648b-0b25f1f05503", "Chrome Profile Passkey"],
]);
const COSE_ALGORITHMS = new Map([
  [-7, "ES256"],
  [-8, "EdDSA"],
  [-35, "ES384"],
  [-36, "ES512"],
  [-37, "PS256"],
  [-38, "PS384"],
  [-39, "PS512"],
  [-47, "ES256K"],
  [-257, "RS256"],
  [-258, "RS384"],
  [-259, "RS512"],
]);
const COSE_PARAMETER_SETS = new Map([
  [1, "P-256"],
  [2, "P-384"],
  [3, "P-521"],
  [6, "Ed25519"],
  [8, "secp256k1"],
]);

function authPasskeyEndpoints(app) {
  // A minimal P0 web-auth surface for the temporary native App handoff. It
  // intentionally avoids loading the web workspace or its navigation tasks.
  app.get("/auth/passkeys/native-web", async (request, response) => {
    try {
      if (!(await SystemSettings.isMultiUserMode())) {
        return response.status(404).send("Not found");
      }

      const handoff = nativeWebHandoffFromQuery(request.query || {});
      response.set({
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return response
        .status(200)
        .type("html")
        .send(
          nativeWebPasskeyPage({
            state: handoff.state,
            codeChallenge: handoff.codeChallenge,
            purpose: handoff.purpose,
          })
        );
    } catch {
      return response
        .status(400)
        .send("Invalid native authentication request.");
    }
  });

  app.post("/auth/passkeys/native-web/exchange", async (request, response) => {
    try {
      const body = reqBody(request);
      const code = normalizeOpaqueHandoffValue(body?.code, 32, 256);
      const codeVerifier = normalizeOpaqueHandoffValue(
        body?.codeVerifier,
        43,
        128
      );
      const key = nativeWebHandoffKey(code);
      const handoff = nativeWebHandoffs.get(key);
      if (!handoff || handoff.expiresAt <= Date.now()) {
        nativeWebHandoffs.delete(key);
        return response.status(401).json(nativeWebExchangeFailure());
      }

      if (
        !safeOpaqueEqual(sha256Base64Url(codeVerifier), handoff.codeChallenge)
      ) {
        return response.status(401).json(nativeWebExchangeFailure());
      }
      nativeWebHandoffs.delete(key);

      const shadowUser = await User._get({ id: handoff.shadowUserId });
      if (!shadowUser)
        return response.status(401).json(nativeWebExchangeFailure());

      let authUser = shadowUser.authUserId
        ? await AuthIdentity.findById(shadowUser.authUserId)
        : null;
      if (!authUser) {
        authUser = await AuthIdentity.bootstrapAuthUserFromShadow(shadowUser);
      }
      if (
        !authUser ||
        !(await AuthIdentity.canLoginInCurrentEnvAsync(authUser))
      ) {
        return response.status(401).json(nativeWebExchangeFailure());
      }

      const localUser = await AuthIdentity.ensureShadowUser(authUser);
      if (!localUser)
        return response.status(401).json(nativeWebExchangeFailure());

      if (handoff.purpose !== "login") {
        return response.status(200).json({
          valid: true,
          user: User.filterFields(localUser),
          token: null,
          reauthToken: issueReauthToken(
            localUser.id,
            "passkey",
            handoff.purpose
          ),
          purpose: handoff.purpose,
          message: null,
        });
      }

      const token = await createUserSessionToken(localUser, {
        ...sessionTokenOptionsFromClientContext(getClientContext(request)),
        authMode: "passkey",
      });
      return response.status(200).json({
        valid: true,
        user: User.filterFields(localUser),
        token,
        reauthToken: null,
        purpose: "login",
        message: null,
      });
    } catch {
      return response.status(401).json(nativeWebExchangeFailure());
    }
  });

  app.post(
    "/auth/passkeys/native-register/start",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }
        const body = reqBody(request);
        const state = normalizeOpaqueHandoffValue(body?.state, 32, 128);
        const codeChallenge = normalizeOpaqueHandoffValue(
          body?.codeChallenge,
          43,
          128
        );
        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const handoffId = crypto.randomBytes(32).toString("base64url");
        pruneNativeRegistrationHandoffs();
        nativeRegistrationHandoffs.set(nativeWebHandoffKey(handoffId), {
          shadowUserId: user.id,
          authUserId,
          state,
          codeChallenge,
          expiresAt: Date.now() + NATIVE_WEB_HANDOFF_TTL_MS,
        });
        const startURL = new URL(
          "/api/auth/passkeys/native-register",
          requestOrigin(request)
        );
        startURL.searchParams.set("handoff", handoffId);
        startURL.searchParams.set("state", state);
        return response.status(200).json({
          success: true,
          startUrl: startURL.toString(),
          expiresInSeconds: Math.floor(NATIVE_WEB_HANDOFF_TTL_MS / 1000),
        });
      } catch {
        return response.status(400).json({
          success: false,
          error: "无法创建通行密钥注册会话。",
        });
      }
    }
  );

  app.get("/auth/passkeys/native-register", async (request, response) => {
    try {
      const record = nativeRegistrationRecord(request.query || {});
      response.set({
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      return response
        .status(200)
        .type("html")
        .send(
          nativeWebPasskeyRegistrationPage({
            handoff: request.query.handoff,
            state: record.state,
          })
        );
    } catch {
      return response.status(400).send("Invalid passkey registration request.");
    }
  });

  app.post(
    "/auth/passkeys/native-register/options",
    async (request, response) => {
      try {
        const rateLimit = checkOptionsRateLimit(requestIp(request));
        if (!rateLimit.allowed) {
          return response.status(429).json({
            success: false,
            error: "通行密钥请求过于频繁，请稍后再试。",
            retryAfter: rateLimit.retryAfter,
          });
        }
        const record = nativeRegistrationRecord(reqBody(request));
        const user = await User._get({ id: record.shadowUserId });
        if (!user) throw new Error("Registration user is unavailable.");
        const options = await registrationOptionsForUser({
          user,
          authUserId: record.authUserId,
          request,
        });
        return response.status(200).json({ success: true, options });
      } catch (error) {
        console.error(
          "[Native passkey register options failed]",
          error.message
        );
        return response.status(400).json({
          success: false,
          error: "无法开始通行密钥注册。",
        });
      }
    }
  );

  app.post(
    "/auth/passkeys/native-register/verify",
    async (request, response) => {
      try {
        const body = reqBody(request);
        const record = nativeRegistrationRecord(body);
        const user = await User._get({ id: record.shadowUserId });
        if (!user) throw new Error("Registration user is unavailable.");
        const passkey = await verifyAndStoreRegistration({
          user,
          authUserId: record.authUserId,
          body,
          request,
        });
        nativeRegistrationHandoffs.delete(nativeWebHandoffKey(body.handoff));
        const code = issueNativeRegistrationExchange(record);
        return response.status(200).json({
          success: true,
          code,
          state: record.state,
          passkey: sanitizePasskey(passkey),
        });
      } catch (error) {
        console.error("[Native passkey register verify failed]", error.message);
        return response.status(400).json({
          success: false,
          error: "无法验证通行密钥注册。",
        });
      }
    }
  );

  app.post(
    "/auth/passkeys/native-register/exchange",
    [validatedRequest],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const code = normalizeOpaqueHandoffValue(body?.code, 32, 256);
        const verifier = normalizeOpaqueHandoffValue(
          body?.codeVerifier,
          43,
          128
        );
        pruneNativeRegistrationHandoffs();
        const key = nativeWebHandoffKey(code);
        const exchange = nativeRegistrationExchanges.get(key);
        if (
          !exchange ||
          exchange.expiresAt <= Date.now() ||
          exchange.shadowUserId !== response.locals.user?.id ||
          !safeOpaqueEqual(sha256Base64Url(verifier), exchange.codeChallenge)
        ) {
          return response.status(401).json({
            success: false,
            error: "通行密钥注册确认已过期。",
          });
        }
        nativeRegistrationExchanges.delete(key);
        return response.status(200).json({ success: true });
      } catch {
        return response.status(401).json({
          success: false,
          error: "通行密钥注册确认无效。",
        });
      }
    }
  );

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
        const options = await registrationOptionsForUser({
          user,
          authUserId,
          request,
          rpID,
        });

        return response.status(200).json({ success: true, options });
      } catch (error) {
        console.error("[Passkey register options failed]", error.message);
        return response.status(error.httpStatus || 500).json({
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
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const passkey = await verifyAndStoreRegistration({
          user,
          authUserId,
          body: reqBody(request),
          request,
        });

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
      return response.status(error.httpStatus || 500).json({
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

      const nativeHandoff = nativeWebHandoffFromRequest(body);
      if (body?.deviceRecovery) {
        await completeDeviceBindingRecovery({
          request,
          user: localUser,
          authUserId: passkey.user.id,
          recoveryTicket: body.deviceRecovery.recoveryTicket,
          assertion: body.deviceBinding,
          method: "passkey",
        });
      } else if (!nativeHandoff) {
        const deviceBindingResult = await evaluateDeviceBindingForLogin({
          request,
          user: localUser,
          authUser: passkey.user,
          assertion: body?.deviceBinding,
        });
        if (!deviceBindingResult.ok) {
          if (deviceBindingResult.recoveryRequired) {
            return response.status(200).json({
              valid: false,
              user: null,
              token: null,
              nextAction: "device_identity_reauth",
              recoveryTicket: deviceBindingResult.recoveryTicket,
              recoveryExpiresAt: deviceBindingResult.expiresAt,
              recoveryMethods: ["passkey"],
              reason: deviceBindingResult.reasonCode,
              message: "需要确认此设备的身份后才能进入工作区。",
            });
          }
          return response.status(409).json({
            valid: false,
            user: null,
            token: null,
            nextAction: "device_binding_preflight",
            reason: deviceBindingResult.reasonCode,
            message: "无法验证当前设备密钥，请重新尝试登录。",
          });
        }
      }

      await EventLogs.logEvent(
        "passkey_login_succeeded",
        safeAuditMetadata(request, {
          passkeyId: passkey.id,
          credential: credentialFingerprint(passkey.credentialId),
          deviceName: passkey.deviceName,
          deviceType: passkey.deviceType,
          deviceIdentityRecovered: Boolean(body?.deviceRecovery),
        }),
        localUser.id
      );

      if (nativeHandoff) {
        const handoffCode = issueNativeWebHandoff({
          shadowUserId: localUser.id,
          codeChallenge: nativeHandoff.codeChallenge,
          purpose: nativeHandoff.purpose,
        });
        return response.status(200).json({
          valid: true,
          user: User.filterFields(localUser),
          token: null,
          nativeHandoffCode: handoffCode,
          message: null,
        });
      }

      const sessionToken = await createUserSessionToken(localUser, {
        ...sessionTokenOptionsFromClientContext(getClientContext(request)),
        authMode: body?.deviceRecovery ? "device_recovery_passkey" : "passkey",
      });
      return response.status(200).json({
        valid: true,
        user: User.filterFields(localUser),
        token: sessionToken,
        ...(body?.deviceRecovery ? { deviceIdentityRecovered: true } : {}),
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
      return response.status(error.httpStatus || 500).json({
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
        await reconcilePasskeysForShadowUser({
          shadowUserId: user.id,
          authUserId,
          eventType: "passkey.deleted",
          changedPaths: [`passkeys.${passkey.id}`],
          payloadHint: { operation: "delete", passkeyId: passkey.id },
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
        return response.status(error.httpStatus || 500).json({
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
    algorithm: passkey.algorithm || "unknown",
    parameterSet: passkey.parameterSet || "unknown",
    keyOrigin: passkey.keyOrigin || "unknown",
    hardwareProtection: passkey.hardwareProtection || "unknown",
    transports: parseTransports(passkey.transports),
    createdAt: passkey.createdAt,
    lastUsedAt: passkey.lastUsedAt,
  };
}

function passkeyCryptoMetadata(
  publicKey,
  { credentialBackedUp = false, deviceType = "platform" } = {}
) {
  try {
    const decoded = decodeCredentialPublicKey(publicKey);
    const algorithmId = Number(decoded.get(3));
    const curveId = Number(decoded.get(-1));
    const keyType = Number(decoded.get(1));
    const algorithm = COSE_ALGORITHMS.get(algorithmId) || `COSE:${algorithmId}`;
    const parameterSet =
      COSE_PARAMETER_SETS.get(curveId) ||
      (keyType === 3 ? `RSA/${algorithm}` : `COSE-kty-${keyType}`);
    return {
      algorithm,
      parameterSet,
      keyOrigin: credentialBackedUp
        ? "synced-passkey-provider"
        : deviceType === "platform"
          ? "platform-authenticator"
          : "roaming-authenticator",
      // Registration currently requests attestationType=none. Never infer a
      // hardware guarantee merely from platform labels or AAGUID heuristics.
      hardwareProtection: "not-attested",
    };
  } catch {
    return {
      algorithm: "unknown",
      parameterSet: "unknown",
      keyOrigin: credentialBackedUp
        ? "synced-passkey-provider"
        : "unknown-authenticator",
      hardwareProtection: "not-attested",
    };
  }
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

function nativeWebHandoffFromQuery(query) {
  const state = normalizeOpaqueHandoffValue(query?.state, 32, 128);
  const codeChallenge = normalizeOpaqueHandoffValue(
    query?.code_challenge,
    43,
    128
  );
  if (query?.code_challenge_method !== "S256") {
    throw new Error("Unsupported native handoff method");
  }
  return {
    state,
    codeChallenge,
    purpose: normalizeNativeHandoffPurpose(query?.purpose),
  };
}

function nativeWebHandoffFromRequest(body) {
  if (!body?.nativeHandoff) return null;
  return {
    codeChallenge: normalizeOpaqueHandoffValue(
      body.nativeHandoff.codeChallenge,
      43,
      128
    ),
    purpose: normalizeNativeHandoffPurpose(body.nativeHandoff.purpose),
  };
}

function normalizeNativeHandoffPurpose(value) {
  const purpose = String(value || "login").trim();
  if (!["login", "zk_enroll", "sensitive_memory_reveal"].includes(purpose)) {
    throw new Error("Unsupported native handoff purpose");
  }
  return purpose;
}

function normalizeOpaqueHandoffValue(value, minLength, maxLength) {
  const normalized = String(value || "").trim();
  if (
    normalized.length < minLength ||
    normalized.length > maxLength ||
    !/^[A-Za-z0-9._~-]+$/.test(normalized)
  ) {
    throw new Error("Invalid native handoff value");
  }
  return normalized;
}

function issueNativeWebHandoff({ shadowUserId, codeChallenge, purpose }) {
  pruneNativeWebHandoffs();
  const code = crypto.randomBytes(32).toString("base64url");
  nativeWebHandoffs.set(nativeWebHandoffKey(code), {
    shadowUserId,
    codeChallenge,
    purpose: normalizeNativeHandoffPurpose(purpose),
    expiresAt: Date.now() + NATIVE_WEB_HANDOFF_TTL_MS,
  });
  return code;
}

function nativeWebHandoffKey(code) {
  return sha256Base64Url(code);
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function safeOpaqueEqual(left, right) {
  const leftData = Buffer.from(String(left));
  const rightData = Buffer.from(String(right));
  return (
    leftData.length === rightData.length &&
    crypto.timingSafeEqual(leftData, rightData)
  );
}

function pruneNativeWebHandoffs() {
  const now = Date.now();
  for (const [key, value] of nativeWebHandoffs.entries()) {
    if (value.expiresAt <= now) nativeWebHandoffs.delete(key);
  }
}

function nativeWebExchangeFailure() {
  return {
    valid: false,
    user: null,
    token: null,
    reauthToken: null,
    purpose: null,
    message: "通行密钥登录已过期，请重新验证。",
  };
}

function nativeWebPasskeyPage({ state, codeChallenge, purpose = "login" }) {
  const context = JSON.stringify({
    state,
    codeChallenge,
    purpose: normalizeNativeHandoffPurpose(purpose),
  });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Athena 通行密钥登录</title>
<style>body{margin:0;background:#f7f7f8;color:#111;font:17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}section{text-align:center}h1{font-size:24px;margin:0 0 12px}p{color:#6b6b73;margin:0;line-height:1.5}progress{width:124px;height:4px;margin-top:24px}</style></head>
<body><main><section><h1>Athena</h1><p id="status">正在请求通行密钥...</p><progress></progress></section></main>
<script>const context=${context};const status=document.getElementById("status");
const toBytes=value=>{const base=value.replace(/-/g,"+").replace(/_/g,"/");const padded=base+"=".repeat((4-base.length%4)%4);const raw=atob(padded);return Uint8Array.from(raw,c=>c.charCodeAt(0));};
const toBase64URL=value=>{const bytes=new Uint8Array(value);let raw="";bytes.forEach(byte=>raw+=String.fromCharCode(byte));return btoa(raw).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");};
const serialize=credential=>({id:credential.id,rawId:toBase64URL(credential.rawId),type:credential.type,response:{clientDataJSON:toBase64URL(credential.response.clientDataJSON),authenticatorData:toBase64URL(credential.response.authenticatorData),signature:toBase64URL(credential.response.signature),userHandle:credential.response.userHandle?toBase64URL(credential.response.userHandle):null}});
async function authenticate(){try{const optionsResponse=await fetch("/api/auth/passkeys/login/options",{method:"POST",headers:{"Content-Type":"application/json","X-Athena-Communication-Scene":"native-app-auth","Priority":"u=0, i"},body:"{}"});const optionsPayload=await optionsResponse.json();if(!optionsPayload.success)throw new Error(optionsPayload.error||"无法请求通行密钥。");const publicKey=optionsPayload.options;publicKey.challenge=toBytes(publicKey.challenge);publicKey.allowCredentials=(publicKey.allowCredentials||[]).map(item=>({...item,id:toBytes(item.id)}));status.textContent="请使用通行密钥验证";const credential=await navigator.credentials.get({publicKey});status.textContent="正在安全验证...";const verifyResponse=await fetch("/api/auth/passkeys/login/verify",{method:"POST",headers:{"Content-Type":"application/json","X-Athena-Communication-Scene":"native-app-auth","Priority":"u=0, i"},body:JSON.stringify({response:serialize(credential),nativeHandoff:{codeChallenge:context.codeChallenge,purpose:context.purpose}})});const result=await verifyResponse.json();if(!result.valid||!result.nativeHandoffCode)throw new Error(result.message||"通行密钥验证失败。");const params=new URLSearchParams({code:result.nativeHandoffCode,state:context.state});window.location.replace("athena://auth/callback?"+params.toString());}catch(error){const params=new URLSearchParams({error:"passkey_failed",state:context.state});window.location.replace("athena://auth/callback?"+params.toString());}}
authenticate();</script></body></html>`;
}

async function registrationOptionsForUser({
  user,
  authUserId,
  request,
  rpID: explicitRpID = null,
}) {
  const { origin, rpID } = passkeyRpConfig(request);
  assertSecurePasskeyOrigin(origin);
  const expectedRpID = explicitRpID || rpID;
  const existingCredentials = await authPrisma.passkeyCredential.findMany({
    where: { userId: authUserId },
    select: { credentialId: true, transports: true },
  });
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: expectedRpID,
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
  return options;
}

async function verifyAndStoreRegistration({ user, authUserId, body, request }) {
  const attestationResponse = body?.response;
  const challenge = normalizeBase64Url(
    attestationResponse?.response?.clientDataJSON
      ? challengeFromClientData(attestationResponse.response.clientDataJSON)
      : null
  );
  const challengeRecord = await consumeChallenge({
    challenge,
    type: "register",
    userId: authUserId,
  });
  if (!challengeRecord) {
    throw new Error("Passkey challenge has expired.");
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
    throw new Error("Could not verify passkey registration.");
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
  const cryptoMetadata = passkeyCryptoMetadata(credential.publicKey, {
    credentialBackedUp: Boolean(credentialBackedUp),
    deviceType,
  });
  const passkey = await authPrisma.passkeyCredential.create({
    data: {
      userId: authUserId,
      credentialId,
      publicKey: bytesToBase64Url(credential.publicKey),
      ...cryptoMetadata,
      counter: Number(credential.counter || 0),
      transports: JSON.stringify(credential.transports || []),
      deviceType,
      deviceName,
      browserName,
      platformName,
      aaguid: normalizeAaguid(aaguid),
      provider: provider.provider,
      providerName: provider.providerName,
      algorithm: cryptoMetadata.algorithm,
      parameterSet: cryptoMetadata.parameterSet,
      keyOrigin: cryptoMetadata.keyOrigin,
      hardwareProtection: cryptoMetadata.hardwareProtection,
      backedUp: Boolean(credentialBackedUp),
    },
  });
  await reconcilePasskeysForShadowUser({
    shadowUserId: user.id,
    authUserId,
    eventType: "passkey.registered",
    changedPaths: [`passkeys.${passkey.id}`],
    payloadHint: { operation: "add", passkeyId: passkey.id },
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
  return passkey;
}

function nativeRegistrationRecord(input = {}) {
  pruneNativeRegistrationHandoffs();
  const handoff = normalizeOpaqueHandoffValue(input?.handoff, 32, 256);
  const state = normalizeOpaqueHandoffValue(input?.state, 32, 128);
  const record = nativeRegistrationHandoffs.get(nativeWebHandoffKey(handoff));
  if (
    !record ||
    record.expiresAt <= Date.now() ||
    !safeOpaqueEqual(record.state, state)
  ) {
    throw new Error("Passkey registration handoff expired.");
  }
  return record;
}

function issueNativeRegistrationExchange(record) {
  const code = crypto.randomBytes(32).toString("base64url");
  nativeRegistrationExchanges.set(nativeWebHandoffKey(code), {
    shadowUserId: record.shadowUserId,
    codeChallenge: record.codeChallenge,
    expiresAt: Date.now() + NATIVE_WEB_HANDOFF_TTL_MS,
  });
  return code;
}

function pruneNativeRegistrationHandoffs() {
  const now = Date.now();
  for (const [key, value] of nativeRegistrationHandoffs.entries()) {
    if (value.expiresAt <= now) nativeRegistrationHandoffs.delete(key);
  }
  for (const [key, value] of nativeRegistrationExchanges.entries()) {
    if (value.expiresAt <= now) nativeRegistrationExchanges.delete(key);
  }
}

function nativeWebPasskeyRegistrationPage({ handoff, state }) {
  const context = JSON.stringify({ handoff, state });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Athena 添加通行密钥</title>
<style>body{margin:0;background:#f7f7f8;color:#111;font:17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}section{text-align:center}h1{font-size:24px;margin:0 0 12px}p{color:#6b6b73;margin:0;line-height:1.5}progress{width:124px;height:4px;margin-top:24px}</style></head>
<body><main><section><h1>Athena</h1><p id="status">正在准备通行密钥...</p><progress></progress></section></main>
<script>const context=${context};const status=document.getElementById("status");
const toBytes=value=>{const base=value.replace(/-/g,"+").replace(/_/g,"/");const padded=base+"=".repeat((4-base.length%4)%4);const raw=atob(padded);return Uint8Array.from(raw,c=>c.charCodeAt(0));};
const toBase64URL=value=>{const bytes=new Uint8Array(value);let raw="";bytes.forEach(byte=>raw+=String.fromCharCode(byte));return btoa(raw).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");};
const serialize=credential=>({id:credential.id,rawId:toBase64URL(credential.rawId),type:credential.type,response:{clientDataJSON:toBase64URL(credential.response.clientDataJSON),attestationObject:toBase64URL(credential.response.attestationObject),transports:credential.response.getTransports?credential.response.getTransports():[]}});
async function register(){try{const shared={handoff:context.handoff,state:context.state};const optionsResponse=await fetch("/api/auth/passkeys/native-register/options",{method:"POST",headers:{"Content-Type":"application/json","Priority":"u=0, i"},body:JSON.stringify(shared)});const payload=await optionsResponse.json();if(!payload.success)throw new Error(payload.error||"无法请求通行密钥。");const publicKey=payload.options;publicKey.challenge=toBytes(publicKey.challenge);publicKey.user={...publicKey.user,id:toBytes(publicKey.user.id)};publicKey.excludeCredentials=(publicKey.excludeCredentials||[]).map(item=>({...item,id:toBytes(item.id)}));status.textContent="请确认添加通行密钥";const credential=await navigator.credentials.create({publicKey});status.textContent="正在安全保存...";const verifyResponse=await fetch("/api/auth/passkeys/native-register/verify",{method:"POST",headers:{"Content-Type":"application/json","Priority":"u=0, i"},body:JSON.stringify({...shared,response:serialize(credential),deviceType:"platform",browserName:navigator.userAgent.includes("Safari")?"Safari":"Browser",platformName:navigator.platform||"Web"})});const result=await verifyResponse.json();if(!result.success||!result.code)throw new Error(result.error||"无法保存通行密钥。");const params=new URLSearchParams({code:result.code,state:context.state});window.location.replace("athena://auth/callback?"+params.toString());}catch(error){const params=new URLSearchParams({error:"passkey_registration_failed",state:context.state});window.location.replace("athena://auth/callback?"+params.toString());}}
register();</script></body></html>`;
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
    nativeWebHandoffFromQuery,
    nativeWebPasskeyPage,
    nativeWebPasskeyRegistrationPage,
    nativeRegistrationRecord,
    normalizeNativeHandoffPurpose,
    normalizeBase64Url,
    passkeyCryptoMetadata,
    providerMetadata,
    sanitizePasskey,
    safeOpaqueEqual,
    sha256Base64Url,
    resetRateLimits: () => {
      optionRequestsByIp.clear();
      verifyFailuresByIp.clear();
    },
    userHandleMatches,
    verifyCooldown,
  },
};
