import { AUTH_USER } from "./constants";
import { getAuthToken } from "./authTokenStorage";
import {
  CODEX_DEV_AUTH_BYPASS_HEADER,
  CODEX_DEV_AUTH_BYPASS_KEY,
  isCodexDevAuthBypassEnabled,
} from "./codexDevAuthBypass";
import {
  CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER,
  isCryptoCenterDevAuthBypassEnabled,
} from "./cryptoCenterDevAuthBypass";

// Sets up the base headers for all authenticated requests so that we are able to prevent
// basic spoofing since a valid token is required and that cannot be spoofed
export function userFromStorage() {
  const userString = window.localStorage.getItem(AUTH_USER);
  if (!userString) return null;
  return safeJsonParse(userString, null);
}

export function baseHeaders(providedToken = null) {
  const token = providedToken || getAuthToken();
  const headers = {
    Authorization: token ? `Bearer ${token}` : null,
  };
  if (isCryptoCenterDevAuthBypassEnabled()) {
    headers[CRYPTO_CENTER_DEV_AUTH_BYPASS_HEADER] = "1";
  }
  if (isCodexDevAuthBypassEnabled()) {
    headers[CODEX_DEV_AUTH_BYPASS_HEADER] = CODEX_DEV_AUTH_BYPASS_KEY;
  }
  return headers;
}

export function safeJsonParse(jsonString, fallback = null) {
  try {
    if (jsonString === null || jsonString === undefined) return fallback;
    return JSON.parse(jsonString);
  } catch {}
  return fallback;
}
