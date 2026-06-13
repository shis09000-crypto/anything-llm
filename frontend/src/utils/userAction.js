import { API_BASE, AUTH_TOKEN, LAST_USER_ACTION_AT } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

export const USER_ACTION_REASONS = Object.freeze({
  messageSubmit: "message_submit",
  fileUpload: "file_upload",
  workspaceSwitch: "workspace_switch",
  threadSwitch: "thread_switch",
  knowledgeOpen: "knowledge_open",
  pageNavigation: "page_navigation",
  buttonClick: "button_click",
  securityAction: "security_action",
});

const SERVER_REFRESH_REASONS = new Set(Object.values(USER_ACTION_REASONS));
const SERVER_REFRESH_THROTTLE_MS = 60 * 1000;
const IDLE_TIMEOUT_MS = 48 * 60 * 60 * 1000;
let lastServerRefreshAt = 0;

export function recordLocalUserAction() {
  const now = Date.now();
  window.localStorage.setItem(LAST_USER_ACTION_AT, String(now));
  return now;
}

export function localIdleExpired() {
  const value = Number(window.localStorage.getItem(LAST_USER_ACTION_AT));
  if (!Number.isFinite(value) || value <= 0) return false;
  return Date.now() - value > IDLE_TIMEOUT_MS;
}

export async function recordServerUserAction(reason) {
  recordLocalUserAction();
  if (!SERVER_REFRESH_REASONS.has(reason)) return { success: false };

  const token = window.localStorage.getItem(AUTH_TOKEN);
  if (!token) return { success: false };

  const now = Date.now();
  if (now - lastServerRefreshAt < SERVER_REFRESH_THROTTLE_MS) {
    return { success: true, throttled: true };
  }
  lastServerRefreshAt = now;

  return fetch(`${API_BASE}/system/user-action`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason }),
  })
    .then((res) => res.json())
    .then((result) => {
      if (result?.token) window.localStorage.setItem(AUTH_TOKEN, result.token);
      if (result?.lastUserActionAt) {
        window.localStorage.setItem(
          LAST_USER_ACTION_AT,
          String(result.lastUserActionAt)
        );
      }
      return result;
    })
    .catch(() => ({ success: false }));
}

export function setLoginUserActionNow() {
  recordLocalUserAction();
}
