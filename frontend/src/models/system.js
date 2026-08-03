import { AUTH_TIMESTAMP, fullApiUrl } from "@/utils/constants";
import {
  deleteJson,
  getJson,
  patchJson,
  postJson,
} from "@/lib/communication/apiClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
  apiErrorRaw as rawBody,
} from "@/lib/communication/apiError";
import {
  classifyDeviceBindingPreflightFailure,
  shouldPreserveLocalAuthOnFailure,
} from "@/utils/authSessionMaintenance";
import {
  BLOB_KINDS,
  requestBlob,
  requestText,
} from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";
import { baseHeaders, safeJsonParse } from "@/utils/request";
import { getAppEnvironment } from "@/utils/appEnvironment";
import { serverStateCache } from "@/utils/serverState/serverStateCache";
import { serverStateTaskBridge } from "@/utils/serverState/serverStateTaskBridge";
import DataConnector from "./dataConnector";
import LiveDocumentSync from "./experimental/liveSync";
import AgentPlugins from "./experimental/agentPlugins";
import SystemPromptVariable from "./systemPromptVariable";
import {
  ADMIN_SYSTEM_FAST_TTL_MS,
  ADMIN_SYSTEM_VERSION_TTL_MS,
  adminSystemStateStore,
} from "@/utils/serverState/adminSystemStateStore";
import { sensitiveSessionCenter } from "@/utils/sensitive/sensitiveSessionCenter";
import { setAuthToken } from "@/utils/authTokenStorage";
import { createDeviceBindingAssertion } from "@/utils/security/browserHybridKeys";

let systemKeysCache = null;
let systemKeysCacheAt = 0;
let systemKeysInflight = null;
let authBootstrapCache = null;
let authBootstrapCacheAt = 0;
let authBootstrapInflight = null;
const SYSTEM_KEYS_CACHE_TTL_MS = 30_000;
const AUTH_BOOTSTRAP_CACHE_TTL_MS = 5_000;
const SYSTEM_KEYS_TIMEOUT_MS = 20_000;
const SYSTEM_KEYS_RETRY_DELAYS_MS = [0, 750, 1_500];
const LOGO_CACHE_TTL_MS = 1000 * 60 * 10;
const ACCOUNT_AVATAR_CACHE_TTL_MS = 1000 * 60 * 10;
const CUSTOM_MODELS_CACHE_TTL_MS = 1000 * 60;
const logoCache = new Map();
const logoInflight = new Map();
const accountAvatarInflight = new Map();
const customModelsCache = new Map();
const customModelsInflight = new Map();
const LOGO_SESSION_CACHE_PREFIX = "athena_logo_cache_v1:";

function customModelsCacheKey(provider) {
  return `custom-models:${provider || "unknown"}`;
}

function logoSessionCacheKey(cacheKey) {
  try {
    return `${LOGO_SESSION_CACHE_PREFIX}${btoa(cacheKey)}`;
  } catch {
    return `${LOGO_SESSION_CACHE_PREFIX}${cacheKey}`;
  }
}

function readLogoSessionCache(cacheKey) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(logoSessionCacheKey(cacheKey));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.value !== "object" || !entry.updatedAt)
      return null;
    if (Date.now() - entry.updatedAt > LOGO_CACHE_TTL_MS) return null;
    return entry.value;
  } catch {}
  return null;
}

function writeLogoSessionCache(cacheKey, value) {
  if (typeof window === "undefined" || !value || typeof value !== "object")
    return;
  try {
    window.sessionStorage.setItem(
      logoSessionCacheKey(cacheKey),
      JSON.stringify({ value, updatedAt: Date.now() })
    );
  } catch {}
}

function clearLogoSessionCache(cacheKey) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(logoSessionCacheKey(cacheKey));
  } catch {}
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSystemKeysOnce() {
  return await getJson("/setup-complete", {
    timeoutMs: SYSTEM_KEYS_TIMEOUT_MS,
    communicationScene: "model-settings",
  }).then(({ data }) => data.results);
}

async function fetchSystemKeysWithRetry() {
  let lastError = null;
  for (const delay of SYSTEM_KEYS_RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const results = await fetchSystemKeysOnce();
      if (results) return results;
    } catch (error) {
      lastError = error;
    }
  }
  if (import.meta.env.DEV && lastError) {
    console.warn("[System.keys] setup bootstrap failed", lastError);
  }
  return null;
}

