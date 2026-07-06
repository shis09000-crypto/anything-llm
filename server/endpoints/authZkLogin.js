const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const prisma = require("../utils/prisma");
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
const { readSecret, saveSecret } = require("../utils/security");
const {
  DEFAULT_REAUTH_TTL_MS,
  issueReauthToken,
  validateReauthToken,
  consumeReauthToken,
} = require("../utils/authz/reauthTokens");

const OPAQUE_ATTEMPT_TTL_MS = 5 * 60 * 1000;
const LOCK_FAILURE_LIMIT = 5;
const LOCK_MS = 10 * 60 * 1000;
const OPAQUE_SERVER_SETUP_SETTING = "opaque_server_setup";
const TRUSTED_DEVICE_SCHEMA_ERROR =
  "可信设备数据库未初始化，请应用迁移后重启服务。";

let opaqueModule = null;
let opaqueModuleOverride = null;
let cachedOpaqueServerSetup = null;

function authZkLoginEndpoints(app) {
  app.post(
    "/auth/zk-login/reauth/password",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = await User._get({ id: response.locals.user.id });
        const { currentPassword } = reqBody(request) || {};
        if (
          !user ||
          !bcrypt.compareSync(String(currentPassword || ""), user.password)
        ) {
          await audit(request, "zk_login_reauth_failed", {
            userId: response.locals.user.id,
            reason: "password_invalid",
          });
          return response.status(401).json({
            success: false,
            error: "当前密码不正确。",
          });
        }

        return response.status(200).json({
          success: true,
          reauthToken: issueReauthToken(user.id, "password", "zk_enroll"),
        });
      } catch (error) {
        console.error("[ZK reauth password failed]", error.message);
        return response.status(500).json({
          success: false,
          error: "无法验证当前密码。",
        });
      }
    }
  );

  app.post(
    "/auth/zk-login/reauth/passkey/options",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const passkeys = await authPrisma.passkeyCredential.findMany({
          where: { userId: authUserId },
          select: { credentialId: true, transports: true },
        });
        if (passkeys.length === 0) {
          return response.status(404).json({
            success: false,
            error: "当前账号没有可用通行密钥。",
          });
        }

        const { origin, rpID } = passkeyRpConfig(request);
        assertSecurePasskeyOrigin(origin);
        const options = await generateAuthenticationOptions({
          rpID,
          userVerification: "required",
          allowCredentials: passkeys.map((passkey) => ({
            id: passkey.credentialId,
            transports: parseTransports(passkey.transports),
          })),
        });

        await rememberPasskeyChallenge({
          challenge: normalizeBase64Url(options.challenge),
          userId: authUserId,
          request,
        });

        return response.status(200).json({ success: true, options });
      } catch (error) {
        console.error("[ZK reauth passkey options failed]", error.message);
        return response.status(500).json({
          success: false,
          error: "无法启动通行密钥验证。",
        });
      }
    }
  );

  app.post(
    "/auth/zk-login/reauth/passkey/verify",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const body = reqBody(request) || {};
        const authResponse = body.response;
        const credentialId = normalizeBase64Url(authResponse?.id);
        const challenge = normalizeBase64Url(
          authResponse?.response?.clientDataJSON
            ? challengeFromClientData(authResponse.response.clientDataJSON)
            : null
        );
        const challengeRecord = await consumePasskeyChallenge({
          challenge,
          userId: authUserId,
        });
        if (!challengeRecord) {
          return response.status(400).json({
            success: false,
            error: "通行密钥验证已过期，请重试。",
          });
        }

        const passkey = await authPrisma.passkeyCredential.findFirst({
          where: { credentialId, userId: authUserId },
        });
        if (!passkey) {
          await audit(request, "zk_login_reauth_failed", {
            userId: user.id,
            reason: "passkey_unknown",
            device: fingerprint(credentialId),
          });
          return response.status(401).json({
            success: false,
            error: "无法验证通行密钥。",
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
          await audit(request, "zk_login_reauth_failed", {
            userId: user.id,
            reason: "passkey_verify_failed",
            device: fingerprint(credentialId),
          });
          return response.status(401).json({
            success: false,
            error: "无法验证通行密钥。",
          });
        }

        await authPrisma.passkeyCredential.update({
          where: { id: passkey.id },
          data: {
            counter: Number(
              verification.authenticationInfo?.newCounter ?? passkey.counter
            ),
            lastUsedAt: new Date(),
          },
        });

        return response.status(200).json({
          success: true,
          reauthToken: issueReauthToken(user.id, "passkey", "zk_enroll"),
        });
      } catch (error) {
        console.error("[ZK reauth passkey verify failed]", error.message);
        return response.status(400).json({
          success: false,
          error: "无法验证通行密钥。",
        });
      }
    }
  );

  app.post(
    "/system/user/memory/reauth/passkey/options",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const passkeys = await authPrisma.passkeyCredential.findMany({
          where: { userId: authUserId },
          select: { credentialId: true, transports: true },
        });
        if (passkeys.length === 0) {
          return response.status(404).json({
            success: false,
            error: "当前账号没有可用通行密钥。",
          });
        }

        const { origin, rpID } = passkeyRpConfig(request);
        assertSecurePasskeyOrigin(origin);
        const options = await generateAuthenticationOptions({
          rpID,
          userVerification: "required",
          allowCredentials: passkeys.map((passkey) => ({
            id: passkey.credentialId,
            transports: parseTransports(passkey.transports),
          })),
        });

        await rememberPasskeyChallenge({
          challenge: normalizeBase64Url(options.challenge),
          userId: authUserId,
          request,
        });

        return response.status(200).json({ success: true, options });
      } catch (error) {
        console.error(
          "[Sensitive memory reauth passkey options failed]",
          error.message
        );
        return response.status(500).json({
          success: false,
          error: "无法启动通行密钥验证。",
        });
      }
    }
  );

  app.post(
    "/system/user/memory/reauth/passkey/verify",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const body = reqBody(request) || {};
        const authResponse = body.response;
        const credentialId = normalizeBase64Url(authResponse?.id);
        const challenge = normalizeBase64Url(
          authResponse?.response?.clientDataJSON
            ? challengeFromClientData(authResponse.response.clientDataJSON)
            : null
        );
        const challengeRecord = await consumePasskeyChallenge({
          challenge,
          userId: authUserId,
        });
        if (!challengeRecord) {
          return response.status(400).json({
            success: false,
            error: "通行密钥验证已过期，请重试。",
          });
        }

        const passkey = await authPrisma.passkeyCredential.findFirst({
          where: { credentialId, userId: authUserId },
        });
        if (!passkey) {
          await audit(request, "sensitive_memory_reauth_failed", {
            userId: user.id,
            reason: "passkey_unknown",
            device: fingerprint(credentialId),
          });
          return response.status(401).json({
            success: false,
            error: "无法验证通行密钥。",
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
          await audit(request, "sensitive_memory_reauth_failed", {
            userId: user.id,
            reason: "passkey_verify_failed",
            device: fingerprint(credentialId),
          });
          return response.status(401).json({
            success: false,
            error: "无法验证通行密钥。",
          });
        }

        await authPrisma.passkeyCredential.update({
          where: { id: passkey.id },
          data: {
            counter: Number(
              verification.authenticationInfo?.newCounter ?? passkey.counter
            ),
            lastUsedAt: new Date(),
          },
        });

        return response.status(200).json({
          success: true,
          reauthToken: issueReauthToken(
            user.id,
            "passkey",
            "sensitive_memory_reveal"
          ),
        });
      } catch (error) {
        console.error(
          "[Sensitive memory reauth passkey verify failed]",
          error.message
        );
        return response.status(400).json({
          success: false,
          error: "无法验证通行密钥。",
        });
      }
    }
  );

  app.post(
    "/auth/zk-login/enroll/start",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const body = reqBody(request) || {};
        const reauth = validateReauthToken(
          body.reauthToken,
          user.id,
          "zk_enroll"
        );
        if (!reauth) {
          return response.status(401).json({
            success: false,
            error: "请先完成安全验证。",
          });
        }

        const opaque = await opaqueApi();
        const serverSetup = await opaqueServerSetup();
        const deviceId = normalizeDeviceId(body.deviceId);
        const registrationRequest = normalizeOpaqueMessage(
          body.registrationRequest
        );
        if (!deviceId || !registrationRequest) {
          return response.status(400).json({
            success: false,
            error: "设备注册请求无效。",
          });
        }

        const { registrationResponse } =
          opaque.server.createRegistrationResponse({
            serverSetup,
            userIdentifier: zkUserIdentifier(authUserId, deviceId),
            registrationRequest,
          });

        return response.status(200).json({
          success: true,
          registrationResponse,
        });
      } catch (error) {
        console.error("[ZK enroll start failed]", error.message);
        return response.status(500).json({
          success: false,
          error: zkUnavailableError(error),
        });
      }
    }
  );

  app.post(
    "/auth/zk-login/enroll/finish",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const body = reqBody(request) || {};
        const reauth = validateReauthToken(
          body.reauthToken,
          user.id,
          "zk_enroll"
        );
        if (!reauth) {
          return response.status(401).json({
            success: false,
            error: "请先完成安全验证。",
          });
        }

        const deviceId = normalizeDeviceId(body.deviceId);
        const registrationRecord = normalizeOpaqueMessage(
          body.registrationRecord
        );
        if (!deviceId || !registrationRecord) {
          return response.status(400).json({
            success: false,
            error: "设备注册记录无效。",
          });
        }

        consumeReauthToken(body.reauthToken);
        const device = await authPrisma.trustedLoginDevice.upsert({
          where: { userId_deviceId: { userId: authUserId, deviceId } },
          create: {
            userId: authUserId,
            deviceId,
            deviceName: normalizeDeviceName(body.deviceName),
            verifier: "opaque-v1",
            publicCommitment: "opaque-v1",
            opaqueRegistrationRecord: registrationRecord,
            deviceSalt: normalizeDisplay(body.deviceSalt, 160),
          },
          update: {
            deviceName: normalizeDeviceName(body.deviceName),
            verifier: "opaque-v1",
            publicCommitment: "opaque-v1",
            opaqueRegistrationRecord: registrationRecord,
            deviceSalt: normalizeDisplay(body.deviceSalt, 160),
            failureCount: 0,
            lockedUntil: null,
            revokedAt: null,
          },
        });

        await audit(request, "zk_login_device_enrolled", {
          userId: authUserId,
          device: fingerprint(deviceId),
          method: reauth.method,
        });

        return response.status(200).json({
          success: true,
          device: sanitizeTrustedDevice(device),
        });
      } catch (error) {
        if (isTrustedDeviceSchemaError(error)) {
          return response.status(500).json({
            success: false,
            error: TRUSTED_DEVICE_SCHEMA_ERROR,
          });
        }
        console.error("[ZK enroll finish failed]", error.message);
        return response.status(500).json({
          success: false,
          error: "无法启用可信设备快速登录。",
        });
      }
    }
  );

  app.post("/auth/zk-login/login/start", async (request, response) => {
    try {
      if (!(await SystemSettings.isMultiUserMode())) {
        return response.status(404).json({ success: false });
      }

      await cleanupExpiredAttempts();
      const body = reqBody(request) || {};
      const requestedUserId = Number(body.userId);
      const deviceId = normalizeDeviceId(body.deviceId);
      const startLoginRequest = normalizeOpaqueMessage(body.startLoginRequest);
      if (!requestedUserId || !deviceId || !startLoginRequest) {
        return response.status(400).json({
          success: false,
          error: "快速登录请求无效。",
        });
      }

      const device = await findTrustedLoginDeviceForLogin({
        requestedUserId,
        deviceId,
      });
      if (
        !device ||
        !device.user ||
        device.user.suspended ||
        !(await AuthIdentity.canLoginInCurrentEnvAsync(device.user))
      ) {
        return response.status(200).json({
          success: false,
          error: "未找到可用的可信设备。",
        });
      }
      if (device.lockedUntil && device.lockedUntil > new Date()) {
        return response.status(423).json({
          success: false,
          error: "可信设备已暂时锁定，请稍后再试。",
          lockedUntil: device.lockedUntil,
        });
      }

      const authUserId = Number(device.userId);
      const opaque = await opaqueApi();
      const serverSetup = await opaqueServerSetup();
      const { serverLoginState, loginResponse } = opaque.server.startLogin({
        serverSetup,
        userIdentifier: zkUserIdentifier(authUserId, deviceId),
        registrationRecord: device.opaqueRegistrationRecord,
        startLoginRequest,
        identifiers: opaqueIdentifiers(deviceId),
      });
      const attemptId = crypto.randomUUID();
      await authPrisma.zkLoginAttempt.create({
        data: {
          id: attemptId,
          userId: authUserId,
          deviceId,
          serverLoginState,
          requestIp: requestIp(request),
          userAgent: request.get("user-agent") || null,
          expiresAt: new Date(Date.now() + OPAQUE_ATTEMPT_TTL_MS),
        },
      });
      await authPrisma.trustedLoginDevice.update({
        where: { id: device.id },
        data: { lastChallengeAt: new Date() },
      });

      return response.status(200).json({
        success: true,
        loginAttemptId: attemptId,
        loginResponse,
      });
    } catch (error) {
      if (isTrustedDeviceSchemaError(error)) {
        return response.status(500).json({
          success: false,
          error: TRUSTED_DEVICE_SCHEMA_ERROR,
        });
      }
      console.error("[ZK login start failed]", error.message);
      return response.status(500).json({
        success: false,
        error: zkUnavailableError(error),
      });
    }
  });

  app.post("/auth/zk-login/login/finish", async (request, response) => {
    let device = null;
    try {
      if (!(await SystemSettings.isMultiUserMode())) {
        return response.status(404).json({ valid: false });
      }

      const body = reqBody(request) || {};
      const attempt = await consumeLoginAttempt(body.loginAttemptId);
      if (!attempt) {
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "快速登录已过期，请重试。",
        });
      }

      device = await authPrisma.trustedLoginDevice.findFirst({
        where: {
          userId: attempt.userId,
          deviceId: attempt.deviceId,
          revokedAt: null,
        },
        include: { user: true },
      });
      if (
        !device ||
        !device.user ||
        device.user.suspended ||
        !(await AuthIdentity.canLoginInCurrentEnvAsync(device.user))
      ) {
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "未找到可用的可信设备。",
        });
      }

      const finishLoginRequest = normalizeOpaqueMessage(
        body.finishLoginRequest
      );
      if (!finishLoginRequest) {
        await recordDeviceFailure(request, device, "missing_finish_request");
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "快速登录验证失败。",
        });
      }

      const opaque = await opaqueApi();
      opaque.server.finishLogin({
        finishLoginRequest,
        serverLoginState: attempt.serverLoginState,
      });

      await authPrisma.trustedLoginDevice.update({
        where: { id: device.id },
        data: {
          lastUsedAt: new Date(),
          failureCount: 0,
          lockedUntil: null,
        },
      });
      await audit(request, "zk_login_succeeded", {
        userId: device.userId,
        device: fingerprint(device.deviceId),
      });

      const localUser = await AuthIdentity.ensureShadowUser(device.user);
      if (!localUser) {
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: "快速登录验证失败。",
        });
      }

      return response.status(200).json({
        valid: true,
        user: User.filterFields(localUser),
        token: issueUserSessionToken(localUser, {
          ...sessionTokenOptionsFromClientContext(getClientContext(request)),
        }),
        message: null,
      });
    } catch (error) {
      if (device) await recordDeviceFailure(request, device, "finish_failed");
      if (isTrustedDeviceSchemaError(error)) {
        return response.status(200).json({
          valid: false,
          user: null,
          token: null,
          message: TRUSTED_DEVICE_SCHEMA_ERROR,
        });
      }
      console.error("[ZK login finish failed]", error.message);
      return response.status(200).json({
        valid: false,
        user: null,
        token: null,
        message:
          "本机快速登录凭证已失效，请使用密码或通行密钥登录后重新启用快速登录。",
        resetLocalDevice: true,
      });
    }
  });

  app.get(
    "/auth/zk-login/devices",
    [validatedRequest],
    async (_request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const authUserId = await currentAuthUserId(response.locals.user);
        const devices = await authPrisma.trustedLoginDevice.findMany({
          where: {
            userId: authUserId,
            revokedAt: null,
            opaqueRegistrationRecord: { not: null },
          },
          orderBy: { createdAt: "desc" },
        });
        return response.status(200).json({
          success: true,
          devices: devices.map(sanitizeTrustedDevice),
        });
      } catch (error) {
        if (isTrustedDeviceSchemaError(error)) {
          return response.status(500).json({
            success: false,
            devices: [],
            error: TRUSTED_DEVICE_SCHEMA_ERROR,
          });
        }
        console.error("[ZK devices list failed]", error.message);
        return response.status(500).json({
          success: false,
          devices: [],
          error: "可信设备列表暂不可用。",
        });
      }
    }
  );

  app.delete(
    "/auth/zk-login/devices/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!response.locals.multiUserMode) {
          return response.status(404).json({ success: false });
        }

        const user = response.locals.user;
        const authUserId = await currentAuthUserId(user);
        const device = await authPrisma.trustedLoginDevice.findFirst({
          where: { id: Number(request.params.id), userId: authUserId },
        });
        if (!device) {
          return response.status(404).json({
            success: false,
            error: "可信设备不存在。",
          });
        }

        await authPrisma.trustedLoginDevice.update({
          where: { id: device.id },
          data: { revokedAt: new Date() },
        });
        await audit(request, "zk_login_device_deleted", {
          userId: user.id,
          device: fingerprint(device.deviceId),
        });

        return response.status(200).json({ success: true });
      } catch (error) {
        if (isTrustedDeviceSchemaError(error)) {
          return response.status(500).json({
            success: false,
            error: TRUSTED_DEVICE_SCHEMA_ERROR,
          });
        }
        console.error("[ZK device delete failed]", error.message);
        return response.status(500).json({
          success: false,
          error: "删除可信设备失败。",
        });
      }
    }
  );
}

