import { getJson, patchJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback as rawOrFallback } from "@/lib/communication/apiError";

const FileAccessPolicy = {
  storageKey: "anythingllm-file-access-session-mode",
  modes: {
    sandbox: "sandbox",
    authorized: "authorized",
    open: "open",
  },
  labels: {
    sandbox: "Sandbox",
    authorized: "Authorized",
    open: "Open",
  },
  getSessionMode(workspaceSlug = null, threadSlug = null) {
    const key = this.sessionKey(workspaceSlug, threadSlug);
    return sessionStorage.getItem(key) || null;
  },
  setSessionMode(mode, workspaceSlug = null, threadSlug = null) {
    const normalized = this.normalizeMode(mode);
    sessionStorage.setItem(
      this.sessionKey(workspaceSlug, threadSlug),
      normalized
    );
    return normalized;
  },
  sessionKey(workspaceSlug = null, threadSlug = null) {
    return `${this.storageKey}:${workspaceSlug || "global"}:${threadSlug || "default"}`;
  },
  normalizeMode(mode) {
    return Object.values(this.modes).includes(mode) ? mode : this.modes.sandbox;
  },
  getPolicy: async function (sessionMode = null) {
    const params = new URLSearchParams();
    if (sessionMode) params.set("sessionMode", sessionMode);
    const query = params.toString() ? `?${params.toString()}` : "";
    return getJson(`/system/file-access-policy${query}`)
      .then(({ data }) => data)
      .catch((e) =>
        rawOrFallback(e, { success: false, error: e.message, policy: null })
      );
  },
  updateGlobalPolicy: async function (updates = {}) {
    return patchJson("/system/file-access-policy", updates)
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },
  logSessionModeChange: async function ({
    mode,
    workspaceSlug = null,
    threadSlug = null,
  }) {
    return postJson("/system/file-access-policy/session-event", {
      mode,
      workspaceSlug,
      threadSlug,
    })
      .then(({ response }) => response)
      .catch(() => null);
  },
};

export default FileAccessPolicy;
