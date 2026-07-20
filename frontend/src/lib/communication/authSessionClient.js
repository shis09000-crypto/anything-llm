import { getJson, postJson } from "./apiClient";

export async function listAuthSessions(options = {}) {
  const { data } = await getJson("/system/sessions", options);
  return data || { success: false, sessions: [], error: "empty_response" };
}

export async function revokeAuthSession(sessionId, options = {}) {
  if (!sessionId) return { success: false, error: "session_id_required" };
  const { data } = await postJson(
    "/system/sessions/revoke",
    { sessionId },
    options
  );
  return data || { success: false, error: "empty_response" };
}

export async function revokeOtherAuthSessions(options = {}) {
  const { data } = await postJson(
    "/system/sessions/revoke-others",
    {},
    options
  );
  return data || { success: false, error: "empty_response" };
}

export async function revokeAllAuthSessions(options = {}) {
  const { data } = await postJson("/system/sessions/revoke-all", {}, options);
  return data || { success: false, error: "empty_response" };
}