async function opaqueApi() {
  if (opaqueModuleOverride) {
    await opaqueModuleOverride.ready;
    return opaqueModuleOverride;
  }
  if (!opaqueModule) opaqueModule = await import("@serenity-kit/opaque");
  await opaqueModule.ready;
  return opaqueModule;
}

function setOpaqueModuleOverrideForTest(module = null) {
  if (process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) return;
  opaqueModuleOverride = module;
}

async function opaqueServerSetup() {
  if (process.env.OPAQUE_SERVER_SETUP) return process.env.OPAQUE_SERVER_SETUP;
  if (cachedOpaqueServerSetup) return cachedOpaqueServerSetup;

  const storedSetup = await prisma.system_settings.findFirst({
    where: { label: OPAQUE_SERVER_SETUP_SETTING },
  });
  if (storedSetup?.value) {
    cachedOpaqueServerSetup = readSecret(storedSetup.value);
    return cachedOpaqueServerSetup;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OPAQUE_SERVER_SETUP is required in production.");
  }

  const opaque = await opaqueApi();
  cachedOpaqueServerSetup = opaque.server.createSetup();
  await prisma.system_settings.upsert({
    where: { label: OPAQUE_SERVER_SETUP_SETTING },
    update: { value: saveSecret(cachedOpaqueServerSetup) },
    create: {
      label: OPAQUE_SERVER_SETUP_SETTING,
      value: saveSecret(cachedOpaqueServerSetup),
    },
  });
  console.warn(
    "[ZK Login] Generated and stored a local OPAQUE server setup. Configure OPAQUE_SERVER_SETUP for managed production deployments."
  );
  return cachedOpaqueServerSetup;
}

