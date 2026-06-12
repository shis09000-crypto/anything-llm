export const CODEX_DEV_AUTH_BYPASS_HEADER = "X-Codex-Dev-Auth-Bypass";
export const CODEX_DEV_AUTH_BYPASS_QUERY = "codexAuthBypass";
export const CODEX_DEV_AUTH_BYPASS_STORAGE_KEY =
  "anythingllm_codex_dev_auth_bypass";
export const CODEX_DEV_AUTH_BYPASS_KEY =
  import.meta.env.VITE_CODEX_DEV_AUTH_BYPASS_KEY || "";
export const CODEX_DEV_AUTH_BYPASS_USER_ID = Number(
  import.meta.env.VITE_CODEX_DEV_AUTH_BYPASS_USER_ID || 1
);

function storageGet() {
  try {
    return window.localStorage.getItem(CODEX_DEV_AUTH_BYPASS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storageSet(value) {
  try {
    window.localStorage.setItem(CODEX_DEV_AUTH_BYPASS_STORAGE_KEY, value);
  } catch {}
}

function storageRemove() {
  try {
    window.localStorage.removeItem(CODEX_DEV_AUTH_BYPASS_STORAGE_KEY);
  } catch {}
}

export function isCodexDevAuthBypassEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  if (!CODEX_DEV_AUTH_BYPASS_KEY) return false;

  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get(CODEX_DEV_AUTH_BYPASS_QUERY);
  if (queryValue === "0" || queryValue === "false") {
    storageRemove();
    return false;
  }
  if (queryValue === CODEX_DEV_AUTH_BYPASS_KEY) {
    storageSet(CODEX_DEV_AUTH_BYPASS_KEY);
    return true;
  }

  return (
    import.meta.env.VITE_CODEX_DEV_AUTH_BYPASS === "true" ||
    storageGet() === CODEX_DEV_AUTH_BYPASS_KEY
  );
}
