import {
  deleteJson,
  getJson,
  postJson,
  putJson,
} from "@/lib/communication/apiClient";

function result(response) {
  return response?.data?.result ?? response?.data ?? null;
}

const browserTask = (priority, label, extra = {}) => ({
  priority,
  label,
  scope: { route: "browser-plane" },
  ...extra,
});

const BrowserPlane = {
  status: () =>
    getJson("/browser/status", { communicationScene: "browser-plane" }).then(
      result
    ),
  nodes: () =>
    getJson("/browser/nodes", { communicationScene: "browser-plane" }).then(
      result
    ),
  heartbeatNode: (payload) =>
    postJson("/browser/nodes/heartbeat", payload, {
      communicationScene: "browser-plane",
      task: browserTask("P3", "Browser node lease heartbeat", {
        protected: false,
      }),
    }).then(result),
  createSession: (payload) =>
    postJson("/browser/sessions", payload, {
      communicationScene: "browser-plane",
      timeoutMs: 45_000,
      task: browserTask("P0", "Open browser session"),
    }).then(result),
  session: (sessionId) =>
    getJson(`/browser/sessions/${encodeURIComponent(sessionId)}`, {
      communicationScene: "browser-plane",
    }).then(result),
  streamTicket: (sessionId, tabId) =>
    postJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/stream-ticket`,
      { tabId },
      { communicationScene: "browser-plane", timeoutMs: 10_000 }
    ).then(result),
  action: (sessionId, payload) =>
    postJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/actions`,
      payload,
      {
        communicationScene: "browser-plane",
        timeoutMs: 40_000,
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }
    ).then(result),
  newTab: (sessionId, url = "about:blank") =>
    postJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/tabs`,
      { url },
      { communicationScene: "browser-plane", timeoutMs: 40_000 }
    ).then(result),
  closeTab: (sessionId, tabId) =>
    deleteJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/tabs/${encodeURIComponent(tabId)}`,
      { communicationScene: "browser-plane" }
    ).then(result),
  closeSession: (sessionId) =>
    postJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/close`,
      {},
      { communicationScene: "browser-plane", timeoutMs: 45_000 }
    ).then(result),
  cookies: (sessionId) =>
    getJson(`/browser/sessions/${encodeURIComponent(sessionId)}/cookies`, {
      communicationScene: "browser-plane",
    }).then(result),
  clearCookieSite: (sessionId, domain) =>
    deleteJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/cookies/${encodeURIComponent(domain)}`,
      { communicationScene: "browser-plane" }
    ).then(result),
  workspaces: () =>
    getJson("/browser/workspaces", {
      communicationScene: "browser-plane",
    }).then(result),
  saveWorkspace: (payload) =>
    postJson("/browser/workspaces", payload, {
      communicationScene: "browser-plane",
    }).then(result),
  history: () =>
    getJson("/browser/history", { communicationScene: "browser-plane" }).then(
      result
    ),
  bookmarks: () =>
    getJson("/browser/bookmarks", { communicationScene: "browser-plane" }).then(
      result
    ),
  addBookmark: (payload) =>
    postJson("/browser/bookmarks", payload, {
      communicationScene: "browser-plane",
    }).then(result),
  egressStatus: () =>
    getJson("/browser/egress/status", {
      communicationScene: "browser-plane",
    }).then(result),
  profileRoute: (profileId = "default") =>
    getJson(
      `/browser/profiles/${encodeURIComponent(profileId)}/network-route`,
      { communicationScene: "browser-plane" }
    ).then(result),
  setProfileRoute: (profileId = "default", payload = {}) =>
    putJson(
      `/browser/profiles/${encodeURIComponent(profileId)}/network-route`,
      payload,
      {
        communicationScene: "browser-plane",
        task: browserTask("P0", "Switch browser profile network route"),
      }
    ).then(result),
  enrollEgress: (profileId = "default", payload = {}) =>
    postJson(
      `/browser/profiles/${encodeURIComponent(profileId)}/egress/enroll`,
      payload,
      {
        communicationScene: "browser-plane",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        task: browserTask("P0", "Enroll browser egress"),
      }
    ).then(result),
  confirmProfileRoute: (profileId = "default", payload = {}) =>
    postJson(
      `/browser/profiles/${encodeURIComponent(profileId)}/network-health`,
      payload,
      {
        communicationScene: "browser-plane",
        task: browserTask("P0", "Confirm browser egress route"),
      }
    ).then(result),
  renewEgress: (grantId) =>
    postJson(
      `/browser/egress/grants/${encodeURIComponent(grantId)}/renew`,
      {},
      {
        communicationScene: "browser-plane",
        task: browserTask("P3", "Renew browser egress lease", {
          protected: false,
        }),
      }
    ).then(result),
  revokeEgress: (grantId) =>
    deleteJson(`/browser/egress/grants/${encodeURIComponent(grantId)}`, {
      communicationScene: "browser-plane",
      task: browserTask("P0", "Revoke browser egress grant"),
    }).then(result),
  openSystemChrome: (sessionId, url) =>
    postJson(
      `/browser/sessions/${encodeURIComponent(sessionId)}/open-system-chrome`,
      { url },
      {
        communicationScene: "browser-plane",
        task: browserTask("P0", "Open managed system Chrome"),
      }
    ).then(result),
};

export default BrowserPlane;
