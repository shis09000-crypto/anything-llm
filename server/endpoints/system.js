const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });
const bcrypt = require("bcryptjs");
const { viewLocalFiles, normalizePath, isWithin } = require("../utils/files");
const { purgeDocument, purgeFolder } = require("../utils/files/purgeDocument");
const { getVectorDbClass } = require("../utils/helpers");
const {
  dumpENV,
  exportProviderSettingsBackup,
  importProviderSettingsBackup,
  updateENV,
} = require("../utils/helpers/updateENV");
const {
  applyProviderSettingsUpdate,
  publicProviderCatalog,
  providerSettingsSnapshot,
} = require("../utils/providerSettingsCatalog");
const {
  reqBody,
  decodeJWT,
  userFromSession,
  multiUserMode,
  queryParams,
} = require("../utils/http");
const {
  USER_ACTION_REFRESH_THROTTLE_MS,
  createSingleUserSessionToken,
  createUserSessionToken,
  isAllowedUserActionReason,
  issueUserSessionToken,
  jwtIdleState,
  sessionTokenOptionsFromClientContext,
} = require("../utils/sessionIdle");
const {
  checkLoginAllowed,
  clearLoginSuccess,
  dummyPasswordCompare,
  normalizeIdentifier,
  recordLoginFailure,
  sendLoginRateLimited,
} = require("../utils/authLoginRateLimit");
const { handleAssetUpload, handlePfpUpload } = require("../utils/files/multer");
const { v4 } = require("uuid");
const { DataAccessCenter } = require("../utils/dataAccess");
const SystemSettings = DataAccessCenter.adminSystem;
const AuthSession = DataAccessCenter.adminSystem.authSession;
const AgentSkillWhitelist = DataAccessCenter.agentSkillWhitelist;
const ApiKey = DataAccessCenter.adminSystem.apiKey;
const AuthIdentity = DataAccessCenter.adminSystem.authIdentity;
const BrowserExtensionApiKey =
  DataAccessCenter.adminSystem.browserExtensionApiKey;
const EmailVerificationCode =
  DataAccessCenter.adminSystem.emailVerificationCode;
const EmailVerificationRateLimit =
  DataAccessCenter.adminSystem.emailVerificationRateLimit;
const SlashCommandPresets = DataAccessCenter.slashCommandPreset;
const SystemPromptVariables = DataAccessCenter.systemPromptVariable;
const TemporaryAuthToken = DataAccessCenter.adminSystem.temporaryAuthToken;
const User = DataAccessCenter.adminSystem.user;
const UserMemory = DataAccessCenter.userMemory;
const MEMORY_OWNER_REQUIRED_ERROR = UserMemory.ownerRequiredError;
const MEMORY_SCHEMA_INIT_ERROR = UserMemory.schemaInitError;
const isMemorySchemaMissingError = (error) =>
  UserMemory.isMemorySchemaMissingError(error);
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { getClientContext } = require("../utils/clientIdentity");
const {
  authSessionFingerprintFromRequest,
} = require("../utils/authz/vaultAccessGrants");
const {
  issueSensitiveSession,
  validateSensitiveSessionForRequest,
} = require("../utils/authz/sensitiveSessions");
const fs = require("fs");
const path = require("path");
const {
  getDefaultFilename,
  determineLogoFilepath,
  fetchLogo,
  validFilename,
  renameLogoFile,
  removeCustomLogo,
  LOGO_FILENAME,
  isDefaultFilename,
} = require("../utils/files/logo");
const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const { getCustomModels } = require("../utils/helpers/customModels");
const {
  WorkspaceChatRepository: WorkspaceChats,
} = require("../repositories/workspaceChatRepository");
const {
  flexUserRoleValid,
  ROLES,
  isMultiUserSetup,
} = require("../utils/middleware/multiUserProtected");
const {
  canAccessAdmin,
  LOGIN_DISABLED_ERROR,
  LOGIN_GENERIC_ERROR,
  ROLES: ACCOUNT_ROLES,
} = require("../utils/authz/accountRoles");
const { fetchPfp, determinePfpFilepath } = require("../utils/files/pfp");
const { exportChatsAsType } = require("../utils/helpers/chat/convertTo");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const { publishBroadcastEvent } = require("../utils/broadcast");
const EmbeddingBatchJob =
  DataAccessCenter.documentEmbeddingBatch.embeddingBatchJob;
const { CollectorApi } = require("../utils/collectorApi");
const {
  confirmAuthenticatedEmailVerification,
  confirmEmailPasswordReset,
  emailStatus,
  EMAIL_RECOVERY_GENERIC_RESPONSE,
  recoverAccount,
  requestAuthenticatedEmailVerification,
  requestEmailPasswordReset,
  resetPassword,
  generateRecoveryCodes,
} = require("../utils/PasswordRecovery");
const { apiErrorStatus: httpStatus } = require("../utils/http/apiError");
const {
  filterSettingsBySections,
} = require("../utils/providerSettingsBootstrap");
const { verifyPassword } = require("../utils/security/passwordCredential");

function publishUserProfileUpdatedEvent({
  request,
  user,
  changedFields = [],
  reason = "profile-updated",
} = {}) {
  if (!user?.id || !Array.isArray(changedFields) || !changedFields.length)
    return null;
  const context = getClientContext(request, { user });
  return publishBroadcastEvent({
    namespace: "user",
    type: "profile.updated",
    eventPriority: "normal",
    visibility: "user",
    scope: { userId: Number(user.id) },
    sourceClientId: context?.clientId || null,
    resource: { kind: "user-profile", id: Number(user.id) },
    payload: {
      changedFields,
      reason,
    },
    coalesceKey: `user.profile.updated:${user.id}`,
  });
}

function publishUserMemoryUpdatedEvent({
  request,
  user,
  type,
  memoryId = null,
  category = null,
  reason = null,
} = {}) {
  if (!user?.id || !type) return null;
  const context = getClientContext(request, { user });
  return publishBroadcastEvent({
    namespace: "user",
    type: `memory.${type}`,
    eventPriority: "normal",
    visibility: "user",
    scope: { userId: Number(user.id) },
    sourceClientId: context?.clientId || null,
    resource: {
      kind: "user-memory",
      id: memoryId ? Number(memoryId) : null,
    },
    payload: {
      category: category || null,
      reason: reason || `memory-${type}`,
      changedFields: ["longTermMemory"],
    },
    coalesceKey: `user.memory.${type}:${user.id}:${memoryId || "profile"}`,
  });
}

const {
  isConfigured: emailSmtpConfigured,
  maskedEmail,
  sendVerificationCode,
} = require("../utils/email/mailer");
const { AccountDeletionService } = require("../utils/accountDeletion");
const {
  issueReauthToken,
  validateReauthToken,
  consumeReauthToken,
} = require("../utils/authz/reauthTokens");
const {
  chatHistoryViewable,
} = require("../utils/middleware/chatHistoryViewable");
const {
  simpleSSOEnabled,
  simpleSSOLoginDisabled,
} = require("../utils/middleware/simpleSSOEnabled");
const {
  getGlobalPolicy,
  setGlobalPolicy,
  resolveEffectivePolicy,
  auditLog,
} = require("../utils/fileAccessPolicy");
const {
  parseNamespaceFilter,
  requiresAppleNativeAudience,
  validateUserStateInput,
  validateUserStateScope,
} = require("../utils/userStatePreferencePolicy");
const { VALID_COMMANDS } = require("../utils/chats");
const { runtimeSummary } = require("../utils/desktopRuntime");
const { submitFeedback } = require("../utils/feedback");
const {
  DEFAULT_BASE_URL: DEFAULT_ALIBABA_RERANK_BASE_URL,
  DEFAULT_MODEL: DEFAULT_ALIBABA_RERANK_MODEL,
} = require("../utils/EmbeddingRerankers/alibaba");
const {
  DEFAULT_BASE_URL: DEFAULT_ALIBABA_OCR_BASE_URL,
  DEFAULT_MODEL: DEFAULT_ALIBABA_OCR_MODEL,
} = require("../utils/OcrProviders/alibaba");
const {
  DEFAULT_BASE_URL: DEFAULT_ALIBABA_SEARCH_MODEL_BASE_URL,
  DEFAULT_MODEL: DEFAULT_ALIBABA_SEARCH_MODEL,
} = require("../utils/SearchModels/alibaba");
const DEFAULT_ALIBABA_VISION_MODEL = "qwen3-vl-flash";
const {
  diagnosticSummary,
  storagePath: environmentStoragePath,
} = require("../utils/environment");
const {
  transportSecurityStatus,
} = require("../utils/security/transportSecurity");

function respondMemoryError(response, error, status = 500) {
  if (isMemorySchemaMissingError(error)) {
    return response.status(503).json({
      success: false,
      error: MEMORY_SCHEMA_INIT_ERROR,
      code: "MEMORY_SCHEMA_NOT_READY",
    });
  }
  if (error?.message === MEMORY_OWNER_REQUIRED_ERROR) {
    return response.status(403).json({
      success: false,
      error: MEMORY_OWNER_REQUIRED_ERROR,
      code: "MEMORY_OWNER_NOT_BOUND",
    });
  }
  return response
    .status(status)
    .json({ success: false, error: error.message || "Internal server error" });
}

function boundedMemoryQueryNumber(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(Math.floor(numeric), max);
}

const PROVIDER_PRESETS = {
  SHIJIE_DEEPSEEK_ALI_V1: {
    llm: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    },
    embedder: {
      provider: "generic-openai",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "text-embedding-v4",
    },
  },
};

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

const REGISTER_PURPOSE = "register";
const REGISTER_RATE_LIMIT_PURPOSE = "public_register";
const REGISTER_GENERIC_ERROR = "无法完成注册，请检查信息后重试。";
const REGISTER_CODE_SENT = "如果该邮箱可以注册，验证码已发送，请检查邮箱。";
const REGISTER_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_IP_HOURLY_LIMIT = Number(
  process.env.PUBLIC_REGISTRATION_IP_HOURLY_LIMIT || 20
);
const REGISTER_EMAIL_HOURLY_LIMIT = Number(
  process.env.PUBLIC_REGISTRATION_EMAIL_HOURLY_LIMIT || 5
);
const REGISTER_USERNAME_HOURLY_LIMIT = Number(
  process.env.PUBLIC_REGISTRATION_USERNAME_HOURLY_LIMIT || 10
);
const registerRateBuckets = new Map();

function normalizeEmail(email = "") {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function validEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
}

