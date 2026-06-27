import { getJson, postJson } from "./apiClient";

export function fetchSystemEnvironment(options = {}) {
  return getJson("/system/environment", {
    ...options,
    cache: options.cache ?? "no-cache",
    timeoutMs: options.timeoutMs ?? 5_000,
    includeBaseHeaders: false,
  });
}

export function checkSessionToken(options = {}) {
  return getJson("/system/check-token", {
    ...options,
    cache: options.cache ?? "default",
  });
}

export function recordUserAction(reason, options = {}) {
  return postJson("/system/user-action", { reason }, options);
}
