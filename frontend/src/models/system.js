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
import { shouldPreserveLocalAuthOnFailure } from "@/utils/authSessionMaintenance";
import {
  BLOB_KINDS,
  requestBlob,
  requestText,
} from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";
import { baseHeaders, safeJsonParse } from "@/utils/request";
import DataConnector from "./dataConnector";
import LiveDocumentSync from "./experimental/liveSync";
import AgentPlugins from "./experimental/agentPlugins";
import SystemPromptVariable from "./systemPromptVariable";

let systemKeysCache = null;
let systemKeysCacheAt = 0;
let systemKeysInflight = null;
const SYSTEM_KEYS_CACHE_TTL_MS = 30_000;
const SYSTEM_KEYS_TIMEOUT_MS = 20_000;
const SYSTEM_KEYS_RETRY_DELAYS_MS = [0, 750, 1_500];

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
    return await getJson("/ping")
      .then(({ data }) => data?.online || false)
      .catch(() => false);
  },
  totalIndexes: async function (slug = null) {
    const url = new URL(`${fullApiUrl()}/system/system-vectors`);
    if (!!slug) url.searchParams.append("slug", encodeURIComponent(slug));
    return await getJson(url.toString())
      .then(({ data }) => data.vectorCount)
      .catch(() => 0);
  },
  patrolStatus: async function () {
    return await getJson("/system/patrol/status")
      .then(({ data }) => data)
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "无法读取系统巡查状态。"),
        })
      );
  },
  runPatrol: async function ({ mode = "light" } = {}) {
    return await postJson("/system/patrol/run", { mode })
      .then(({ data }) => data)
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "系统巡查执行失败。"),
        })
      );
  },
  patrolRepairPreview: async function (repairId) {
    return await postJson(`/system/patrol/repairs/${repairId}/preview`, {})
      .then(({ data }) => data)
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "无法生成修复预案。"),
        })
      );
  },
  patrolRepairConfirm: async function (repairId) {
    return await postJson(`/system/patrol/repairs/${repairId}/confirm`, {})
      .then(({ data }) => data)
      .catch((e) =>
        rawOrFallback(e, {
          success: false,
          error: localizedApiError(e, "修复执行失败。"),
        })
      );
  },

  /**
   * Checks if the onboarding is complete.
   * @returns {Promise<boolean>}
   */
  isOnboardingComplete: async function () {
    return await getJson("/onboarding")
      .then(({ data }) => data.onboardingComplete)
      .catch(() => false);
  },
  /**
   * Marks the onboarding as complete.
   * @returns {Promise<boolean>}
   */
  markOnboardingComplete: async function () {
    return await postJson("/onboarding")
      .then(() => true)
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
        }
        return results;
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
    return await getJson("/system/local-files")
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
    })
      .then(() => true)
      .catch((e) => {
        if (shouldPreserveLocalAuthOnFailure(e)) return true;
        return false;
      });

    window.localStorage.setItem(AUTH_TIMESTAMP, Number(new Date()));
    return valid;
  },
  requestToken: async function (body) {
    return await postJson("/request-token", { ...body })
      .then(({ data }) => data)
      .catch((e) => {
        return {
          valid: false,
          message: responseError(e, "Could not validate login."),
        };
      });
  },
  registrationConfig: async function () {
    return await getJson("/auth/registration/config")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return { success: false, allowPublicRegistration: false };
      });
  },
  requestRegistrationCode: async function ({ email }) {
    return await postJson("/auth/register/request-code", { email })
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
    return await postJson("/auth/register/check-email", { email })
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
    return await postJson("/auth/register/verify-code", {
      email,
      code,
      challengeId,
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
  registerAccount: async function (data) {
    return await postJson("/auth/register", data)
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
    return getJson("/system/refresh-user")
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
    return await postJson("/system/recover-account", {
      username,
      recoveryCodes,
    })
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
    return await postJson("/system/recover-account/email/request", {
      username,
      email,
    })
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
    return await postJson("/system/recover-account/email/confirm", {
      username,
      email,
      code,
      challengeId,
    })
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
    return await postJson("/system/reset-password", {
      token,
      newPassword,
      confirmPassword,
    })
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
    return await getJson("/system/user/email-verification")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  requestEmailVerification: async function ({ email }) {
    return await postJson("/system/user/email-verification/request", { email })
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
    return await postJson("/system/user/email-verification/confirm", {
      email,
      code,
      challengeId,
    })
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
    return await getJson("/system/document-processing-status", {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-upload-visible",
      task: options.task,
    })
      .then(() => true)
      .catch(() => false);
  },
  acceptedDocumentTypes: async () => {
    return await getJson("/system/accepted-document-types")
      .then(({ data }) => data?.types)
      .catch(() => null);
  },
  updateSystem: async (data) => {
    return await postJson("/system/update-env", data)
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
  uploadPfp: async function (formData) {
    return await uploadFormData("/system/upload-pfp", formData, {
      uploadKind: UPLOAD_KINDS.avatar,
    })
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },
  uploadLogo: async function (formData) {
    return await uploadFormData("/system/upload-logo", formData, {
      uploadKind: UPLOAD_KINDS.logo,
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
    syncExistingWorkspaces = null
  ) {
    try {
      const { data } = await postJson("/system/default-system-prompt", {
        defaultSystemPrompt,
        syncExistingWorkspaces,
      });
      return data;
    } catch (e) {
      console.error(e);
      return { success: false, message: e.message };
    }
  },
  fetchLogo: async function () {
    const url = new URL(`${fullApiUrl()}/system/logo`);
    url.searchParams.append(
      "theme",
      localStorage.getItem("theme") || "default"
    );

    return await requestBlob(url.toString(), {
      cache: "no-cache",
      includeBaseHeaders: false,
      blobKind: BLOB_KINDS.logo,
    })
      .then(({ response, blob }) => {
        if (response.status !== 204 && blob) {
          const isCustomLogo =
            response.headers.get("X-Is-Custom-Logo") === "true";
          const logoURL = URL.createObjectURL(blob);
          return { isCustomLogo, logoURL };
        }
        throw new Error("Failed to fetch logo!");
      })
      .catch((e) => {
        console.log(e);
        return { isCustomLogo: false, logoURL: null };
      });
  },
  fetchPfp: async function (id) {
    return await requestBlob(`/system/pfp/${id}`, {
      cache: "no-cache",
      blobKind: BLOB_KINDS.avatar,
    })
      .then(({ response, blob }) =>
        response.status !== 204 && blob ? URL.createObjectURL(blob) : null
      )
      .catch(() => {
        return null;
      });
  },
  removePfp: async function () {
    return await deleteJson("/system/remove-pfp")
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },

  isDefaultLogo: async function () {
    return await getJson("/system/is-default-logo", { cache: "no-cache" })
      .then(({ data }) => data?.isDefaultLogo)
      .catch((e) => {
        console.log(e);
        return null;
      });
  },
  removeCustomLogo: async function () {
    return await getJson("/system/remove-logo")
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
      .then(({ data }) => data)
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
    return postJson(
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
      .then(({ data }) => data)
      .catch((e) => {
        if (e?.name === "AbortError") throw e;
        console.error(e);
        return {
          models: [],
          error: responseError(e, "Error finding custom models."),
        };
      });
  },
  chats: async (offset = 0, limit = 20) => {
    return await postJson("/system/workspace-chats", { offset, limit })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  eventLogs: async (offset = 0) => {
    return await postJson("/system/event-logs", { offset })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  clearEventLogs: async () => {
    return await deleteJson("/system/event-logs")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  embeddingBatchJobs: async (limit = 50) => {
    return await postJson("/system/embedding-batch-jobs", { limit })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return { jobs: [] };
      });
  },
  retryEmbeddingBatchJob: async (jobId) => {
    return await postJson(`/system/embedding-batch-jobs/${jobId}/retry`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteChat: async (chatId) => {
    return await deleteJson(`/system/workspace-chats/${chatId}`)
      .then(({ data }) => data)
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
    })
      .then(({ text }) => text)
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  updateUser: async (data) => {
    return await postJson("/system/user", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  memoryOverview: async () => {
    return await getJson("/system/user/memory/overview")
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  memoryBlocks: async ({ limit = null, detail = null } = {}) => {
    return await getJson(
      withQuery("/system/user/memory/blocks", { limit, detail })
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  memoryArchives: async ({ limit = null, offset = null } = {}) => {
    return await getJson(
      withQuery("/system/user/memory/archives", { limit, offset })
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
      withQuery("/system/user/memory/sensitive", { limit, offset, detail })
    )
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  createMemoryCandidate: async (data) => {
    return await postJson("/system/user/memory/candidates", data)
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  rebuildMemoryProfile: async () => {
    return await postJson("/system/user/memory/rebuild")
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  updateMemory: async ({ id, ...data }) => {
    return await patchJson(`/system/user/memory/${id}`, data)
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  deleteMemory: async ({ id }) => {
    return await deleteJson(`/system/user/memory/${id}`)
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  sensitiveMemoryPasskeyReauthOptions: async () => {
    return await postJson("/system/user/memory/reauth/passkey/options")
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  sensitiveMemoryPasskeyReauthVerify: async ({ response }) => {
    return await postJson("/system/user/memory/reauth/passkey/verify", {
      response,
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  revealSensitiveMemory: async ({ id, currentPassword, reauthToken }) => {
    return await postJson(`/system/user/memory/${id}/reveal`, {
      currentPassword,
      reauthToken,
    })
      .then(({ data }) => data)
      .catch((e) => ({ success: false, error: localizedApiError(e) }));
  },
  accountDeletePreview: async () => {
    return await getJson("/system/user/delete-preview")
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: rawBody(e)?.error || localizedApiError(e, "无法生成删除预览。"),
      }));
  },
  reauthAccountDeleteWithPassword: async ({ currentPassword }) => {
    return await postJson("/system/user/delete/reauth/password", {
      currentPassword,
    })
      .then(({ data }) => data)
      .catch((e) => ({
        success: false,
        error: rawBody(e)?.error || localizedApiError(e, "安全验证失败。"),
      }));
  },
  deleteAccount: async ({ confirm, reauthToken }) => {
    return await deleteJson("/system/user", {
      body: { confirm, reauthToken },
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
    const cache = window.localStorage.getItem(this.cacheKeys.deploymentVersion);
    const { version, lastFetched } = cache
      ? safeJsonParse(cache, { version: null, lastFetched: 0 })
      : { version: null, lastFetched: 0 };

    if (!!version && Date.now() - lastFetched < 3_600_000) return version;
    const newVersion = await getJson("/utils/metrics", { cache: "no-cache" })
      .then(({ data }) => data?.appVersion)
      .catch(() => null);

    if (!newVersion) return null;
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
    return postJson("/system/validate-sql-connection", {
      engine,
      connectionString,
    })
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
    return getJson("/agent-skills/filesystem-agent/is-available")
      .then(({ data }) => data?.available ?? false)
      .catch(() => false);
  },

  /**
   * Checks if the create-files-agent skill is available.
   * The create-files-agent skill is only available when running in a Docker container.
   * @returns {Promise<boolean>}
   */
  isCreateFilesAgentAvailable: async function () {
    return getJson("/agent-skills/create-files-agent/is-available")
      .then(({ data }) => data?.available ?? false)
      .catch(() => false);
  },

  experimentalFeatures: {
    liveSync: LiveDocumentSync,
    agentPlugins: AgentPlugins,
  },
  promptVariables: SystemPromptVariable,
};

export default System;