function sixDigitCode() {
  const crypto = require("crypto");
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function rateLimited(bucketKey, limit) {
  const now = Date.now();
  const bucket = registerRateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    registerRateBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + REGISTER_RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  if (bucket.count >= limit) return true;
  bucket.count += 1;
  return false;
}

async function durableRegisterRateLimited({
  bucketType,
  value,
  limit,
  fallbackKey,
}) {
  if (!value) return false;
  try {
    return await EmailVerificationRateLimit.hit({
      bucketType,
      purpose: REGISTER_RATE_LIMIT_PURPOSE,
      value,
      limit,
      windowMs: REGISTER_RATE_LIMIT_WINDOW_MS,
    });
  } catch (error) {
    console.warn(
      "PUBLIC REGISTRATION RATE LIMIT FALLING BACK TO MEMORY.",
      error?.code || error?.name || "UnknownRateLimitError"
    );
    return rateLimited(fallbackKey, limit);
  }
}

async function registerRateLimited({ ip = "", email = "", username = "" }) {
  const safeIp = String(ip || "unknown").slice(0, 128);
  if (
    await durableRegisterRateLimited({
      bucketType: "ip",
      value: safeIp,
      limit: REGISTER_IP_HOURLY_LIMIT,
      fallbackKey: `register:ip:${safeIp}`,
    })
  )
    return true;
  if (
    email &&
    (await durableRegisterRateLimited({
      bucketType: "email",
      value: normalizeEmail(email),
      limit: REGISTER_EMAIL_HOURLY_LIMIT,
      fallbackKey: `register:email:${normalizeEmail(email)}`,
    }))
  )
    return true;
  if (
    username &&
    (await durableRegisterRateLimited({
      bucketType: "username",
      value: String(username).trim().toLowerCase(),
      limit: REGISTER_USERNAME_HOURLY_LIMIT,
      fallbackKey: `register:username:${String(username).trim().toLowerCase()}`,
    }))
  )
    return true;
  return false;
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

function genericRegisterFailure(response) {
  return response.status(400).json({
    success: false,
    error: REGISTER_GENERIC_ERROR,
  });
}

async function publicRegistrationAvailable(response) {
  if (!(await SystemSettings.allowPublicRegistration())) {
    response.status(403).json({
      success: false,
      error: "公开注册未开放。",
    });
    return false;
  }

  if (simpleSSOLoginDisabled()) {
    response.status(403).json({
      success: false,
      error: "账号密码注册已被管理员关闭。",
    });
    return false;
  }

  return true;
}

function usernameBaseFromEmail(email = "") {
  const localPart = String(email || "")
    .split("@")[0]
    .trim()
    .toLowerCase();
  const sanitized = localPart
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 24);

  if (sanitized.length >= 3) return sanitized;
  return `user-${v4().replace(/-/g, "").slice(0, 8)}`;
}

async function uniqueUsernameFromEmail(email = "") {
  const base = usernameBaseFromEmail(email);
  let candidate = base.slice(0, 32);
  let suffix = 0;

  while (await AuthIdentity.identityExists({ username: candidate })) {
    suffix += 1;
    const tail = `-${suffix}`;
    candidate = `${base.slice(0, Math.max(3, 32 - tail.length))}${tail}`;
    if (suffix > 999) {
      candidate = `user-${v4().replace(/-/g, "").slice(0, 12)}`;
    }
  }

  return candidate;
}

function systemEndpoints(app) {
  if (!app) return;

  app.get("/ping", (_, response) => {
    response.status(200).json({ online: true });
  });

  app.get(
    "/system/transport-security/status",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    (_, response) => {
      response.status(200).json({
        success: true,
        ...transportSecurityStatus(),
      });
    }
  );

  app.get("/auth/registration/config", async (_, response) => {
    try {
      response.status(200).json({
        success: true,
        allowPublicRegistration: await SystemSettings.allowPublicRegistration(),
      });
    } catch (e) {
      console.error(e.message, e);
      response.status(httpStatus(e)).json({
        success: false,
        allowPublicRegistration: false,
      });
    }
  });

  app.post("/auth/register/check-email", async (request, response) => {
    try {
      if (!(await publicRegistrationAvailable(response))) return;

      const { email } = reqBody(request);
      const normalizedEmail = normalizeEmail(email);

      if (
        await registerRateLimited({
          ip: request.ip,
          email: normalizedEmail,
        })
      ) {
        await EventLogs.logEvent("invite_abuse_blocked", {
          flow: "public_register_check_email",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      if (!validEmail(normalizedEmail)) {
        response.status(400).json({
          success: false,
          error: "请输入有效邮箱地址。",
        });
        return;
      }

      response.status(200).json({
        success: true,
        email: normalizedEmail,
      });
    } catch (e) {
      console.error(e.message, e);
      response
        .status(httpStatus(e))
        .json({ success: false, error: REGISTER_GENERIC_ERROR });
    }
  });

  app.post("/auth/register/request-code", async (request, response) => {
    try {
      if (!(await publicRegistrationAvailable(response))) return;

      const { email } = reqBody(request);
      const normalizedEmail = normalizeEmail(email);
      const generic = {
        success: true,
        message: REGISTER_CODE_SENT,
        resendCooldownSeconds: Math.ceil(
          EmailVerificationCode.resendCooldownMs / 1000
        ),
        challengeId: v4(),
      };

      if (
        await registerRateLimited({
          ip: request.ip,
          email: normalizedEmail,
        })
      ) {
        await EventLogs.logEvent("invite_abuse_blocked", {
          flow: "public_register_code",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        response.status(429).json({
          success: false,
          error: "验证码请求过于频繁，请稍后再试。",
        });
        return;
      }

      if (!validEmail(normalizedEmail)) {
        response.status(400).json({
          success: false,
          error: "请输入有效邮箱地址。",
        });
        return;
      }

      const existing = await AuthIdentity.identityExists({
        email: normalizedEmail,
      });
      if (existing) {
        await EventLogs.logEvent("register_code_suppressed", {
          reason: "duplicate_identity",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        response.status(200).json(generic);
        return;
      }

      if (!emailSmtpConfigured()) {
        response.status(503).json({
          success: false,
          error: "邮件服务未配置，请联系管理员。",
        });
        return;
      }

      const latest = await EmailVerificationCode.latest({
        userId: null,
        email: normalizedEmail,
        purpose: REGISTER_PURPOSE,
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

      const code = sixDigitCode();
      const clientContext = getClientContext(request);
      await EmailVerificationCode.expireOpenCodes({
        userId: null,
        email: normalizedEmail,
        purpose: REGISTER_PURPOSE,
      });
      const { verification, error } = await EmailVerificationCode.create({
        userId: null,
        email: normalizedEmail,
        purpose: REGISTER_PURPOSE,
        code,
        requestIp: request.ip || "Unknown IP",
        clientId:
          clientContext.clientId !== "legacy" ? clientContext.clientId : null,
        deviceId:
          clientContext.clientId !== "legacy" ? clientContext.clientId : null,
      });
      if (error) {
        response.status(500).json({
          success: false,
          error: "无法创建验证码，请稍后重试。",
        });
        return;
      }

      try {
        await sendVerificationCode({
          to: normalizedEmail,
          code,
          purpose: REGISTER_PURPOSE,
          language: requestLanguage(request),
          securityContext: emailSecurityContext(request, clientContext),
        });
      } catch (error) {
        await EmailVerificationCode.consume(verification.id);
        console.error("FAILED TO SEND REGISTRATION CODE.", error.message);
        response.status(httpStatus(error)).json({
          success: false,
          error: "验证码邮件发送失败，请稍后重试或联系管理员。",
        });
        return;
      }

      response.status(200).json({
        ...generic,
        challengeId: verification.challenge_id || generic.challengeId,
      });
    } catch (e) {
      console.error(e.message, e);
      response
        .status(httpStatus(e))
        .json({ success: false, error: REGISTER_GENERIC_ERROR });
    }
  });

  app.post("/auth/register/verify-code", async (request, response) => {
    try {
      if (!(await publicRegistrationAvailable(response))) return;

      const { email, code, challengeId } = reqBody(request);
      const normalizedEmail = normalizeEmail(email);

      if (
        await registerRateLimited({
          ip: request.ip,
          email: normalizedEmail,
        })
      ) {
        await EventLogs.logEvent("invite_abuse_blocked", {
          flow: "public_register_verify_code",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      if (!validEmail(normalizedEmail) || !codeIsSixDigits(code)) {
        return genericRegisterFailure(response);
      }

      const existing = await AuthIdentity.identityExists({
        email: normalizedEmail,
      });
      if (existing) {
        await EventLogs.logEvent("register_failed", {
          reason: "duplicate_identity",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      const verification = challengeId
        ? await EmailVerificationCode.findByChallenge({
            challengeId,
            userId: null,
            email: normalizedEmail,
            purpose: REGISTER_PURPOSE,
          })
        : await EmailVerificationCode.latest({
            userId: null,
            email: normalizedEmail,
            purpose: REGISTER_PURPOSE,
          });
      const clientContext = getClientContext(request);

      if (
        !verification ||
        !verificationClientMatches(verification, clientContext) ||
        verification.consumedAt ||
        verification.expiresAt < new Date() ||
        verification.attempts >= EmailVerificationCode.maxAttempts
      ) {
        await EventLogs.logEvent("register_failed", {
          reason: "invalid_code_state",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      if (
        !EmailVerificationCode.verifyCode(String(code), verification.code_hash)
      ) {
        await EmailVerificationCode.incrementAttempts(verification.id);
        await EventLogs.logEvent("register_failed", {
          reason: "code_mismatch",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      response.status(200).json({
        success: true,
        email: normalizedEmail,
        challengeId: verification.challenge_id || null,
      });
    } catch (e) {
      console.error(e.message, e);
      response
        .status(httpStatus(e))
        .json({ success: false, error: REGISTER_GENERIC_ERROR });
    }
  });

  app.post("/auth/register", async (request, response) => {
    try {
      if (!(await publicRegistrationAvailable(response))) return;

      const { email, code, challengeId, username, password, confirmPassword } =
        reqBody(request);
      const normalizedEmail = normalizeEmail(email);
      const normalizedUsername = String(username || "").trim();

      if (
        await registerRateLimited({
          ip: request.ip,
          email: normalizedEmail,
          username: normalizedUsername,
        })
      ) {
        await EventLogs.logEvent("invite_abuse_blocked", {
          flow: "public_register_finish",
          email: maskedEmail(normalizedEmail),
          username: normalizedUsername || null,
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      if (
        !validEmail(normalizedEmail) ||
        !codeIsSixDigits(code) ||
        String(password || "") !== String(confirmPassword || "")
      ) {
        await EventLogs.logEvent("register_failed", {
          reason: "invalid_input",
          email: maskedEmail(normalizedEmail),
          username: normalizedUsername || null,
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      const existingEmail = await AuthIdentity.identityExists({
        email: normalizedEmail,
      });
      if (existingEmail) {
        await EventLogs.logEvent("register_failed", {
          reason: "duplicate_identity",
          email: maskedEmail(normalizedEmail),
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      const verification = challengeId
        ? await EmailVerificationCode.findByChallenge({
            challengeId,
            userId: null,
            email: normalizedEmail,
            purpose: REGISTER_PURPOSE,
          })
        : await EmailVerificationCode.latest({
            userId: null,
            email: normalizedEmail,
            purpose: REGISTER_PURPOSE,
          });
      const clientContext = getClientContext(request);
      if (
        !verification ||
        !verificationClientMatches(verification, clientContext) ||
        verification.consumedAt ||
        verification.expiresAt < new Date() ||
        verification.attempts >= EmailVerificationCode.maxAttempts
      ) {
        await EventLogs.logEvent("register_failed", {
          reason: "invalid_code_state",
          email: maskedEmail(normalizedEmail),
          username: normalizedUsername || null,
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      if (
        !EmailVerificationCode.verifyCode(String(code), verification.code_hash)
      ) {
        await EmailVerificationCode.incrementAttempts(verification.id);
        await EventLogs.logEvent("register_failed", {
          reason: "code_mismatch",
          email: maskedEmail(normalizedEmail),
          username: normalizedUsername || null,
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      const consumed = await EmailVerificationCode.consume(verification.id);
      if (!consumed) return genericRegisterFailure(response);

      const accountName =
        normalizedUsername || (await uniqueUsernameFromEmail(normalizedEmail));
      try {
        User.validations.username(accountName);
      } catch {
        await EventLogs.logEvent("register_failed", {
          reason: "invalid_username",
          email: maskedEmail(normalizedEmail),
          username: accountName || null,
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      const existingUsername = await AuthIdentity.identityExists({
        username: accountName,
      });
      if (existingUsername) {
        await EventLogs.logEvent("register_failed", {
          reason: "duplicate_username",
          email: maskedEmail(normalizedEmail),
          username: accountName,
          ip: request.ip || "Unknown IP",
        });
        return genericRegisterFailure(response);
      }

      const { user, error } = await User.create({
        username: accountName,
        password,
        role: ACCOUNT_ROLES.user,
        originEnv: "production",
        allowedEnvs: ["production"],
        email: normalizedEmail,
        emailVerifiedAt: new Date(),
      });
      if (!user) {
        await EventLogs.logEvent("register_failed", {
          reason: "create_failed",
          email: maskedEmail(normalizedEmail),
          username: normalizedUsername || null,
          ip: request.ip || "Unknown IP",
          result: error || null,
        });
        return genericRegisterFailure(response);
      }

      await EventLogs.logEvent(
        "user_registered",
        {
          method: "public_register",
          username: user.username,
          email: maskedEmail(normalizedEmail),
          role: ACCOUNT_ROLES.user,
          ip: request.ip || "Unknown IP",
        },
        user.id
      );

      const recoveryCodes = await generateRecoveryCodes(user.id);
      const authUser = user.authUserId
        ? await AuthIdentity.findById(user.authUserId)
        : null;
      const sessionToken = (await AuthIdentity.canLoginInCurrentEnvAsync(
        authUser
      ))
        ? await createUserSessionToken(user, {
            ...sessionTokenOptionsFromClientContext(getClientContext(request)),
            authMode: "password",
          })
        : null;
      response.status(200).json({
        success: true,
        valid: Boolean(sessionToken),
        user,
        token: sessionToken,
        message: sessionToken ? null : LOGIN_GENERIC_ERROR,
        recoveryCodes,
      });
    } catch (e) {
      console.error(e.message, e);
      response
        .status(httpStatus(e))
        .json({ success: false, error: REGISTER_GENERIC_ERROR });
    }
  });

  app.get("/system/environment", async (_, response) => {
    try {
      const summary = diagnosticSummary();
      response.status(200).json({
        success: true,
        environment: {
          appEnv: summary.appEnv,
          nodeEnv: summary.nodeEnv,
          vectorStore: {
            provider: summary.vectorStore.provider,
            namespacePrefix: summary.vectorStore.namespacePrefix,
          },
        },
      });
    } catch (e) {
      console.error(e.message, e);
      response.status(httpStatus(e)).json({ success: false, error: e.message });
    }
  });

  app.get("/migrate", async (_, response) => {
    response.sendStatus(200);
  });

  app.get(
    "/system/file-access-policy",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const sessionMode = request.query?.sessionMode || null;
        const globalPolicy = await getGlobalPolicy();
        const effectivePolicy = await resolveEffectivePolicy({
          globalPolicy,
          sessionMode,
          user,
        });
        const canModifyGlobal =
          !multiUserMode(response) || canAccessAdmin(user);
        const auditLogs = canModifyGlobal
          ? await EventLogs.where(
              { event: { startsWith: "file_access_" } },
              20,
              { occurredAt: "desc" }
            )
          : [];

        response.status(200).json({
          success: true,
          policy: {
            defaultMode: globalPolicy.defaultMode,
            effectiveMode: effectivePolicy.mode,
            authorizedDirectories: effectivePolicy.authorizedDirectories,
            openBlacklist: globalPolicy.openBlacklist,
            canUseTerminal: effectivePolicy.mode === "open",
            canModifyGlobal,
            auditLogs,
          },
        });
      } catch (e) {
        console.error(e.message, e);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.patch(
    "/system/file-access-policy",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const updates = reqBody(request);
        if (updates.defaultMode === "open" && updates.confirmOpen !== true) {
          response.status(400).json({
            success: false,
            error: "Open mode requires explicit confirmation.",
            reason: "approval_required",
          });
          return;
        }

        const result = await setGlobalPolicy(updates, user);
        response.status(result.success ? 200 : 400).json(result);
      } catch (e) {
        console.error(e.message, e);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    "/system/file-access-policy/session-event",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const {
          mode,
          workspaceSlug = null,
          threadSlug = null,
        } = reqBody(request);
        await auditLog("file_access_session_mode_changed", {
          user,
          mode,
          metadata: { workspaceSlug, threadSlug },
        });
        response.status(200).json({ success: true });
      } catch (e) {
        console.error(e.message, e);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.get("/env-dump", async (_, response) => {
    if (process.env.NODE_ENV !== "production")
      return response.sendStatus(200).end();
    dumpENV();
    response.sendStatus(200).end();
  });

  app.get("/onboarding", async (_, response) => {
    try {
      const results = await SystemSettings.isOnboardingComplete();
      response.status(200).json({ onboardingComplete: results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(httpStatus(e)).end();
    }
  });

  app.post("/onboarding", [validatedRequest], async (_, response) => {
    try {
      await SystemSettings.markOnboardingComplete();
      response.sendStatus(200).end();
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(httpStatus(e)).end();
    }
  });

  app.get("/setup-complete", async (_, response) => {
    try {
      const results = await SystemSettings.currentSettings();
      response.status(200).json({ results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(httpStatus(e)).end();
    }
  });

  app.get(
    "/system/settings/bootstrap",
    [validatedRequest],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const sections = String(query.sections || "system")
          .split(",")
          .map((section) => section.trim())
          .filter(Boolean);
        const results =
          await SystemSettings.currentSettingsForSections(sections);
        const settings = filterSettingsBySections(results, sections);
        const user = await userFromSession(request, response).catch(() => null);
        response.status(200).json({
          success: true,
          sections,
          full: sections.includes("system") || sections.includes("all"),
          settings,
          user: user
            ? {
                id: user.id,
                username: user.username,
                role: user.role,
                email: user.email || null,
              }
            : null,
          version: results?.LastUpdatedAt || results?.lastUpdatedAt || null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/check-token",
    [validatedRequest],
    async (request, response) => {
      try {
        if (multiUserMode(response)) {
          const user = await userFromSession(request, response);
          if (!user || user.suspended) {
            response.sendStatus(403).end();
            return;
          }

          const idleState = jwtIdleState(decodeJWT(bearerToken(request)));
          response.status(200).json({
            valid: true,
            legacyTokenUpgraded: false,
            idleExpiresAt: idleState.idleExpiresAt,
            idleRemainingMs: idleState.idleRemainingMs,
          });
          return;
        }

        if (response.locals.legacySingleUserToken && AuthSession.enabled()) {
          const token = await createSingleUserSessionToken({
            ...sessionTokenOptionsFromClientContext(getClientContext(request)),
            authMode: "password",
          });
          const session = await AuthSession.validate(decodeJWT(token).sid, {
            authoritative: true,
            subjectType: "instance",
          });
          response.status(200).json({
            valid: true,
            token,
            legacyTokenUpgraded: true,
            idleExpiresAt:
              session.session?.idleExpiresAt?.toISOString() || null,
          });
          return;
        }

        const session = response.locals.authSession;
        response.status(200).json({
          valid: true,
          legacyTokenUpgraded: false,
          idleExpiresAt: session?.idleExpiresAt?.toISOString() || null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.post("/system/logout", [validatedRequest], async (request, response) => {
    try {
      const decoded = decodeJWT(bearerToken(request));
      const sessionId = decoded.sid || decoded.sessionId;
      if (sessionId) await AuthSession.revoke(sessionId, "logout");
      response.status(200).json({ success: true });
    } catch (error) {
      console.error(error.message, error);
      response
        .status(httpStatus(error))
        .json({ success: false, error: error.message });
    }
  });

  app.get(
    "/system/sessions",
    [validatedRequest],
    async (_request, response) => {
      try {
        const current = response.locals.authSession;
        if (!current || !AuthSession.enabled()) {
          return response.status(503).json({
            success: false,
            error: "session_v2_unavailable",
          });
        }
        const sessions = await AuthSession.listForSubject({
          subjectType: current.subjectType,
          authUserId: current.authUserId,
          currentSessionId: current.sessionId,
        });
        return response.status(200).json({
          success: true,
          currentSessionId: current.sessionId,
          sessions,
        });
      } catch (error) {
        console.error(error.message, error);
        return response.status(httpStatus(error)).json({
          success: false,
          error: "session_list_failed",
        });
      }
    }
  );

  app.post(
    "/system/sessions/revoke",
    [validatedRequest],
    async (request, response) => {
      try {
        const current = response.locals.authSession;
        const { sessionId } = reqBody(request) || {};
        if (!current || !AuthSession.enabled()) {
          return response.status(503).json({
            success: false,
            error: "session_v2_unavailable",
          });
        }
        if (!sessionId) {
          return response.status(400).json({
            success: false,
            error: "session_id_required",
          });
        }
        const result = await AuthSession.revokeForSubject({
          subjectType: current.subjectType,
          authUserId: current.authUserId,
          sessionId,
          reason: "user_session_revoked",
        });
        return response.status(200).json({
          success: true,
          revoked: result.count,
          currentSessionRevoked: String(sessionId) === current.sessionId,
        });
      } catch (error) {
        console.error(error.message, error);
        return response.status(httpStatus(error)).json({
          success: false,
          error: "session_revoke_failed",
        });
      }
    }
  );

  app.post(
    "/system/sessions/revoke-others",
    [validatedRequest],
    async (_request, response) => {
      try {
        const current = response.locals.authSession;
        if (!current || !AuthSession.enabled()) {
          return response.status(503).json({
            success: false,
            error: "session_v2_unavailable",
          });
        }
        const result = await AuthSession.revokeOthersForSubject({
          subjectType: current.subjectType,
          authUserId: current.authUserId,
          currentSessionId: current.sessionId,
          reason: "user_revoked_other_sessions",
        });
        return response.status(200).json({
          success: true,
          revoked: result.count,
        });
      } catch (error) {
        console.error(error.message, error);
        return response.status(httpStatus(error)).json({
          success: false,
          error: "session_revoke_failed",
        });
      }
    }
  );

  app.post(
    "/system/sessions/revoke-all",
    [validatedRequest],
    async (_request, response) => {
      try {
        const current = response.locals.authSession;
        if (!current || !AuthSession.enabled()) {
          return response.status(503).json({
            success: false,
            error: "session_v2_unavailable",
          });
        }
        const result = await AuthSession.revokeAllForSubject({
          subjectType: current.subjectType,
          authUserId: current.authUserId,
          reason: "user_revoked_all_sessions",
        });
        return response.status(200).json({
          success: true,
          revoked: result.count,
          currentSessionRevoked: result.count > 0,
        });
      } catch (error) {
        console.error(error.message, error);
        return response.status(httpStatus(error)).json({
          success: false,
          error: "session_revoke_failed",
        });
      }
    }
  );

  app.post(
    "/system/user-action",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!multiUserMode(response)) {
          response.status(404).json({ success: false });
          return;
        }

        const user = await userFromSession(request, response);
        if (!user || user.suspended) {
          response.status(403).json({ success: false });
          return;
        }

        const { reason } = reqBody(request) || {};
        if (!isAllowedUserActionReason(reason)) {
          response.status(400).json({
            success: false,
            error: "Invalid user action reason.",
          });
          return;
        }

        const currentToken = bearerToken(request);
        const decodedToken = decodeJWT(currentToken);
        const currentState = jwtIdleState(decodedToken);
        const now = Date.now();
        const throttled =
          now - Number(currentState.lastUserActionAt || 0) <
          USER_ACTION_REFRESH_THROTTLE_MS;
        const lastUserActionAt = throttled
          ? currentState.lastUserActionAt
          : now;
        const nextState = jwtIdleState({ lastUserActionAt });
        if (!throttled && decodedToken.sid)
          await AuthSession.touchUserAction(decodedToken.sid);
        const nextToken = throttled
          ? null
          : decodedToken.sid
            ? issueUserSessionToken(user, {
                lastUserActionAt,
                ...sessionTokenOptionsFromClientContext(
                  getClientContext(request),
                  decodedToken
                ),
                sessionId: decodedToken.sid,
                tokenVersion: decodedToken.tokenVersion || 1,
                authMode: decodedToken.authMode || "password",
                persistedSession: true,
              })
            : await createUserSessionToken(user, {
                lastUserActionAt,
                ...sessionTokenOptionsFromClientContext(
                  getClientContext(request),
                  decodedToken
                ),
                authMode: "legacy-upgrade",
              });

        response.status(200).json({
          success: true,
          token: nextToken,
          throttled,
          lastUserActionAt,
          idleExpiresAt: nextState.idleExpiresAt,
          idleRemainingMs: nextState.idleRemainingMs,
        });
      } catch (e) {
        console.error(e.message, e);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  /**
   * Refreshes the user object from the session from a provided token.
   * This does not refresh the token itself - if that is expired or invalid, the user will be logged out.
   * This simply keeps the user object in sync with the database over the course of the session.
   * @returns {Promise<{success: boolean, user: Object | null, message: string | null}>}
   */
  app.get(
    "/system/refresh-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!multiUserMode(response))
          return response
            .status(200)
            .json({ success: true, user: null, message: null });

        const user = await userFromSession(request, response);
        if (!user)
          return response.status(200).json({
            success: false,
            user: null,
            message: "Session expired or invalid.",
          });

        if (user.suspended)
          return response.status(200).json({
            success: false,
            user: null,
            message: "User is suspended.",
          });

        return response.status(200).json({
          success: true,
          user: User.filterFields(user),
          message: null,
        });
      } catch (e) {
        return response.status(httpStatus(e)).json({
          success: false,
          user: null,
          message: e.message,
        });
      }
    }
  );

  app.post("/request-token", async (request, response) => {
    try {
      if (await SystemSettings.isMultiUserMode()) {
        if (simpleSSOLoginDisabled()) {
          response.status(403).json({
            user: null,
            valid: false,
            token: null,
            message:
              "[005] Login via credentials has been disabled by the administrator.",
          });
          return;
        }

        const { identifier, username, password } = reqBody(request);
        const loginIdentifier = String(identifier || username || "").trim();
        const loginContext = {
          ip: request.ip || "Unknown IP",
          identifier: normalizeIdentifier(loginIdentifier),
        };
        const rateLimit = await checkLoginAllowed(loginContext);
        if (!rateLimit.allowed)
          return sendLoginRateLimited(response, rateLimit.retryAfterSeconds);
        const authUser =
          await AuthIdentity.findByLoginIdentifier(loginIdentifier);

        if (!authUser) {
          await dummyPasswordCompare(password);
          const failureLimit = await recordLoginFailure(loginContext);
          await EventLogs.logEvent(
            "failed_login_invalid_username",
            {
              ip: request.ip || "Unknown IP",
              username: loginIdentifier || "Unknown user",
            },
            null
          );
          if (!failureLimit.allowed)
            return sendLoginRateLimited(
              response,
              failureLimit.retryAfterSeconds
            );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: LOGIN_GENERIC_ERROR,
          });
          return;
        }

        let verifiedAuthUser = authUser;
        let passwordVerification = await verifyPassword(
          String(password),
          verifiedAuthUser.password
        );
        let passwordValid = passwordVerification.valid;
        if (passwordValid && passwordVerification.needsUpgrade) {
          verifiedAuthUser = await AuthIdentity.upgradePasswordHash(
            verifiedAuthUser,
            password
          );
          passwordVerification = {
            valid: true,
            kind: "argon2id",
            needsUpgrade: false,
          };
          await EventLogs.logEvent(
            "login_password_hash_upgraded",
            {
              ip: request.ip || "Unknown IP",
              username: loginIdentifier || "Unknown user",
              algorithm: "argon2id",
            },
            null
          );
        }
        if (!passwordValid) {
          const repaired = await AuthIdentity.repairPasswordFromLocalShadow(
            verifiedAuthUser,
            password
          );
          if (repaired?.authUser) {
            verifiedAuthUser = repaired.authUser;
            await EventLogs.logEvent(
              "login_password_hash_repaired",
              {
                ip: request.ip || "Unknown IP",
                username: loginIdentifier || "Unknown user",
                repairedFromEnv: repaired.repairedFromEnv,
              },
              null
            );
            passwordValid = (
              await verifyPassword(String(password), verifiedAuthUser.password)
            ).valid;
          }
        }

        if (!passwordValid) {
          const failureLimit = await recordLoginFailure(loginContext);
          await EventLogs.logEvent(
            "failed_login_invalid_password",
            {
              ip: request.ip || "Unknown IP",
              username: loginIdentifier || "Unknown user",
            },
            null
          );
          if (!failureLimit.allowed)
            return sendLoginRateLimited(
              response,
              failureLimit.retryAfterSeconds
            );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: LOGIN_GENERIC_ERROR,
          });
          return;
        }

        if (
          verifiedAuthUser.suspended ||
          verifiedAuthUser.status === "disabled"
        ) {
          await EventLogs.logEvent(
            "failed_login_account_suspended",
            {
              ip: request.ip || "Unknown IP",
              username: loginIdentifier || "Unknown user",
            },
            null
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: LOGIN_DISABLED_ERROR,
          });
          return;
        }

        if (!(await AuthIdentity.canLoginInCurrentEnvAsync(verifiedAuthUser))) {
          await EventLogs.logEvent(
            "failed_login_invalid_environment",
            {
              ip: request.ip || "Unknown IP",
              username: loginIdentifier || "Unknown user",
            },
            null
          );
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: LOGIN_GENERIC_ERROR,
          });
          return;
        }

        const existingUser =
          await AuthIdentity.ensureShadowUser(verifiedAuthUser);
        if (!existingUser) {
          response.status(200).json({
            user: null,
            valid: false,
            token: null,
            message: LOGIN_GENERIC_ERROR,
          });
          return;
        }

        await clearLoginSuccess(loginContext);

        await Telemetry.sendTelemetry(
          "login_event",
          { multiUserMode: false },
          existingUser?.id
        );

        await EventLogs.logEvent(
          "login_event",
          {
            ip: request.ip || "Unknown IP",
            username: existingUser.username || "Unknown user",
          },
          existingUser?.id
        );

        // Generate a session token for the user then check if they have seen the recovery codes
        // and if not, generate recovery codes and return them to the frontend.
        const sessionToken = await createUserSessionToken(existingUser, {
          ...sessionTokenOptionsFromClientContext(getClientContext(request)),
          authMode: "password",
        });
        if (!existingUser.seen_recovery_codes) {
          const plainTextCodes = await generateRecoveryCodes(existingUser.id);
          response.status(200).json({
            valid: true,
            user: User.filterFields(existingUser),
            token: sessionToken,
            message: null,
            recoveryCodes: plainTextCodes,
          });
          return;
        }

        response.status(200).json({
          valid: true,
          user: User.filterFields(existingUser),
          token: sessionToken,
          message: null,
        });
        return;
      } else {
        const { password } = reqBody(request);
        const loginContext = {
          ip: request.ip || "Unknown IP",
          identifier: "single-user",
        };
        const rateLimit = await checkLoginAllowed(loginContext);
        if (!rateLimit.allowed)
          return sendLoginRateLimited(response, rateLimit.retryAfterSeconds);
        const authTokenHash = await bcrypt.hash(process.env.AUTH_TOKEN, 10);
        if (!(await bcrypt.compare(String(password || ""), authTokenHash))) {
          const failureLimit = await recordLoginFailure(loginContext);
          await EventLogs.logEvent("failed_login_invalid_password", {
            ip: request.ip || "Unknown IP",
            multiUserMode: false,
          });
          if (!failureLimit.allowed)
            return sendLoginRateLimited(
              response,
              failureLimit.retryAfterSeconds
            );
          response.status(401).json({
            valid: false,
            token: null,
            message: "[003] Invalid password provided",
          });
          return;
        }

        await clearLoginSuccess(loginContext);

        await Telemetry.sendTelemetry("login_event", { multiUserMode: false });
        await EventLogs.logEvent("login_event", {
          ip: request.ip || "Unknown IP",
          multiUserMode: false,
        });
        response.status(200).json({
          valid: true,
          token: await createSingleUserSessionToken({
            ...sessionTokenOptionsFromClientContext(getClientContext(request)),
            authMode: "password",
          }),
          message: null,
        });
      }
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(httpStatus(e)).end();
    }
  });

  app.get(
    "/request-token/sso/simple",
    [simpleSSOEnabled],
    async (request, response) => {
      const { token: tempAuthToken } = request.query;
      const { sessionToken, token, error } = await TemporaryAuthToken.validate(
        tempAuthToken,
        {
          clientContext: getClientContext(request),
        }
      );

      if (error) {
        await EventLogs.logEvent("failed_login_invalid_temporary_auth_token", {
          ip: request.ip || "Unknown IP",
          multiUserMode: true,
        });
        return response.status(401).json({
          valid: false,
          token: null,
          message: `[001] An error occurred while validating the token: ${error}`,
        });
      }

      await Telemetry.sendTelemetry(
        "login_event",
        { multiUserMode: true },
        token.user.id
      );
      await EventLogs.logEvent(
        "login_event",
        {
          ip: request.ip || "Unknown IP",
          username: token.user.username || "Unknown user",
        },
        token.user.id
      );

      response.status(200).json({
        valid: true,
        user: User.filterFields(token.user),
        token: sessionToken,
        message: null,
      });
    }
  );

  app.post(
    "/system/recover-account",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { username, recoveryCodes } = reqBody(request);
        const { success, resetToken, error } = await recoverAccount(
          username,
          recoveryCodes
        );

        if (success) {
          response.status(200).json({ success, resetToken });
        } else {
          response.status(400).json({ success, message: error });
        }
      } catch (error) {
        console.error("Error recovering account:", error);
        response
          .status(httpStatus(error))
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/recover-account/email/request",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { username, email } = reqBody(request);
        const result = await requestEmailPasswordReset({
          username,
          email,
          language: requestLanguage(request),
          ip: request.ip,
          clientContext: getClientContext(request),
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("Error requesting email password reset:", error);
        response.status(200).json({
          success: true,
          message: EMAIL_RECOVERY_GENERIC_RESPONSE,
          challengeId: v4(),
        });
      }
    }
  );

  app.post(
    "/system/recover-account/email/confirm",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { username, email, code, challengeId } = reqBody(request);
        const { success, resetToken, error } = await confirmEmailPasswordReset({
          username,
          email,
          code,
          challengeId,
          ip: request.ip,
          clientContext: getClientContext(request),
        });

        if (success) {
          response.status(200).json({ success, resetToken });
        } else {
          response.status(400).json({ success, error });
        }
      } catch (error) {
        console.error("Error confirming email password reset:", error);
        response
          .status(httpStatus(error))
          .json({ success: false, error: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/reset-password",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { token, newPassword, confirmPassword } = reqBody(request);
        const { success, message, error } = await resetPassword(
          token,
          newPassword,
          confirmPassword
        );

        if (success) {
          response.status(200).json({ success, message });
        } else {
          response.status(400).json({ success, error: error || message });
        }
      } catch (error) {
        console.error("Error resetting password:", error);
        response
          .status(httpStatus(error))
          .json({ success: false, message: error.message });
      }
    }
  );

  app.get(
    "/system/system-vectors",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const VectorDb = getVectorDbClass();
        const vectorCount = !!query.slug
          ? await VectorDb.namespaceCount(query.slug)
          : await VectorDb.totalVectors();
        response.status(200).json({ vectorCount });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.delete(
    "/system/remove-document",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.delete(
    "/system/remove-documents",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { names } = reqBody(request);
        for await (const name of names) await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.delete(
    "/system/remove-folder",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeFolder(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/local-files",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_, response) => {
      try {
        const localFiles = await viewLocalFiles();
        response.status(200).json({ localFiles });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/document-processing-status",
    [validatedRequest],
    async (_, response) => {
      try {
        const online = await new CollectorApi().online();
        response.sendStatus(online ? 200 : 503);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/accepted-document-types",
    [validatedRequest],
    async (_, response) => {
      try {
        const types = await new CollectorApi().acceptedFileTypes();
        if (!types) {
          response.sendStatus(404).end();
          return;
        }

        response.status(200).json({ types });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.post(
    "/system/update-env",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const { newValues, error } = await updateENV(
          body,
          false,
          response?.locals?.user?.id
        );
        response.status(200).json({ newValues, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/provider-settings/llm",
    [validatedRequest],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response).catch(() => null);
        const canManage =
          !multiUserMode(response) || (user ? canAccessAdmin(user) : false);
        const settings = await SystemSettings.currentSettingsForSections([
          "llm",
        ]);
        response.set("Cache-Control", "no-store");
        response.status(200).json({
          success: true,
          canManage,
          catalog: publicProviderCatalog({ includeFields: canManage }),
          configuration: providerSettingsSnapshot(settings, { canManage }),
          version: new Date().toISOString(),
        });
      } catch (error) {
        console.error("[LLM provider settings read failed]", error.message);
        response.status(httpStatus(error)).json({
          success: false,
          error: "无法读取人工智能提供商设置。",
        });
      }
    }
  );

  app.post(
    "/system/provider-settings/llm",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response).catch(
          () => response.locals?.user || null
        );
        const body = reqBody(request);
        const result = await applyProviderSettingsUpdate({
          providerId: body?.provider,
          fields: body?.fields,
          userId: user?.id || null,
        });
        const settings = await SystemSettings.currentSettingsForSections([
          "llm",
        ]);
        const version = new Date().toISOString();
        publishBroadcastEvent({
          namespace: "system",
          type: "provider.updated",
          visibility: "user",
          scope: { userId: user?.id || null },
          resource: { kind: "llm-provider", publicId: result.provider },
          origin: {
            clientId: getClientContext(request, { user }).clientId,
            actionId: body?.sourceActionId || null,
          },
          payload: {
            provider: result.provider,
            version,
            changedFields: result.changedFields,
          },
          version,
          requiresAck: true,
        });
        response.set("Cache-Control", "no-store");
        response.status(200).json({
          success: true,
          canManage: true,
          catalog: publicProviderCatalog({ includeFields: true }),
          configuration: providerSettingsSnapshot(settings, {
            canManage: true,
          }),
          version,
        });
      } catch (error) {
        console.error("[LLM provider settings update failed]", error.message);
        response.status(400).json({
          success: false,
          error: error.message || "无法保存人工智能提供商设置。",
        });
      }
    }
  );

  app.get(
    "/system/provider-settings/export",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const includeSecrets = query.includeSecrets === "true";
        const backup = exportProviderSettingsBackup({ includeSecrets });
        response.status(200).json({
          success: true,
          backup,
        });
      } catch (e) {
        console.error(e.message);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    "/system/provider-settings/import",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const body = reqBody(request);
        const overwrite = query.overwrite === "true" || body.overwrite === true;
        const payload = body.backup || body;
        const result = importProviderSettingsBackup(payload, { overwrite });
        response.status(result.success ? 200 : 400).json(result);
      } catch (e) {
        console.error(e.message);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    "/system/provider-preset/apply",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { code = "" } = reqBody(request);
        const presetCode = String(code).trim();
        const preset = PROVIDER_PRESETS[presetCode];
        if (!preset)
          return response
            .status(200)
            .json({ success: false, error: "invalid_preset_code" });

        if (!process.env.PRESET_DEEPSEEK_API_KEY)
          return response
            .status(200)
            .json({ success: false, error: "missing_deepseek_api_key" });
        if (!process.env.PRESET_DASHSCOPE_API_KEY)
          return response
            .status(200)
            .json({ success: false, error: "missing_dashscope_api_key" });

        const { error } = await updateENV(
          {
            LLMProvider: preset.llm.provider,
            DeepSeekApiKey: process.env.PRESET_DEEPSEEK_API_KEY,
            DeepSeekModelPref: preset.llm.model,
            EmbeddingEngine: preset.embedder.provider,
            EmbeddingBasePath: preset.embedder.baseUrl,
            EmbeddingModelPref: preset.embedder.model,
            EmbeddingModelMaxChunkLength: "5000",
            GenericOpenAiEmbeddingApiKey: process.env.PRESET_DASHSCOPE_API_KEY,
            RerankProvider: "alibaba",
            RerankApiKey: process.env.PRESET_DASHSCOPE_API_KEY,
            RerankBaseUrl: DEFAULT_ALIBABA_RERANK_BASE_URL,
            RerankModelPref: DEFAULT_ALIBABA_RERANK_MODEL,
            SearchModelProvider: "alibaba",
            SearchModelApiKey: process.env.PRESET_DASHSCOPE_API_KEY,
            SearchModelBaseUrl: DEFAULT_ALIBABA_SEARCH_MODEL_BASE_URL,
            SearchModelPref: DEFAULT_ALIBABA_SEARCH_MODEL,
            ReaderOcrProvider: "alibaba",
            ReaderOcrApiKey: process.env.PRESET_DASHSCOPE_API_KEY,
            ReaderOcrBaseUrl: DEFAULT_ALIBABA_OCR_BASE_URL,
            ReaderOcrModelPref: DEFAULT_ALIBABA_OCR_MODEL,
            VisionProvider: "alibaba",
            VisionApiKey: process.env.PRESET_DASHSCOPE_API_KEY,
            VisionBaseUrl: DEFAULT_ALIBABA_OCR_BASE_URL,
            VisionModelPref: DEFAULT_ALIBABA_VISION_MODEL,
            VisionToolEnabled: "true",
          },
          false,
          response?.locals?.user?.id
        );

        if (error) return response.status(200).json({ success: false, error });

        return response.status(200).json({
          success: true,
          preset: presetCode,
          llm: {
            provider: preset.llm.provider,
            model: preset.llm.model,
            api_key_set: true,
          },
          embedder: {
            provider: preset.embedder.provider,
            base_url: preset.embedder.baseUrl,
            model: preset.embedder.model,
            api_key_set: true,
          },
          search_model: {
            provider: "alibaba",
            base_url: DEFAULT_ALIBABA_SEARCH_MODEL_BASE_URL,
            model: DEFAULT_ALIBABA_SEARCH_MODEL,
            api_key_set: true,
          },
          ocr: {
            provider: "alibaba",
            base_url: DEFAULT_ALIBABA_OCR_BASE_URL,
            model: DEFAULT_ALIBABA_OCR_MODEL,
            api_key_set: true,
          },
          vision: {
            provider: "alibaba",
            base_url: DEFAULT_ALIBABA_OCR_BASE_URL,
            model: DEFAULT_ALIBABA_VISION_MODEL,
            api_key_set: true,
            tool_enabled: true,
          },
        });
      } catch (e) {
        console.error(e.message);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    "/system/desktop-runtime",
    [validatedRequest],
    async (_, response) => {
      try {
        response.status(200).json({ success: true, runtime: runtimeSummary() });
      } catch (e) {
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    "/system/feedback/submit",
    [validatedRequest],
    async (request, response) => {
      try {
        const { reason = "", images = [] } = reqBody(request);
        await submitFeedback({ reason, images });
        await EventLogs.logEvent(
          "desktop_feedback_submitted",
          { imageCount: Array.isArray(images) ? images.length : 0 },
          response?.locals?.user?.id
        );
        response.status(200).json({ success: true });
      } catch (e) {
        console.error("[Feedback] Submit failed:", e.message);
        response.status(200).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    "/system/update-password",
    [validatedRequest],
    async (request, response) => {
      try {
        // Cannot update password in multi - user mode.
        if (multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        let error = null;
        const { usePassword, newPassword } = reqBody(request);
        if (!usePassword) {
          // Password is being disabled so directly unset everything to bypass validation.
          process.env.AUTH_TOKEN = "";
          process.env.JWT_SECRET = "";
        } else {
          error = await updateENV(
            {
              AuthToken: newPassword,
              JWTSecret: v4(),
            },
            true
          )?.error;
        }
        response.status(200).json({ success: !error, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.post(
    "/system/enable-multi-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          response.status(200).json({
            success: false,
            error: "Multi-user mode is already enabled.",
          });
          return;
        }

        const { username, password } = reqBody(request);
        const { user, error } = await User.create({
          username,
          password,
          role: ACCOUNT_ROLES.owner,
        });

        if (error || !user) {
          response.status(400).json({
            success: false,
            error: error || "Failed to enable multi-user mode.",
          });
          return;
        }

        await SystemSettings._updateSettings({
          multi_user_mode: true,
        });
        await BrowserExtensionApiKey.migrateApiKeysToMultiUser(user.id);
        await AgentSkillWhitelist.clearSingleUserWhitelist();
        await updateENV(
          {
            JWTSecret: process.env.JWT_SECRET || v4(),
          },
          true
        );
        await Telemetry.sendTelemetry("enabled_multi_user_mode", {
          multiUserMode: true,
        });
        await EventLogs.logEvent("multi_user_mode_enabled", {}, user?.id);
        response.status(200).json({ success: !!user, error });
      } catch (e) {
        await User.delete({});
        await SystemSettings._updateSettings({
          multi_user_mode: false,
        });

        console.error(e.message, e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get("/system/multi-user-mode", async (_, response) => {
    try {
      const multiUserMode = await SystemSettings.isMultiUserMode();
      response.status(200).json({ multiUserMode });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(httpStatus(e)).end();
    }
  });

  app.get("/system/logo", async function (request, response) {
    try {
      const darkMode =
        !request?.query?.theme || request?.query?.theme === "default";
      const defaultFilename = getDefaultFilename(darkMode);
      const logoPath = await determineLogoFilepath(defaultFilename);
      const { found, buffer, size, mime } = fetchLogo(logoPath);

      if (!found) {
        response.sendStatus(204).end();
        return;
      }

      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      response.writeHead(200, {
        "Access-Control-Expose-Headers":
          "Content-Disposition,X-Is-Custom-Logo,Content-Type,Content-Length",
        "Content-Type": mime || "image/png",
        "Content-Disposition": `attachment; filename=${path.basename(
          logoPath
        )}`,
        "Content-Length": size,
        "X-Is-Custom-Logo":
          currentLogoFilename !== null &&
          currentLogoFilename !== defaultFilename &&
          !isDefaultFilename(currentLogoFilename),
      });
      response.end(Buffer.from(buffer, "base64"));
      return;
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response
        .status(httpStatus(error))
        .json({ message: "Internal server error" });
    }
  });

  app.get("/system/footer-data", [validatedRequest], async (_, response) => {
    try {
      const footerData =
        (await SystemSettings.get({ label: "footer_data" }))?.value ??
        JSON.stringify([]);
      response.status(200).json({ footerData: footerData });
    } catch (error) {
      console.error("Error fetching footer data:", error);
      response
        .status(httpStatus(error))
        .json({ message: "Internal server error" });
    }
  });

  app.get("/system/support-email", [validatedRequest], async (_, response) => {
    try {
      const supportEmail =
        (
          await SystemSettings.get({
            label: "support_email",
          })
        )?.value ?? null;
      response.status(200).json({ supportEmail: supportEmail });
    } catch (error) {
      console.error("Error fetching support email:", error);
      response
        .status(httpStatus(error))
        .json({ message: "Internal server error" });
    }
  });

  // No middleware protection in order to get this on the login page
  app.get("/system/custom-app-name", async (_, response) => {
    try {
      const customAppName =
        (
          await SystemSettings.get({
            label: "custom_app_name",
          })
        )?.value ?? null;
      response.status(200).json({ customAppName: customAppName });
    } catch (error) {
      console.error("Error fetching custom app name:", error);
      response
        .status(httpStatus(error))
        .json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/pfp/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (request, response) {
      try {
        const { id } = request.params;
        if (response.locals?.user?.id !== Number(id))
          return response.sendStatus(204).end();

        const pfpPath = await determinePfpFilepath(id);
        if (!pfpPath) return response.sendStatus(204).end();

        const { found, buffer, size, mime } = fetchPfp(pfpPath);
        if (!found) return response.sendStatus(204).end();

        response.writeHead(200, {
          "Content-Type": mime || "image/png",
          "Content-Disposition": `attachment; filename=${path.basename(pfpPath)}`,
          "Content-Length": size,
        });
        response.end(Buffer.from(buffer, "base64"));
        return;
      } catch (error) {
        console.error("Error processing the logo request:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all]), handlePfpUpload],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const uploadedFileName = request.randomFileName;
        if (!uploadedFileName) {
          return response.status(400).json({ message: "File upload failed." });
        }

        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;
        if (oldPfpFilename) {
          const storagePath = environmentStoragePath("assets", "pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(userRecord.pfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: uploadedFileName,
        });
        if (success) {
          publishUserProfileUpdatedEvent({
            request,
            user,
            changedFields: ["pfpFilename"],
            reason: "avatar-uploaded",
          });
        }

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture uploaded successfully."
            : error || "Failed to update with new profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture upload:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );
  app.get(
    "/system/default-system-prompt",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (_, response) => {
      try {
        const defaultSystemPrompt = await SystemSettings.get({
          label: "default_system_prompt",
        });

        response.status(200).json({
          success: true,
          defaultSystemPrompt: SystemSettings.effectiveDefaultSystemPrompt(
            defaultSystemPrompt?.value
          ),
          saneDefaultSystemPrompt: SystemSettings.saneDefaultSystemPrompt,
        });
      } catch (error) {
        console.error("Error fetching default system prompt:", error);
        response
          .status(httpStatus(error))
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/default-system-prompt",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { defaultSystemPrompt, syncExistingWorkspaces = null } =
          reqBody(request);
        const user = await userFromSession(request, response);
        const previousDefaultSystemPrompt = await SystemSettings.get({
          label: "default_system_prompt",
        });
        const previousPrompt =
          previousDefaultSystemPrompt?.value ||
          SystemSettings.saneDefaultSystemPrompt;
        const { success, error } = await SystemSettings.updateSettings({
          default_system_prompt: defaultSystemPrompt,
        });
        if (!success)
          throw new Error(
            error.message || "Failed to update default system prompt."
          );

        const nextDefaultSystemPrompt = await SystemSettings.get({
          label: "default_system_prompt",
        });
        const nextPrompt = SystemSettings.effectiveDefaultSystemPrompt(
          nextDefaultSystemPrompt?.value
        );
        const sync =
          syncExistingWorkspaces === "defaultOnly"
            ? await SystemSettings.syncDefaultSystemPromptToWorkspaces({
                previousDefaultPrompt: previousPrompt,
                nextDefaultPrompt: nextPrompt,
                user,
              })
            : {
                enabled: false,
                synced: 0,
                skipped: 0,
                unchanged: 0,
                failed: 0,
              };

        response.status(200).json({
          success: true,
          message: "Default system prompt updated successfully.",
          defaultSystemPrompt: nextPrompt,
          sync,
        });
      } catch (error) {
        console.error("Error updating default system prompt:", error);
        response.status(httpStatus(error)).json({
          success: false,
          message: error.message || "Internal server error",
        });
      }
    }
  );

  app.delete(
    "/system/remove-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;

        if (oldPfpFilename) {
          const storagePath = environmentStoragePath("assets", "pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(oldPfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: null,
        });
        if (success) {
          publishUserProfileUpdatedEvent({
            request,
            user,
            changedFields: ["pfpFilename"],
            reason: "avatar-removed",
          });
        }

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture removed successfully."
            : error || "Failed to remove profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture removal:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-logo",
    [validatedRequest, flexUserRoleValid([ROLES.admin]), handleAssetUpload],
    async (request, response) => {
      if (!request?.file || !request?.file.originalname) {
        return response.status(400).json({ message: "No logo file provided." });
      }

      if (!validFilename(request.file.originalname)) {
        return response.status(400).json({
          message: "Invalid file name. Please choose a different file.",
        });
      }

      try {
        const newFilename = await renameLogoFile(request.file.originalname);
        const existingLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(existingLogoFilename);

        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: newFilename,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo uploaded successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo upload:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Error uploading the logo." });
      }
    }
  );

  app.get("/system/is-default-logo", async (_, response) => {
    try {
      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      const isDefaultLogo =
        !currentLogoFilename || currentLogoFilename === LOGO_FILENAME;
      response.status(200).json({ isDefaultLogo });
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response
        .status(httpStatus(error))
        .json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/remove-logo",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_request, response) => {
      try {
        const currentLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(currentLogoFilename);
        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: LOGO_FILENAME,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo removed successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo removal:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Error removing the logo." });
      }
    }
  );

  app.get("/system/api-keys", [validatedRequest], async (_, response) => {
    try {
      if (response.locals.multiUserMode) {
        return response.sendStatus(401).end();
      }

      const apiKeys = await ApiKey.where({});
      return response.status(200).json({
        apiKeys,
        error: null,
      });
    } catch (error) {
      console.error(error);
      response.status(httpStatus(error)).json({
        apiKey: null,
        error: "Could not find an API Key.",
      });
    }
  });

  app.post(
    "/system/generate-api-key",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          return response.sendStatus(401).end();
        }

        const { name = null } = reqBody(request);
        const { apiKey, error } = await ApiKey.create(null, name);
        const context = getClientContext(request);
        const sensitiveSession =
          apiKey?.id && context?.clientId && response?.locals?.user?.id
            ? issueSensitiveSession({
                userId: response.locals.user.id,
                clientId: context.clientId,
                resourceType: "api_key",
                resourceId: apiKey.id,
                ownerScope: `system:api-key:${apiKey.id}`,
                method: "generate-api-key",
                requestId:
                  request.signedRequest?.requestId || context.requestId || null,
                sessionFingerprint: authSessionFingerprintFromRequest(request),
              })
            : null;
        await EventLogs.logEvent(
          "api_key_created",
          { name: apiKey?.name },
          response?.locals?.user?.id
        );
        return response.status(200).json({
          apiKey,
          sensitiveSession,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(httpStatus(error)).json({
          apiKey: null,
          error: "Error generating api key.",
        });
      }
    }
  );

  // TODO: This endpoint is replicated in the admin endpoints file.
  // and should be consolidated to be a single endpoint with flexible role protection.
  app.delete(
    "/system/api-key/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode)
          return response.sendStatus(401).end();
        const { id } = request.params;
        if (!id || isNaN(Number(id))) return response.sendStatus(400).end();

        await ApiKey.delete({ id: Number(id) });
        await EventLogs.logEvent(
          "api_key_deleted",
          { deletedBy: response.locals?.user?.username },
          response?.locals?.user?.id
        );
        return response.status(200).end();
      } catch (error) {
        console.error(error);
        response.status(httpStatus(error)).end();
      }
    }
  );

  app.post(
    "/system/custom-models",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { provider, apiKey = null, basePath = null } = reqBody(request);
        const { models, error } = await getCustomModels(
          provider,
          apiKey,
          basePath
        );
        return response.status(200).json({
          models,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(httpStatus(error)).end();
      }
    }
  );

  app.post(
    "/system/event-logs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { offset = 0, limit = 10 } = reqBody(request);
        const logs = await EventLogs.whereWithData({}, limit, offset * limit, {
          id: "desc",
        });
        const totalLogs = await EventLogs.count();
        const hasPages = totalLogs > (offset + 1) * limit;

        response.status(200).json({ logs: logs, hasPages, totalLogs });
      } catch (e) {
        console.error(e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.post(
    "/system/embedding-batch-jobs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { limit = 50 } = reqBody(request);
        const jobs = await EmbeddingBatchJob.listWithEvents(Number(limit));
        response.status(200).json({ jobs });
      } catch (e) {
        console.error(e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.post(
    "/system/embedding-batch-jobs/:jobId/retry",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { jobId } = request.params;
        const {
          continueBatchPolling,
        } = require("../utils/DocumentEmbeddingBatch");
        const result = await continueBatchPolling(String(jobId), {
          manual: true,
        });
        response.status(200).json(result);
      } catch (e) {
        console.error(e);
        response
          .status(httpStatus(e))
          .json({ success: false, error: e.message });
      }
    }
  );

  app.delete(
    "/system/event-logs",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (_, response) => {
      try {
        await EventLogs.delete();
        await EventLogs.logEvent(
          "event_logs_cleared",
          {},
          response?.locals?.user?.id
        );
        response.json({ success: true });
      } catch (e) {
        console.error(e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.post(
    "/system/workspace-chats",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { offset = 0, limit = 20 } = reqBody(request);
        const chats = await WorkspaceChats.whereWithData(
          {},
          limit,
          offset * limit,
          { id: "desc" }
        );
        const totalChats = await WorkspaceChats.count();
        const hasPages = totalChats > (offset + 1) * limit;

        response.status(200).json({ chats: chats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.delete(
    "/system/workspace-chats/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        Number(id) === -1
          ? await WorkspaceChats.delete({}, true)
          : await WorkspaceChats.delete({ id: Number(id) });
        response.json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/export-chats",
    [chatHistoryViewable, validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { type = "jsonl", chatType = "workspace" } = request.query;
        const { contentType, data } = await exportChatsAsType(type, chatType);
        await EventLogs.logEvent(
          "exported_chats",
          {
            type,
            chatType,
          },
          response.locals.user?.id
        );
        response.setHeader("Content-Type", contentType);
        response.status(200).send(data);
      } catch (e) {
        console.error(e);
        response.sendStatus(httpStatus(e)).end();
      }
    }
  );

  app.get(
    "/system/user/memory/overview",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const overview = await UserMemory.overview(memoryOwnerId);
        response.status(200).json({
          success: true,
          overview: overview
            ? {
                id: overview.id,
                overview: overview.overview,
                version: overview.version,
                generatedAt: overview.generatedAt,
              }
            : null,
        });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e);
      }
    }
  );

  app.get(
    "/system/user/memory/blocks",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const blocks = await UserMemory.blocks(memoryOwnerId, {
          limit: request.query.limit,
          detail: request.query.detail,
        });
        response.status(200).json({ success: true, blocks });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e);
      }
    }
  );

  app.get(
    "/system/user/memory/archives",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const limit = boundedMemoryQueryNumber(request.query.limit, 50, 500);
        const offset = boundedMemoryQueryNumber(
          request.query.offset,
          0,
          50_000
        );
        const archives = await UserMemory.archives(memoryOwnerId, {
          limit,
          offset,
        });
        response.status(200).json({ success: true, archives });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e);
      }
    }
  );

  app.get(
    "/system/user/memory/sensitive",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const limit = boundedMemoryQueryNumber(request.query.limit, 100, 500);
        const offset = boundedMemoryQueryNumber(
          request.query.offset,
          0,
          50_000
        );
        const memories = await UserMemory.sensitive(memoryOwnerId, {
          limit,
          offset,
          detail: request.query.detail,
        });
        response.status(200).json({ success: true, memories });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e);
      }
    }
  );

  app.post(
    "/system/user/memory/candidates",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const body = reqBody(request);
        const isSensitive = Boolean(body?.isSensitive);
        const memory = isSensitive
          ? await UserMemory.createSensitiveMemory(memoryOwnerId, body)
          : await UserMemory.createCandidate(memoryOwnerId, body);
        publishUserMemoryUpdatedEvent({
          request,
          user: sessionUser,
          type: "created",
          memoryId: memory.id,
          category: memory.category,
          reason: isSensitive
            ? "sensitive-memory-created"
            : "memory-candidate-created",
        });
        response.status(200).json({
          success: true,
          memory: {
            id: memory.id,
            category: memory.category,
            title: isSensitive ? UserMemory.maskedText : memory.title,
            detail: isSensitive ? UserMemory.maskedText : memory.detail,
            source: memory.source,
            confidence: memory.confidence,
            isSensitive,
          },
        });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e, 400);
      }
    }
  );

  app.post(
    "/system/user/memory/rebuild",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const result = await UserMemory.rebuildUserProfile(memoryOwnerId);
        publishUserMemoryUpdatedEvent({
          request,
          user: sessionUser,
          type: "rebuilt",
          reason: "memory-profile-rebuilt",
        });
        response.status(200).json(result);
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e);
      }
    }
  );

  app.patch(
    "/system/user/memory/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const memory = await UserMemory.updateActiveMemory(
          memoryOwnerId,
          request.params.id,
          reqBody(request)
        );
        publishUserMemoryUpdatedEvent({
          request,
          user: sessionUser,
          type: "updated",
          memoryId: memory.id,
          category: memory.category,
        });
        response.status(200).json({ success: true, memory });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e, 400);
      }
    }
  );

  app.delete(
    "/system/user/memory/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const result = await UserMemory.deleteActiveMemory(
          memoryOwnerId,
          request.params.id
        );
        publishUserMemoryUpdatedEvent({
          request,
          user: sessionUser,
          type: "archived",
          memoryId: result.memory?.id || request.params.id,
          category: result.memory?.category,
        });
        response.status(200).json(result);
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e, 400);
      }
    }
  );

  app.post(
    "/system/user/memory/:id/reveal",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const memoryOwnerId =
          UserMemory.memoryOwnerIdFromSessionUser(sessionUser);
        const { currentPassword, reauthToken } = reqBody(request) || {};
        const reauth = validateReauthToken(
          reauthToken,
          sessionUser.id,
          "sensitive_memory_reveal"
        );
        const context = getClientContext(request);
        const sensitiveGrant = validateSensitiveSessionForRequest(request, {
          userId: sessionUser.id,
          clientId: context?.clientId,
          resourceType: "user_memory",
          resourceId: request.params.id,
          ownerScope: `user:${sessionUser.id}:memory`,
          heartbeat: true,
        });

        if (!reauth && !sensitiveGrant.ok) {
          const storedUser = await User._get({ id: Number(sessionUser.id) });
          if (
            !storedUser?.password ||
            !(
              await verifyPassword(
                String(currentPassword || ""),
                storedUser.password
              )
            ).valid
          ) {
            response.status(401).json({
              success: false,
              error: "当前密码不正确。",
            });
            return;
          }
        }

        const memory = await UserMemory.revealSensitive(
          memoryOwnerId,
          request.params.id
        );
        const sensitiveSession =
          !sensitiveGrant.ok && context?.clientId && sessionUser?.id
            ? issueSensitiveSession({
                userId: sessionUser.id,
                clientId: context.clientId,
                resourceType: "user_memory",
                resourceId: request.params.id,
                ownerScope: `user:${sessionUser.id}:memory`,
                method: "sensitive-memory-reveal",
                requestId:
                  request.signedRequest?.requestId ||
                  context.requestId ||
                  request.communicationRequestId ||
                  null,
                sessionFingerprint: authSessionFingerprintFromRequest(request),
              })
            : null;
        if (reauth) consumeReauthToken(reauthToken);
        response.status(200).json({ success: true, memory, sensitiveSession });
      } catch (e) {
        console.error(e);
        respondMemoryError(response, e, 400);
      }
    }
  );

  app.get(
    "/system/user/state",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        if (!sessionUser?.id) {
          response.status(401).json({ success: false, error: "unauthorized" });
          return;
        }

        const context = getClientContext(request, { user: sessionUser });
        const namespaces = parseNamespaceFilter(request.query?.namespaces);
        if (
          namespaces?.some(requiresAppleNativeAudience) &&
          !["ios", "ipad"].includes(context?.platform)
        ) {
          response
            .status(404)
            .json({ success: false, error: "state_namespace_unavailable" });
          return;
        }
        const states = await DataAccessCenter.userState.where({
          userId: sessionUser.id,
          namespaces,
        });
        response.status(200).json({ success: true, states });
      } catch (e) {
        console.error(e);
        response.status(httpStatus(e)).json({
          success: false,
          error: e.message || "Failed to load user state.",
        });
      }
    }
  );

  app.patch(
    "/system/user/state",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        if (!sessionUser?.id) {
          response.status(401).json({ success: false, error: "unauthorized" });
          return;
        }

        getClientContext(request, { user: sessionUser });
        const { states = [] } = reqBody(request) || {};
        if (!Array.isArray(states)) {
          response
            .status(400)
            .json({ success: false, error: "states_must_be_array" });
          return;
        }

        const validatedStates = [];
        for (const state of states) {
          const result = await validateUserStateInput({
            request,
            response,
            state,
          });
          if (!result.ok) {
            response
              .status(result.status || 400)
              .json({ success: false, error: result.error });
            return;
          }
          validatedStates.push(result.state);
        }

        const context = getClientContext(request, { user: sessionUser });
        const saved = await DataAccessCenter.userState.upsertMany({
          userId: sessionUser.id,
          states: validatedStates,
          syncContext: {
            originClientId: context?.clientId || null,
            mutationId: request.header("Idempotency-Key") || null,
          },
        });
        publishBroadcastEvent({
          namespace: "userState",
          type: "updated",
          eventPriority: "normal",
          visibility: "user",
          scope: { userId: sessionUser.id },
          sourceClientId: context?.clientId || null,
          resource: {
            kind: "user-state",
            id: validatedStates.map((state) => state.namespace).join(","),
          },
          payload: {
            namespaces: validatedStates.map((state) => state.namespace),
            scopes: validatedStates.map((state) => state.scope || "global"),
            count: saved.length,
          },
          audience: validatedStates.some((state) =>
            requiresAppleNativeAudience(state.namespace)
          )
            ? ["ios", "ipad"]
            : null,
          coalesceKey: `userState.updated:${sessionUser.id}`,
        });
        response.status(200).json({ success: true, states: saved });
      } catch (e) {
        console.error(e);
        if (e?.code === "state_version_conflict") {
          response.status(409).json({
            success: false,
            error: e.code,
            expectedVersion: e.expectedVersion,
            current: e.syncNode || null,
          });
          return;
        }
        response.status(httpStatus(e)).json({
          success: false,
          error: e.message || "Failed to save user state.",
        });
      }
    }
  );

  app.delete(
    "/system/user/state",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        if (!sessionUser?.id) {
          response.status(401).json({ success: false, error: "unauthorized" });
          return;
        }

        getClientContext(request, { user: sessionUser });
        const { namespace, scope = null } = reqBody(request) || {};
        const result = await validateUserStateScope({
          request,
          response,
          namespace,
          scope: scope || "global",
        });
        if (!result.ok) {
          response
            .status(result.status || 400)
            .json({ success: false, error: result.error });
          return;
        }

        const deleted = await DataAccessCenter.userState.delete({
          userId: sessionUser.id,
          namespace,
          scope,
          syncContext: {
            originClientId: getClientContext(request, { user: sessionUser })
              ?.clientId,
            mutationId: request.header("Idempotency-Key") || null,
            baseVersion: request.header("If-Match")
              ? Number(String(request.header("If-Match")).replace(/\D/g, ""))
              : null,
          },
        });
        const context = getClientContext(request, { user: sessionUser });
        publishBroadcastEvent({
          namespace: "userState",
          type: "deleted",
          eventPriority: "normal",
          visibility: "user",
          scope: { userId: sessionUser.id },
          sourceClientId: context?.clientId || null,
          resource: { kind: "user-state", id: namespace },
          payload: {
            namespace,
            scope: scope || "global",
            deletedCount: deleted.count,
          },
          audience: requiresAppleNativeAudience(namespace)
            ? ["ios", "ipad"]
            : null,
          coalesceKey: `userState.deleted:${sessionUser.id}:${namespace}:${
            scope || "global"
          }`,
        });
        response
          .status(200)
          .json({ success: true, deletedCount: deleted.count });
      } catch (e) {
        console.error(e);
        if (e?.code === "state_version_conflict") {
          response.status(409).json({
            success: false,
            error: e.code,
            expectedVersion: e.expectedVersion,
            current: e.syncNode || null,
          });
          return;
        }
        response.status(httpStatus(e)).json({
          success: false,
          error: e.message || "Failed to delete user state.",
        });
      }
    }
  );

  // Used for when a user in multi-user updates their own profile
  // from the UI.
  app.post("/system/user", [validatedRequest], async (request, response) => {
    try {
      const sessionUser = await userFromSession(request, response);
      const body = reqBody(request);
      const { displayName, password, currentPassword, bio } = body;
      const id = Number(sessionUser.id);

      if (!id) {
        response.status(400).json({ success: false, error: "Invalid user ID" });
        return;
      }

      const updates = {};
      if (Object.prototype.hasOwnProperty.call(body, "displayName"))
        updates.displayName = User.validations.displayName(displayName);
      if (Object.prototype.hasOwnProperty.call(body, "username"))
        updates.username = body.username;
      if (password) {
        if (!currentPassword) {
          response.status(400).json({
            success: false,
            error: "Current password is required to change password",
          });
          return;
        }

        const storedUser = await User._get({ id });
        if (
          !storedUser?.password ||
          !(await verifyPassword(String(currentPassword), storedUser.password))
            .valid
        ) {
          response.status(400).json({
            success: false,
            error: "Current password is incorrect",
          });
          return;
        }

        updates.password = String(password);
      }
      if (Object.prototype.hasOwnProperty.call(body, "bio"))
        updates.bio = String(bio ?? "");

      if (Object.keys(updates).length === 0) {
        response
          .status(400)
          .json({ success: false, error: "No updates provided" });
        return;
      }

      const { success, error } = await User.update(id, updates);
      if (success) {
        const changedFields = Object.keys(updates).filter(
          (field) => field !== "password"
        );
        publishUserProfileUpdatedEvent({
          request,
          user: sessionUser,
          changedFields,
          reason: "profile-updated",
        });
      }
      response.status(200).json({ success, error });
    } catch (e) {
      console.error(e);
      response
        .status(httpStatus(e))
        .json({ success: false, error: e.message || "Internal server error" });
    }
  });

  app.get(
    "/system/user/delete-preview",
    [validatedRequest],
    async (_request, response) => {
      try {
        const sessionUser = await userFromSession(_request, response);
        const preview = await AccountDeletionService.preview({
          actor: sessionUser,
          target: sessionUser,
          mode: "self",
        });
        response.status(200).json({ success: true, preview });
      } catch (error) {
        response.status(400).json({
          success: false,
          error: error.message || "无法生成删除预览。",
        });
      }
    }
  );

  app.post(
    "/system/user/delete/reauth/password",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const user = await User._get({ id: sessionUser.id });
        const { currentPassword } = reqBody(request) || {};
        if (
          !user ||
          !(await verifyPassword(String(currentPassword || ""), user.password))
            .valid
        ) {
          response.status(401).json({
            success: false,
            error: "当前密码不正确。",
          });
          return;
        }
        response.status(200).json({
          success: true,
          reauthToken: issueReauthToken(user.id, "password", "account_delete"),
        });
      } catch (error) {
        response.status(httpStatus(error)).json({
          success: false,
          error: error.message || "无法验证当前密码。",
        });
      }
    }
  );

  app.delete("/system/user", [validatedRequest], async (request, response) => {
    try {
      const sessionUser = await userFromSession(request, response);
      const { confirm, reauthToken, deletionRunId } = reqBody(request) || {};
      const result = await AccountDeletionService.execute({
        actor: sessionUser,
        target: sessionUser,
        confirm: Boolean(confirm),
        reauthToken,
        deletionRunId,
        mode: "self",
      });
      response.status(result.success ? 200 : 503).json(result);
    } catch (error) {
      response.status(httpStatus(error)).json({
        success: false,
        error: error.message || "删除账户失败。",
      });
    }
  });

  app.get(
    "/system/user/email-verification",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const result = await emailStatus(sessionUser.id);
        response.status(result.success ? 200 : 400).json(result);
      } catch (e) {
        console.error(e);
        response.status(httpStatus(e)).json({
          success: false,
          error: e.message || "Internal server error",
        });
      }
    }
  );

  app.post(
    "/system/user/email-verification/request",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const { email } = reqBody(request);
        const result = await requestAuthenticatedEmailVerification({
          userId: sessionUser.id,
          email,
          language: requestLanguage(request),
          ip: request.ip,
          clientContext: getClientContext(request, { user: sessionUser }),
        });
        response.status(result.success ? 200 : 400).json(result);
      } catch (e) {
        console.error(e);
        response.status(httpStatus(e)).json({
          success: false,
          error: e.message || "Internal server error",
        });
      }
    }
  );

  app.post(
    "/system/user/email-verification/confirm",
    [validatedRequest],
    async (request, response) => {
      try {
        const sessionUser = await userFromSession(request, response);
        const { email, code, challengeId } = reqBody(request);
        const result = await confirmAuthenticatedEmailVerification({
          userId: sessionUser.id,
          email,
          code,
          challengeId,
          ip: request.ip,
          clientContext: getClientContext(request, { user: sessionUser }),
        });
        response.status(result.success ? 200 : 400).json(result);
      } catch (e) {
        console.error(e);
        response.status(httpStatus(e)).json({
          success: false,
          error: e.message || "Internal server error",
        });
      }
    }
  );

  app.get(
    "/system/slash-command-presets",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
        response.status(200).json({ presets: userPresets });
      } catch (error) {
        console.error("Error fetching slash command presets:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (Object.keys(VALID_COMMANDS).includes(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot create a preset with a command that matches a system command",
          });
        }

        const presetData = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.create(user?.id, presetData);
        if (!preset) {
          return response
            .status(500)
            .json({ message: "Failed to create preset" });
        }
        response.status(201).json({ preset });
      } catch (error) {
        console.error("Error creating slash command preset:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slashCommandId } = request.params;
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (Object.keys(VALID_COMMANDS).includes(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot update a preset to use a command that matches a system command",
          });
        }

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response.status(404).json({ message: "Preset not found" });

        const updates = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.update(
          Number(slashCommandId),
          updates
        );
        if (!preset) return response.sendStatus(422);
        response.status(200).json({ preset: { ...ownsPreset, ...updates } });
      } catch (error) {
        console.error("Error updating slash command preset:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );

  app.delete(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slashCommandId } = request.params;
        const user = await userFromSession(request, response);

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response
            .status(403)
            .json({ message: "Failed to delete preset" });

        await SlashCommandPresets.delete(Number(slashCommandId));
        response.sendStatus(204);
      } catch (error) {
        console.error("Error deleting slash command preset:", error);
        response
          .status(httpStatus(error))
          .json({ message: "Internal server error" });
      }
    }
  );

  app.get(
    "/system/prompt-variables",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const variables = await SystemPromptVariables.getAll(user?.id);
        response.status(200).json({ variables });
      } catch (error) {
        console.error("Error fetching system prompt variables:", error);
        response.status(httpStatus(error)).json({
          success: false,
          error: `Failed to fetch system prompt variables: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/prompt-variables",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.create({
          key,
          value,
          description,
          userId: user?.id || null,
        });

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error creating system prompt variable:", error);
        response.status(httpStatus(error)).json({
          success: false,
          error: `Failed to create system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.put(
    "/system/prompt-variables/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.update(Number(id), {
          key,
          value,
          description,
        });

        if (!variable) {
          return response.status(404).json({
            success: false,
            error: "Variable not found",
          });
        }

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error updating system prompt variable:", error);
        response.status(httpStatus(error)).json({
          success: false,
          error: `Failed to update system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.delete(
    "/system/prompt-variables/:id",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const success = await SystemPromptVariables.delete(Number(id));

        if (!success) {
          return response.status(404).json({
            success: false,
            error: "System prompt variable not found or could not be deleted",
          });
        }

        response.status(200).json({
          success: true,
        });
      } catch (error) {
        console.error("Error deleting system prompt variable:", error);
        response.status(httpStatus(error)).json({
          success: false,
          error: `Failed to delete system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/validate-sql-connection",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      const { engine, connectionString } = reqBody(request);
      try {
        if (!engine || !connectionString) {
          return response.status(400).json({
            success: false,
            error: "Both engine and connection details are required.",
          });
        }

        const {
          validateConnection,
        } = require("../utils/agents/aibitat/plugins/sql-agent/SQLConnectors");
        const result = await validateConnection(engine, { connectionString });

        if (!result.success) {
          return response.status(200).json({
            success: false,
            error: `Unable to connect to ${engine}. Please verify your connection details.`,
          });
        }

        response.status(200).json(result);
      } catch (error) {
        console.error("SQL validation error:", error);
        response.status(httpStatus(error)).json({
          success: false,
          error: `Unable to connect to ${engine}. Please verify your connection details.`,
        });
      }
    }
  );
}

function bearerToken(request) {
  const auth = request.header("Authorization");
  return auth ? auth.split(" ")[1] : null;
}

module.exports = { systemEndpoints };