function zkUnavailableError(error) {
  if (String(error?.message || "").includes("OPAQUE_SERVER_SETUP")) {
    return "零知识证明快速登录尚未配置。";
  }
  return "零知识证明快速登录暂不可用。";
}

async function rememberPasskeyChallenge({ challenge, userId, request }) {
  await authPrisma.passkeyChallenge.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
  return authPrisma.passkeyChallenge.create({
    data: {
      challenge,
      type: "zk_reauth",
      userId,
      requestIp: requestIp(request),
      userAgent: request.get("user-agent") || null,
      expiresAt: new Date(Date.now() + DEFAULT_REAUTH_TTL_MS),
    },
  });
}

async function consumePasskeyChallenge({ challenge, userId }) {
  if (!challenge) return null;
  const record = await authPrisma.passkeyChallenge.findFirst({
    where: {
      challenge,
      type: "zk_reauth",
      userId,
      expiresAt: { gt: new Date() },
    },
  });
  if (!record) return null;
  await authPrisma.passkeyChallenge.delete({ where: { id: record.id } });
  return record;
}

async function cleanupExpiredAttempts() {
  await authPrisma.zkLoginAttempt.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}

async function consumeLoginAttempt(id) {
  if (!id) return null;
  const attempt = await authPrisma.zkLoginAttempt.findFirst({
    where: {
      id: String(id),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!attempt) return null;
  await authPrisma.zkLoginAttempt.update({
    where: { id: attempt.id },
    data: { consumedAt: new Date() },
  });
  return attempt;
}

async function recordDeviceFailure(request, device, reason) {
  const failureCount = Number(device.failureCount || 0) + 1;
  const lockedUntil =
    failureCount >= LOCK_FAILURE_LIMIT ? new Date(Date.now() + LOCK_MS) : null;
  await authPrisma.trustedLoginDevice.update({
    where: { id: device.id },
    data: { failureCount, lockedUntil },
  });
  await audit(
    request,
    lockedUntil ? "zk_login_device_locked" : "zk_login_failed",
    {
      userId: device.userId,
      device: fingerprint(device.deviceId),
      reason,
      failureCount,
    }
  );
}

async function currentAuthUserId(user = null) {
  if (!user?.id) return null;
  if (user.authUserId) return user.authUserId;
  const shadow = await User._get({ id: user.id });
  if (shadow?.authUserId) return shadow.authUserId;
  const authUser = await AuthIdentity.bootstrapAuthUserFromShadow(shadow);
  return authUser?.id || null;
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
  throw new Error("Passkey reauthentication requires HTTPS outside localhost.");
}

function isLocalhost(hostname = "") {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function requestIp(request) {
  const forwarded = request.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.ip || request.socket?.remoteAddress || "unknown";
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

function parseTransports(transports) {
  if (Array.isArray(transports)) return transports;
  try {
    const parsed = JSON.parse(transports || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDeviceId(value) {
  const deviceId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) return null;
  return deviceId;
}

function normalizeOpaqueMessage(value) {
  const message = String(value || "").trim();
  if (!message || message.length > 20000) return null;
  return message;
}

function normalizeDeviceName(value) {
  return normalizeDisplay(value, 80) || "This Device";
}

async function findTrustedLoginDeviceForLogin({
  requestedUserId,
  deviceId,
} = {}) {
  const primary = await trustedLoginDeviceByUserId(requestedUserId, deviceId);
  if (primary) return primary;

  const shadow = await prisma.users.findUnique({
    where: { id: requestedUserId },
    select: { authUserId: true },
  });
  const authUserId = Number(shadow?.authUserId);
  if (
    !Number.isFinite(authUserId) ||
    authUserId <= 0 ||
    authUserId === requestedUserId
  ) {
    return null;
  }

  return trustedLoginDeviceByUserId(authUserId, deviceId);
}

function trustedLoginDeviceByUserId(userId, deviceId) {
  return authPrisma.trustedLoginDevice.findFirst({
    where: {
      userId,
      deviceId,
      revokedAt: null,
      opaqueRegistrationRecord: { not: null },
    },
    include: { user: true },
  });
}

function normalizeDisplay(value, maxLength = 80) {
  const display = String(value || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
  return display || null;
}

function zkUserIdentifier(userId, deviceId) {
  return `athena:user:${userId}:device:${deviceId}`;
}

function opaqueIdentifiers(deviceId) {
  return { client: deviceId, server: "Athena" };
}

function sanitizeTrustedDevice(device) {
  return {
    id: device.id,
    userId: device.userId,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
    lastChallengeAt: device.lastChallengeAt,
    lockedUntil: device.lockedUntil,
    revokedAt: device.revokedAt,
  };
}

async function audit(request, event, metadata = {}) {
  await EventLogs.logEvent(
    event,
    {
      reason: metadata.reason || undefined,
      method: metadata.method || undefined,
      device: metadata.device || undefined,
      failureCount: metadata.failureCount || undefined,
      ip: requestIp(request),
      userAgent: request.get("user-agent") || null,
    },
    metadata.userId || null
  );
}

function fingerprint(value) {
  if (!value) return null;
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 16);
}

function isTrustedDeviceSchemaError(error) {
  if (!["P2021", "P2022"].includes(error?.code)) return false;
  const detail = `${error?.message || ""} ${JSON.stringify(error?.meta || {})}`;
  return /TrustedLoginDevice|ZkLoginAttempt|trustedLoginDevice|zkLoginAttempt/i.test(
    detail
  );
}

module.exports = {
  authZkLoginEndpoints,
  _zkLoginTestUtils: {
    isTrustedDeviceSchemaError,
    normalizeDeviceId,
    opaqueIdentifiers,
    OPAQUE_SERVER_SETUP_SETTING,
    sanitizeTrustedDevice,
    setOpaqueModuleOverrideForTest,
    zkUserIdentifier,
  },
};