function withQuery(path, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function localizedApiError(error, fallback = "请求失败，请稍后重试。") {
  const message =
    typeof error === "string"
      ? error
      : String(
          rawBody(error)?.error ||
            rawBody(error)?.message ||
            error?.message ||
            ""
        ).trim();
  if (!message) return fallback;
  if (
    /failed to fetch/i.test(message) ||
    /networkerror/i.test(message) ||
    /load failed/i.test(message)
  ) {
    return "无法连接服务，请确认后端已启动后重试。";
  }
  if (/not found/i.test(message))
    return "服务接口不存在，请刷新或重启后端后重试。";
  return message;
}

const System = {
  cacheKeys: {
    footerIcons: "anythingllm_footer_links",
    supportEmail: "anythingllm_support_email",
    customAppName: "anythingllm_custom_app_name",
    canViewChatHistory: "anythingllm_can_view_chat_history",
    deploymentVersion: "anythingllm_deployment_version",
  },
  ping: async function () {
    return await getJson("/ping", {
      communicationScene: "app-bootstrap",
    })
      .then(({ data }) => data?.online || false)
      .catch(() => false);
  },
  authBootstrap: async function ({ force = false, signal } = {}) {
    const now = Date.now();
    if (
      !force &&
      authBootstrapCache &&
      now - authBootstrapCacheAt < AUTH_BOOTSTRAP_CACHE_TTL_MS
    ) {
      return authBootstrapCache;
    }
    if (!force && authBootstrapInflight) return authBootstrapInflight;

    const request = getJson("/auth/bootstrap", {
      headers: { "X-Athena-Web-Protocol-Version": "1" },
      includeBaseHeaders: false,
      cache: "no-store",
      timeoutMs: 8_000,
      signal,
      communicationScene: "auth-bootstrap",
    })
      .then(({ data }) => {
        if (data?.schemaVersion !== "athena.auth.bootstrap.v1") {
          throw new Error("invalid_auth_bootstrap_contract");
        }
        authBootstrapCache = data;
        authBootstrapCacheAt = Date.now();
        return data;
      })
      .finally(() => {
        if (authBootstrapInflight === request) authBootstrapInflight = null;
      });
    authBootstrapInflight = request;
    return request;
  },
  clearAuthBootstrapCache: function () {
    authBootstrapCache = null;
    authBootstrapCacheAt = 0;
    authBootstrapInflight = null;
  },
  totalIndexes: async function (slug = null) {
    const url = new URL(`${fullApiUrl()}/system/system-vectors`);
    if (!!slug) url.searchParams.append("slug", encodeURIComponent(slug));
    return await getJson(url.toString(), {
      communicationScene: slug ? "workspace-overview" : "settings-tab",
    })
      .then(({ data }) => data.vectorCount)
      .catch(() => 0);
  },
  patrolStatus: async function () {
    const cacheKey = adminSystemStateStore.keys.systemPatrolStatus;
    return await getJson("/system/patrol/status", {
      communicationScene: "system-patrol",
    })
      .then(({ data }) => {
        adminSystemStateStore.set(cacheKey, data, {
          surface: "system-patrol",
          ttlMs: ADMIN_SYSTEM_FAST_TTL_MS,
          meta: { success: data?.success === true },
        });
        return data;
      })
      .catch((e) =>
        adminSystemStateStore.getOrFallback(
          cacheKey,
          rawOrFallback(e, {
            success: false,
            error: localizedApiError(e, "无法读取系统巡查状态。"),
          }),
          { ttlMs: ADMIN_SYSTEM_FAST_TTL_MS }
        )
      );
  },
  runPatrol: async function ({ mode = "light" } = {}) {
    return await postJson(
      "/system/patrol/run",
      { mode },
      {
        communicationScene: "system-patrol-action",
      }
    )
      .then(({ data }) => {
        adminSystemStateStore.invalidate(
          adminSystemStateStore.keys.systemPatrolStatus
        );
        return data;
      })
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "系统巡查执行失败。"),
        })
      );
  },
  patrolRepairPreview: async function (repairId) {
    return await postJson(
      `/system/patrol/repairs/${repairId}/preview`,
      {},
      { communicationScene: "system-patrol-action" }
    )
      .then(({ data }) => data)
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "无法生成修复预案。"),
        })
      );
  },
  patrolRepairConfirm: async function (repairId) {
    return await postJson(
      `/system/patrol/repairs/${repairId}/confirm`,
      {},
      { communicationScene: "system-patrol-action" }
    )
      .then(({ data }) => {
        adminSystemStateStore.invalidate(
          adminSystemStateStore.keys.systemPatrolStatus
        );
        return data;
      })
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "修复执行失败。"),
        })
      );
  },

  /**
   * Checks if the onboarding is complete.
   * `null` means the server could not answer. Callers must not interpret a
   * transient outage as an incomplete installation.
   * @returns {Promise<boolean|null>}
   */
  isOnboardingComplete: async function () {
    return await getJson("/onboarding", {
      communicationScene: "onboarding",
    })
      .then(({ data }) => data.onboardingComplete)
      .catch(() => null);
  },
  /**
   * Marks the onboarding as complete.
   * @returns {Promise<boolean>}
   */
  markOnboardingComplete: async function () {
    return await postJson("/onboarding", undefined, {
      communicationScene: "onboarding",
    })
      .then(({ data }) => {
        if (data?.token) setAuthToken(data.token);
        return data?.valid !== false;
      })
      .catch(() => false);
  },
  keys: async function () {
    const now = Date.now();
    if (systemKeysCache && now - systemKeysCacheAt < SYSTEM_KEYS_CACHE_TTL_MS) {
      return systemKeysCache;
    }
    if (systemKeysInflight) return systemKeysInflight;
    systemKeysInflight = fetchSystemKeysWithRetry()
      .then((results) => {
        if (results) {
          systemKeysCache = results;
          systemKeysCacheAt = Date.now();
          return results;
        }
        return systemKeysCache;
      })
      .finally(() => {
        systemKeysInflight = null;
      });
    return await systemKeysInflight;
  },
  settingsBootstrap: async function ({
    sections = ["system"],
    signal,
    task,
    communicationScene = "model-settings",
  } = {}) {
    const query = new URLSearchParams();
    query.set("sections", sections.join(","));
    return await getJson(`/system/settings/bootstrap?${query.toString()}`, {
      signal,
      communicationScene,
      task,
    })
      .then(({ data }) => {
        const isFullSettingsPayload =
          data?.full === true ||
          sections.includes("system") ||
          sections.includes("all");
        if (data?.settings && isFullSettingsPayload) {
          systemKeysCache = data.settings;
          systemKeysCacheAt = Date.now();
        }
        return data;
      })
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { success: false, settings: null, user: null };
      });
  },
  clearSettingsCache: function () {
    systemKeysCache = null;
    systemKeysCacheAt = 0;
    systemKeysInflight = null;
  },
  localFiles: async function () {
    return await getJson("/system/local-files", {
      communicationScene: "settings-tab",
    })
      .then(({ data }) => data.localFiles)
      .catch(() => null);
  },
  needsAuthCheck: function () {
    const lastAuthCheck = window.localStorage.getItem(AUTH_TIMESTAMP);
    if (!lastAuthCheck) return true;
    const expiresAtMs = Number(lastAuthCheck) + 60 * 5 * 1000; // expires in 5 minutes in ms
    return Number(new Date()) > expiresAtMs;
  },

  checkAuth: async function (currentToken = null) {
    const valid = await getJson("/system/check-token", {
      headers: baseHeaders(currentToken),
      timeoutMs: 8_000,
      communicationScene: "auth-bootstrap",
    })
      .then(() => true)
      .catch((e) => {
        if (shouldPreserveLocalAuthOnFailure(e)) return true;
        return false;
      });

    if (valid) window.localStorage.setItem(AUTH_TIMESTAMP, Number(new Date()));
    return valid;
  },
  deviceBindingPreflight: async function () {
    let challenge;
    try {
      challenge = await postJson(
        "/auth/device-binding/preflight",
        {},
        { communicationScene: "auth-login" }
      ).then(({ data }) => data);
    } catch (error) {
      error.deviceBindingStage = "transport";
      throw error;
    }
    if (!challenge?.success) {
      const error = new Error(
        challenge?.error || "device_binding_preflight_failed"
      );
      error.deviceBindingStage = "transport";
      throw error;
    }
    try {
      return await createDeviceBindingAssertion(challenge);
    } catch (error) {
      error.deviceBindingStage = "local_crypto";
      throw error;
    }
  },
  requestToken: async function (body) {
    let requestBody = { ...body };
    try {
      requestBody.deviceBinding =
        body?.deviceBinding || (await this.deviceBindingPreflight());
    } catch (error) {
      const failure = classifyDeviceBindingPreflightFailure(error);
      return {
        valid: false,
        ...failure,
      };
    }
    return await postJson("/request-token", requestBody, {
      communicationScene: "auth-login",
    })
      .then(({ data }) => data)
      .catch((e) => {
        const status = Number(e?.status || 0);
        const serviceUnavailable = status === 0 || status >= 500;
        return {
          valid: false,
          status,
          serviceUnavailable,
          errorCode: e?.code || null,
          message: serviceUnavailable
            ? "登录服务暂时不可用，请稍后重试。"
            : responseError(e, "Could not validate login."),
        };
      });
  },
  registrationConfig: async function () {
    return await getJson("/auth/registration/config", {
      communicationScene: "auth-login",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return { success: false, allowPublicRegistration: false };
      });
  },
  requestRegistrationCode: async function ({ email }) {
    return await postJson(
      "/auth/register/request-code",
      { email },
      {
        communicationScene: "auth-login",
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: localizedApiError(e),
        });
      });
  },
  checkRegistrationEmail: async function ({ email }) {
    return await postJson(
      "/auth/register/check-email",
      { email },
      {
        communicationScene: "auth-login",
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: localizedApiError(e),
        });
      });
  },
  verifyRegistrationCode: async function ({ email, code, challengeId = "" }) {
    return await postJson(
      "/auth/register/verify-code",
      {
        email,
        code,
        challengeId,
      },
      { communicationScene: "auth-login" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: localizedApiError(e),
        });
      });
  },
  registerAccount: async function (data) {
    return await postJson("/auth/register", data, {
      communicationScene: "auth-login",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, {
          success: false,
          error: localizedApiError(e),
        });
      });
  },
  /**
   * Refreshes the user object from the session.
   * @returns {Promise<{success: boolean, user: Object | null, message: string | null}>}
   */
  refreshUser: () => {
    return getJson("/system/refresh-user", {
      communicationScene: "auth-bootstrap",
    })
      .then(({ data }) => data)
      .catch((e) => {
        return {
          success: false,
          user: null,
          message: responseError(e, "Could not refresh user."),
          status: e?.status || 0,
          code: e?.code || null,
          raw: rawBody(e),
        };
      });
  },
  recoverAccount: async function (username, recoveryCodes) {
    return await postJson(
      "/system/recover-account",
      {
        username,
        recoveryCodes,
      },
      { communicationScene: "auth-login" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return {
          success: false,
          error: responseError(e, "Error recovering account."),
        };
      });
  },
  requestEmailPasswordReset: async function (username, email) {
    return await postJson(
      "/system/recover-account/email/request",
      {
        username,
        email,
      },
      { communicationScene: "auth-login" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        const raw = rawBody(e);
        return {
          success: false,
          error:
            raw?.message || responseError(e, "Error requesting reset code."),
          errorCode: raw?.errorCode,
        };
      });
  },
  confirmEmailPasswordReset: async function (
    username,
    email,
    code,
    challengeId = ""
  ) {
    return await postJson(
      "/system/recover-account/email/confirm",
      {
        username,
        email,
        code,
        challengeId,
      },
      { communicationScene: "auth-login" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        const raw = rawBody(e);
        return {
          success: false,
          error: raw?.error || responseError(e, "Error confirming reset code."),
          errorCode: raw?.errorCode,
        };
      });
  },
  resetPassword: async function (token, newPassword, confirmPassword) {
    return await postJson(
      "/system/reset-password",
      {
        token,
        newPassword,
        confirmPassword,
      },
      { communicationScene: "auth-login" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return {
          success: false,
          error: responseError(e, "Error resetting password."),
        };
      });
  },
  emailVerificationStatus: async function () {
    return await getJson("/system/user/email-verification", {
      communicationScene: "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  requestEmailVerification: async function ({ email }) {
    return await postJson(
      "/system/user/email-verification/request",
      { email },
      { communicationScene: "account-security" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        const raw = rawBody(e);
        return {
          success: false,
          error: raw?.error || responseError(e, "Error sending code."),
          errorCode: raw?.errorCode,
        };
      });
  },
  confirmEmailVerification: async function ({ email, code, challengeId = "" }) {
    return await postJson(
      "/system/user/email-verification/confirm",
      {
        email,
        code,
        challengeId,
      },
      { communicationScene: "account-security" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        const raw = rawBody(e);
        return {
          success: false,
          error: raw?.error || responseError(e, "Error verifying code."),
          errorCode: raw?.errorCode,
        };
      });
  },

  checkDocumentProcessorOnline: async (options = {}) => {
    const cacheKey = adminSystemStateStore.keys.systemDocumentProcessor;
    return await getJson("/system/document-processing-status", {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-upload-visible",
      task: options.task,
    })
      .then(() => {
        adminSystemStateStore.set(cacheKey, true, {
          surface: "system-document-processor",
          ttlMs: ADMIN_SYSTEM_FAST_TTL_MS,
        });
        return true;
      })
      .catch(() =>
        adminSystemStateStore.getOrFallback(cacheKey, false, {
          ttlMs: ADMIN_SYSTEM_FAST_TTL_MS,
        })
      );
  },
  acceptedDocumentTypes: async () => {
    const cacheKey = adminSystemStateStore.keys.systemAcceptedDocumentTypes;
    return await getJson("/system/accepted-document-types", {
      communicationScene: "workspace-upload-visible",
    })
      .then(({ data }) => {
        const types = data?.types || null;
        if (types) {
          adminSystemStateStore.set(cacheKey, types, {
            surface: "system-accepted-document-types",
            meta: { count: Array.isArray(types) ? types.length : 0 },
          });
        }
        return types;
      })
      .catch(() => adminSystemStateStore.getOrFallback(cacheKey, null));
  },
  updateSystem: async (data, options = {}) => {
    return await postJson("/system/update-env", data, {
      signal: options.signal,
      communicationScene: options.communicationScene || "system-update-env",
      task: options.task,
    })
      .then(({ data }) => {
        System.clearSettingsCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("settings-data-invalidated", { detail: {} })
          );
        }
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { newValues: null, error: e.message });
      });
  },
  applyProviderPreset: async (code) => {
    return await postJson("/system/provider-preset/apply", { code })
      .then(({ data }) => {
        System.clearSettingsCache();
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("settings-data-invalidated", { detail: {} })
          );
        }
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  updateSystemPassword: async (data) => {
    return await postJson("/system/update-password", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  setupMultiUser: async (data) => {
    return await postJson("/system/enable-multi-user", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  isMultiUserMode: async () => {
    return await getJson("/system/multi-user-mode")
      .then(({ data }) => data?.multiUserMode)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  deleteDocument: async (name) => {
    return await deleteJson("/system/remove-document", { body: { name } })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  deleteDocuments: async (names = []) => {
    return await deleteJson("/system/remove-documents", { body: { names } })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  deleteFolder: async (name) => {
    return await deleteJson("/system/remove-folder", { body: { name } })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  uploadPfp: async function (formData, options = {}) {
    return await uploadFormData("/system/upload-pfp", formData, {
      signal: options.signal,
      task: options.task,
      uploadKind: UPLOAD_KINDS.avatar,
      communicationScene: options.communicationScene || "account-settings",
    })
      .then(() => {
        serverStateCache.invalidatePrefix("account.avatar:");
        accountAvatarInflight.clear();
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },
  uploadLogo: async function (formData, options = {}) {
    return await uploadFormData("/system/upload-logo", formData, {
      signal: options.signal,
      task: options.task,
      uploadKind: UPLOAD_KINDS.logo,
      communicationScene: options.communicationScene || "settings-tab",
    })
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },
  fetchCustomFooterIcons: async function () {
    const cache = window.localStorage.getItem(this.cacheKeys.footerIcons);
    const { data, lastFetched } = cache
      ? safeJsonParse(cache, { data: [], lastFetched: 0 })
      : { data: [], lastFetched: 0 };

    if (!!data && Date.now() - lastFetched < 3_600_000)
      return { footerData: data, error: null };

    const { footerData, error } = await getJson("/system/footer-data", {
      cache: "no-cache",
      communicationScene: "app-bootstrap",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.log(e);
        return { footerData: [], error: e.message };
      });

    if (!footerData || !!error) return { footerData: [], error: null };

    const newData = safeJsonParse(footerData, []);
    window.localStorage.setItem(
      this.cacheKeys.footerIcons,
      JSON.stringify({ data: newData, lastFetched: Date.now() })
    );
    return { footerData: newData, error: null };
  },
  fetchSupportEmail: async function () {
    const cache = window.localStorage.getItem(this.cacheKeys.supportEmail);
    const { email, lastFetched } = cache
      ? safeJsonParse(cache, { email: "", lastFetched: 0 })
      : { email: "", lastFetched: 0 };

    if (!!email && Date.now() - lastFetched < 3_600_000)
      return { email: email, error: null };

    const { supportEmail, error } = await getJson("/system/support-email", {
      cache: "no-cache",
      communicationScene: "app-bootstrap",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.log(e);
        return { email: "", error: e.message };
      });

    if (!supportEmail || !!error) return { email: "", error: null };
    window.localStorage.setItem(
      this.cacheKeys.supportEmail,
      JSON.stringify({ email: supportEmail, lastFetched: Date.now() })
    );
    return { email: supportEmail, error: null };
  },

  fetchCustomAppName: async function () {
    const cache = window.localStorage.getItem(this.cacheKeys.customAppName);
    const { appName, lastFetched } = cache
      ? safeJsonParse(cache, { appName: "", lastFetched: 0 })
      : { appName: "", lastFetched: 0 };

    if (!!appName && Date.now() - lastFetched < 3_600_000)
      return { appName: appName, error: null };

    const { customAppName, error } = await getJson("/system/custom-app-name", {
      cache: "no-cache",
      communicationScene: "app-bootstrap",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.log(e);
        return { customAppName: "", error: e.message };
      });

    if (!customAppName || !!error) {
      window.localStorage.removeItem(this.cacheKeys.customAppName);
      return { appName: "", error: null };
    }

    window.localStorage.setItem(
      this.cacheKeys.customAppName,
      JSON.stringify({ appName: customAppName, lastFetched: Date.now() })
    );
    return { appName: customAppName, error: null };
  },
  /**
   * Fetches the default system prompt from the server.
   * @returns {Promise<{defaultSystemPrompt: string, saneDefaultSystemPrompt: string}>}
   */
  fetchDefaultSystemPrompt: async function () {
    return await getJson("/system/default-system-prompt")
      .then(({ data }) => ({
        defaultSystemPrompt: data.defaultSystemPrompt,
        saneDefaultSystemPrompt: data.saneDefaultSystemPrompt,
      }))
      .catch((e) => {
        console.error(e);
        return { defaultSystemPrompt: "", saneDefaultSystemPrompt: "" };
      });
  },
  updateDefaultSystemPrompt: async function (
    defaultSystemPrompt,
    syncExistingWorkspaces = null,
    options = {}
  ) {
    try {
      const { data } = await postJson(
        "/system/default-system-prompt",
        {
          defaultSystemPrompt,
          syncExistingWorkspaces,
        },
        {
          signal: options.signal,
          task: options.task,
          communicationScene:
            options.communicationScene || "admin-system-prompt",
        }
      );
      return data;
    } catch (e) {
      console.error(e);
      return { success: false, message: e.message };
    }
  },
  fetchLogo: async function ({ force = false } = {}) {
    const url = new URL(`${fullApiUrl()}/system/logo`);
    url.searchParams.append(
      "theme",
      localStorage.getItem("theme") || "default"
    );
    const cacheKey = url.toString();
    const cached = logoCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.updatedAt < LOGO_CACHE_TTL_MS) {
      return cached.value;
    }
    const sessionCached = !force ? readLogoSessionCache(cacheKey) : null;
    if (sessionCached) {
      logoCache.set(cacheKey, { value: sessionCached, updatedAt: Date.now() });
      return sessionCached;
    }
    if (!force && logoInflight.has(cacheKey)) return logoInflight.get(cacheKey);
    if (force) clearLogoSessionCache(cacheKey);

    const request = requestBlob(url.toString(), {
      cache: force ? "reload" : "default",
      includeBaseHeaders: false,
      blobKind: BLOB_KINDS.logo,
      communicationScene: "app-bootstrap",
      task: {
        kind: "app-logo",
        priority: "P1",
        policy: "visible",
        resource: "network",
        scope: {
          route: "app-bootstrap",
          surface: "logo",
        },
        dedupeKey: `app-logo:${cacheKey}`,
      },
    })
      .then(async ({ response, blob }) => {
        if (response.status !== 204 && blob?.size) {
          const isCustomLogo =
            response.headers.get("X-Is-Custom-Logo") === "true";
          const logoURL = await blobToDataUrl(blob);
          const value = { isCustomLogo, logoURL };
          logoCache.set(cacheKey, { value, updatedAt: Date.now() });
          writeLogoSessionCache(cacheKey, value);
          return value;
        }
        const value = { isCustomLogo: false, logoURL: null };
        logoCache.set(cacheKey, { value, updatedAt: Date.now() });
        writeLogoSessionCache(cacheKey, value);
        return value;
      })
      .catch((e) => {
        console.log(e);
        return { isCustomLogo: false, logoURL: null };
      })
      .finally(() => logoInflight.delete(cacheKey));
    logoInflight.set(cacheKey, request);
    return await request;
  },
  fetchPfp: async function (id, options = {}) {
    if (!id) return null;
    const cacheKey = `account.avatar:${id}`;
    if (accountAvatarInflight.has(cacheKey)) {
      return await accountAvatarInflight.get(cacheKey);
    }
    const task = options.task || {};
    const scope = task.scope || options.scope || {};
    const requestOptions = {
      key: cacheKey,
      ttlMs: ACCOUNT_AVATAR_CACHE_TTL_MS,
      ownerScope: `${getAppEnvironment()}:account-avatar:${id}`,
      scope: {
        route: "workspace-chat",
        surface: "account-avatar",
        userId: id,
        ...scope,
      },
      priority: task.priority || options.priority || "P0",
      intentRank: task.intentRank ?? options.intentRank ?? 3,
      policy: task.policy || options.policy || "foreground",
      resource: task.resource || options.resource || "network",
      kind: task.kind || options.kind || "account-avatar",
      label: task.label || options.label || "account:avatar",
      staleWhileRevalidate: options.staleWhileRevalidate ?? true,
      dedupeKey:
        task.dedupeKey || options.dedupeKey || `server-state:${cacheKey}`,
      fetcher: async ({ signal }) => {
        const { response, blob } = await requestBlob(`/system/pfp/${id}`, {
          signal,
          cache: "default",
          blobKind: BLOB_KINDS.avatar,
          communicationScene:
            options.communicationScene || "account-avatar-current",
          task: false,
        });
        return response.status !== 204 && blob
          ? await blobToDataUrl(blob)
          : null;
      },
    };
    const request = (
      options.force
        ? serverStateTaskBridge.refresh(requestOptions)
        : serverStateTaskBridge.ensure(requestOptions)
    )
      .catch(() => {
        return null;
      })
      .finally(() => {
        if (accountAvatarInflight.get(cacheKey) === request) {
          accountAvatarInflight.delete(cacheKey);
        }
      });
    accountAvatarInflight.set(cacheKey, request);
    return await request;
  },
  removePfp: async function (options = {}) {
    return await deleteJson("/system/remove-pfp", {
      signal: options.signal,
      task: options.task,
      communicationScene: options.communicationScene || "account-settings",
    })
      .then(() => {
        serverStateCache.invalidatePrefix("account.avatar:");
        accountAvatarInflight.clear();
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },

  isDefaultLogo: async function () {
    return await getJson("/system/is-default-logo", {
      cache: "no-cache",
      communicationScene: "app-bootstrap",
    })
      .then(({ data }) => data?.isDefaultLogo)
      .catch((e) => {
        console.log(e);
        return null;
      });
  },
  removeCustomLogo: async function (options = {}) {
    return await getJson("/system/remove-logo", {
      signal: options.signal,
      task: options.task,
      communicationScene: options.communicationScene || "settings-tab",
    })
      .then(() => ({ success: true, error: null }))
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },
  getApiKeys: async function () {
    return getJson("/system/api-keys")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return {
          apiKey: null,
          error: responseError(e, "Error fetching api key."),
        };
      });
  },
  generateApiKey: async function (data = {}) {
    return postJson("/system/generate-api-key", data)
      .then(({ data }) => {
        if (data?.sensitiveSession) {
          sensitiveSessionCenter.store(data.sensitiveSession, {
            resourceType: "api_key",
            resourceId: data?.apiKey?.id || "generated",
          });
        }
        return data;
      })
      .catch((e) => {
        console.error(e);
        return {
          apiKey: null,
          error: responseError(e, "Error generating api key."),
        };
      });
  },
  deleteApiKey: async function (apiKeyId = "") {
    return deleteJson(`/system/api-key/${apiKeyId}`)
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  customModels: async function (
    provider,
    apiKey = null,
    basePath = null,
    timeout = null,
    options = {}
  ) {
    const canCache = options.cache !== false && !apiKey && !basePath;
    const cacheKey = canCache ? customModelsCacheKey(provider) : null;
    if (canCache && !options.force) {
      const cached = customModelsCache.get(cacheKey);
      if (
        cached &&
        Date.now() - cached.updatedAt <
          (options.cacheTtlMs || CUSTOM_MODELS_CACHE_TTL_MS)
      ) {
        return cached.value;
      }
      if (customModelsInflight.has(cacheKey)) {
        return await customModelsInflight.get(cacheKey);
      }
    }

    const request = postJson(
      "/system/custom-models",
      {
        provider,
        apiKey,
        basePath,
      },
      {
        timeoutMs: timeout || undefined,
        signal: options.signal,
        communicationScene: options.communicationScene || "llm-model-selector",
        task: options.task,
      }
    )
      .then(({ data }) => {
        if (canCache) {
          customModelsCache.set(cacheKey, {
            value: data,
            updatedAt: Date.now(),
          });
        }
        return data;
      })
      .catch((e) => {
        if (e?.name === "AbortError") throw e;
        console.error(e);
        return {
          models: [],
          error: responseError(e, "Error finding custom models."),
        };
      })
      .finally(() => {
        if (cacheKey && customModelsInflight.get(cacheKey) === request) {
          customModelsInflight.delete(cacheKey);
        }
      });
    if (cacheKey) customModelsInflight.set(cacheKey, request);
    return await request;
  },
  chats: async (offset = 0, limit = 20) => {
    const cacheKey = adminSystemStateStore.keys.systemChats({ offset, limit });
    return await postJson("/system/workspace-chats", { offset, limit })
      .then(({ data }) => {
        adminSystemStateStore.set(cacheKey, data, {
          surface: "system-chats",
          meta: { offset, limit },
        });
        return data;
      })
      .catch((e) => {
        console.error(e);
        return adminSystemStateStore.getOrFallback(cacheKey, []);
      });
  },
  eventLogs: async (offset = 0) => {
    const cacheKey = adminSystemStateStore.keys.systemEventLogs(offset);
    return await postJson("/system/event-logs", { offset })
      .then(({ data }) => {
        adminSystemStateStore.set(cacheKey, data, {
          surface: "system-event-logs",
          ttlMs: ADMIN_SYSTEM_FAST_TTL_MS,
          meta: { offset },
        });
        return data;
      })
      .catch((e) => {
        console.error(e);
        return adminSystemStateStore.getOrFallback(cacheKey, [], {
          ttlMs: ADMIN_SYSTEM_FAST_TTL_MS,
        });
      });
  },
  clearEventLogs: async () => {
    return await deleteJson("/system/event-logs")
      .then(({ data }) => {
        adminSystemStateStore.invalidateSystemEventLogs();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  embeddingBatchJobs: async (limit = 50) => {
    const cacheKey = adminSystemStateStore.keys.systemEmbeddingBatchJobs(limit);
    return await postJson("/system/embedding-batch-jobs", { limit })
      .then(({ data }) => {
        adminSystemStateStore.set(cacheKey, data, {
          surface: "system-embedding-batch-jobs",
          ttlMs: ADMIN_SYSTEM_FAST_TTL_MS,
          meta: {
            limit,
            count: Array.isArray(data?.jobs) ? data.jobs.length : 0,
          },
        });
        return data;
      })
      .catch((e) => {
        console.error(e);
        return adminSystemStateStore.getOrFallback(
          cacheKey,
          { jobs: [] },
          { ttlMs: ADMIN_SYSTEM_FAST_TTL_MS }
        );
      });
  },
  retryEmbeddingBatchJob: async (jobId) => {
    return await postJson(`/system/embedding-batch-jobs/${jobId}/retry`)
      .then(({ data }) => {
        adminSystemStateStore.invalidateSystemEmbeddingBatchJobs();
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteChat: async (chatId) => {
    return await deleteJson(`/system/workspace-chats/${chatId}`)
      .then(({ data }) => {
        adminSystemStateStore.invalidatePrefix("system.chats:");
        return data;
      })
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  exportChats: async (type = "csv", chatType = "workspace") => {
    const url = new URL(`${fullApiUrl()}/system/export-chats`);
    url.searchParams.append("type", encodeURIComponent(type));
    url.searchParams.append("chatType", encodeURIComponent(chatType));
    return await requestText(url.toString(), {
      blobKind: BLOB_KINDS.exportText,
      communicationScene: "settings-tab",
    })
      .then(({ text }) => text)
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  updateUser: async (data, options = {}) => {
    return await postJson("/system/user", data, {
      signal: options.signal,
      task: options.task,
      communicationScene: options.communicationScene || "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  memoryOverview: async () => {
    return await getJson("/system/user/memory/overview", {
      communicationScene: "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  memoryBlocks: async ({ limit = null, detail = null } = {}) => {
    return await getJson(
      withQuery("/system/user/memory/blocks", { limit, detail }),
      { communicationScene: "account-settings" }
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  memoryArchives: async ({ limit = null, offset = null } = {}) => {
    return await getJson(
      withQuery("/system/user/memory/archives", { limit, offset }),
      { communicationScene: "account-settings" }
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  sensitiveMemories: async ({
    limit = null,
    offset = null,
    detail = null,
  } = {}) => {
    return await getJson(
      withQuery("/system/user/memory/sensitive", { limit, offset, detail }),
      { communicationScene: "account-security" }
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  createMemoryCandidate: async (data) => {
    return await postJson("/system/user/memory/candidates", data, {
      communicationScene: "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  rebuildMemoryProfile: async () => {
    return await postJson("/system/user/memory/rebuild", undefined, {
      communicationScene: "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  updateMemory: async ({ id, ...data }) => {
    return await patchJson(`/system/user/memory/${id}`, data, {
      communicationScene: "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  deleteMemory: async ({ id }) => {
    return await deleteJson(`/system/user/memory/${id}`, {
      communicationScene: "account-settings",
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  sensitiveMemoryPasskeyReauthOptions: async () => {
    return await postJson(
      "/system/user/memory/reauth/passkey/options",
      undefined,
      { communicationScene: "account-security" }
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  sensitiveMemoryPasskeyReauthVerify: async ({ response }) => {
    return await postJson(
      "/system/user/memory/reauth/passkey/verify",
      {
        response,
      },
      { communicationScene: "account-security" }
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  revealSensitiveMemory: async ({ id, currentPassword, reauthToken }) => {
    return await postJson(
      `/system/user/memory/${id}/reveal`,
      {
        currentPassword,
        reauthToken,
      },
      { communicationScene: "account-security" }
    )
      .then(({ data }) => {
        if (data?.sensitiveSession) {
          sensitiveSessionCenter.beginViewer(data.sensitiveSession, {
            resourceType: "user_memory",
            resourceId: id,
            exclusiveByResourceType: true,
            reason: "sensitive-memory-reveal",
          });
        }
        return data;
      })
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  accountDeletePreview: async () => {
    return await getJson("/system/user/delete-preview", {
      communicationScene: "account-security",
    })
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: rawBody(e)?.error || localizedApiError(e, "无法生成删除预览。"),
      }));
  },
  reauthAccountDeleteWithPassword: async ({ currentPassword }) => {
    return await postJson(
      "/system/user/delete/reauth/password",
      {
        currentPassword,
      },
      { communicationScene: "account-security" }
    )
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: rawBody(e)?.error || localizedApiError(e, "安全验证失败。"),
      }));
  },
  deleteAccount: async ({ confirm, reauthToken }) => {
    return await deleteJson("/system/user", {
      body: { confirm, reauthToken },
      communicationScene: "account-security",
    })
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: rawBody(e)?.error || localizedApiError(e, "删除账户失败。"),
        deletionJobId: rawBody(e)?.deletionJobId,
      }));
  },
  dataConnectors: DataConnector,

  getSlashCommandPresets: async function () {
    return await getJson("/system/slash-command-presets")
      .then(({ data }) => data.presets)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },

  createSlashCommandPreset: async function (presetData) {
    return await postJson("/system/slash-command-presets", presetData)
      .then(({ data }) => ({ preset: data.preset, error: null }))
      .catch((e) => {
        console.error(e);
        return {
          preset: null,
          error: responseError(e, "Error creating slash command preset."),
        };
      });
  },

  updateSlashCommandPreset: async function (presetId, presetData) {
    return await postJson(
      `/system/slash-command-presets/${presetId}`,
      presetData
    )
      .then(({ data }) => ({ preset: data.preset, error: null }))
      .catch((e) => {
        console.error(e);
        return {
          preset: null,
          error: responseError(e, "Could not update slash command preset."),
        };
      });
  },

  deleteSlashCommandPreset: async function (presetId) {
    return await deleteJson(`/system/slash-command-presets/${presetId}`)
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },

  /**
   * Fetches the can view chat history state from local storage or the system settings.
   * Notice: This is an instance setting that cannot be changed via the UI and it is cached
   * in local storage for 24 hours.
   * @returns {Promise<{viewable: boolean, error: string | null}>}
   */
  fetchCanViewChatHistory: async function () {
    const cache = window.localStorage.getItem(
      this.cacheKeys.canViewChatHistory
    );
    const { viewable, lastFetched } = cache
      ? safeJsonParse(cache, { viewable: false, lastFetched: 0 })
      : { viewable: false, lastFetched: 0 };

    // Since this is an instance setting that cannot be changed via the UI,
    // we can cache it in local storage for a day and if the admin changes it,
    // they should instruct the users to clear local storage.
    if (typeof viewable === "boolean" && Date.now() - lastFetched < 8.64e7)
      return { viewable, error: null };

    const res = await System.keys();
    const isViewable = res?.DisableViewChatHistory === false;

    window.localStorage.setItem(
      this.cacheKeys.canViewChatHistory,
      JSON.stringify({ viewable: isViewable, lastFetched: Date.now() })
    );
    return { viewable: isViewable, error: null };
  },

  /**
   * Validates a temporary auth token and logs in the user if the token is valid.
   * @param {string} publicToken - the token to validate against
   * @returns {Promise<{valid: boolean, user: import("@prisma/client").users | null, token: string | null, message: string | null}>}
   */
  simpleSSOLogin: async function (publicToken) {
    return getJson(`/request-token/sso/simple?token=${publicToken}`, {
      includeBaseHeaders: false,
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        const raw = rawBody(e);
        if (typeof raw?.valid === "boolean") return raw;
        return {
          valid: false,
          user: null,
          token: null,
          message: raw?.message || raw?.error || e.message,
        };
      });
  },

  /**
   * Fetches the app version from the server.
   * @returns {Promise<string | null>} The app version.
   */
  fetchAppVersion: async function () {
    const cacheKey = adminSystemStateStore.keys.systemAppVersion;
    const cachedVersion = adminSystemStateStore.get(cacheKey, {
      allowStale: false,
      ttlMs: ADMIN_SYSTEM_VERSION_TTL_MS,
    });
    if (cachedVersion) return cachedVersion;
    const cache = window.localStorage.getItem(this.cacheKeys.deploymentVersion);
    const { version, lastFetched } = cache
      ? safeJsonParse(cache, { version: null, lastFetched: 0 })
      : { version: null, lastFetched: 0 };

    if (!!version && Date.now() - lastFetched < 3_600_000) {
      adminSystemStateStore.set(cacheKey, version, {
        surface: "system-app-version",
        ttlMs: ADMIN_SYSTEM_VERSION_TTL_MS,
      });
      return version;
    }
    const newVersion = await getJson("/utils/metrics", {
      cache: "no-cache",
      communicationScene: "app-bootstrap",
    })
      .then(({ data }) => data?.appVersion)
      .catch(() =>
        adminSystemStateStore.getOrFallback(cacheKey, null, {
          ttlMs: ADMIN_SYSTEM_VERSION_TTL_MS,
        })
      );

    if (!newVersion) return null;
    adminSystemStateStore.set(cacheKey, newVersion, {
      surface: "system-app-version",
      ttlMs: ADMIN_SYSTEM_VERSION_TTL_MS,
    });
    window.localStorage.setItem(
      this.cacheKeys.deploymentVersion,
      JSON.stringify({ version: newVersion, lastFetched: Date.now() })
    );
    return newVersion;
  },

  /**
   * Validates a SQL connection string.
   * @param {'postgresql'|'mysql'|'sql-server'} engine - the database engine identifier
   * @param {string} connectionString - the connection string to validate
   * @returns {Promise<{success: boolean, error: string | null}>}
   */
  validateSQLConnection: async function (engine, connectionString) {
    return postJson(
      "/system/validate-sql-connection",
      {
        engine,
        connectionString,
      },
      { communicationScene: "settings-tab" }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error("Failed to validate SQL connection:", e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },

  /**
   * Checks if the filesystem-agent skill is available.
   * The filesystem-agent skill is only available when running in a Docker container.
   * @returns {Promise<boolean>}
   */
  isFileSystemAgentAvailable: async function () {
    return getJson("/agent-skills/filesystem-agent/is-available", {
      communicationScene: "workspace-chat",
    })
      .then(({ data }) => data?.available ?? false)
      .catch(() => false);
  },

  /**
   * Checks if the create-files-agent skill is available.
   * The create-files-agent skill is only available when running in a Docker container.
   * @returns {Promise<boolean>}
   */
  isCreateFilesAgentAvailable: async function () {
    return getJson("/agent-skills/create-files-agent/is-available", {
      communicationScene: "workspace-chat",
    })
      .then(({ data }) => data?.available ?? false)
      .catch(() => false);
  },

  cryptoAccountAgentStatus: async function () {
    return getJson("/agent-skills/crypto-account-agent/status", {
      communicationScene: "workspace-chat",
    })
      .then(({ data }) => data)
      .catch(() => ({
        registered: true,
        available: false,
        approvalRequired: true,
        schedulable: false,
        provider: "gate",
      }));
  },

  experimentalFeatures: {
    liveSync: LiveDocumentSync,
    agentPlugins: AgentPlugins,
  },
  promptVariables: SystemPromptVariable,
};

export default System;
