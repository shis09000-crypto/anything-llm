import { deleteJson, getJson, patchJson } from "./apiClient";

export const USER_STATE_NAMESPACES = {
  recentNavigation: "recent.navigation",
  appearance: "preferences.appearance",
  workspaceLayout: "workspace.layout",
  workspaceOrder: "workspace.order",
  readerProgress: "reader.progress",
  readerLibrary: "reader.library",
  chatDraft: "chat.draft",
  cryptoUi: "crypto.ui",
};

function namespaceQuery(namespaces = []) {
  const list = Array.isArray(namespaces) ? namespaces : [namespaces];
  const filtered = list.filter(Boolean).map(encodeURIComponent);
  return filtered.length ? `?namespaces=${filtered.join(",")}` : "";
}

export async function getUserStates(namespaces = [], options = {}) {
  const { data } = await getJson(
    `/system/user/state${namespaceQuery(namespaces)}`,
    options
  );
  return data?.states || [];
}

export async function patchUserStates(states = [], options = {}) {
  const { data } = await patchJson(
    "/system/user/state",
    { states: Array.isArray(states) ? states : [states] },
    options
  );
  return data?.states || [];
}

export async function deleteUserState(
  { namespace, scope = null } = {},
  options = {}
) {
  const { data } = await deleteJson("/system/user/state", {
    ...options,
    body: { namespace, scope },
  });
  return data || { success: false, error: "empty_response" };
}
