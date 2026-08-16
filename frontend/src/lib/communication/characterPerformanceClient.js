import { deleteJson, getJson, postJson } from "./apiClient";
import { issueRealtimeTicket } from "./realtimeTicketClient";

export async function getAthena3DCenter() {
  const result = await getJson("/3d-center", {
    communicationScene: "athena_3d_center",
  });
  if (!result.data?.success)
    throw new Error(result.data?.error || "Athena 3D Center unavailable.");
  return result.data.center;
}

export async function createPerformanceSession(body) {
  const result = await postJson("/3d-center/sessions", body, {
    timeoutMs: 30_000,
    communicationScene: "athena_3d_center",
  });
  if (!result.data?.success)
    throw new Error(result.data?.error || "Performance session failed.");
  return result.data;
}

export async function createPerformanceTurn(sessionId, body) {
  const result = await postJson(
    `/3d-center/sessions/${encodeURIComponent(sessionId)}/turns`,
    body,
    { timeoutMs: 300_000, communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(result.data?.error || "Performance turn failed.");
  return result.data;
}

export async function createIncrementalPerformanceResponse(sessionId, body) {
  const result = await postJson(
    `/3d-center/sessions/${encodeURIComponent(sessionId)}/responses`,
    body,
    { timeoutMs: 300_000, communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(result.data?.error || "Incremental response failed.");
  return result.data;
}

export async function getPerformanceSession(sessionId, scope) {
  const query = new URLSearchParams(
    Object.entries(scope).filter(([, value]) => value != null)
  );
  const result = await getJson(
    `/3d-center/sessions/${encodeURIComponent(sessionId)}?${query}`,
    { communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(result.data?.error || "Performance session unavailable.");
  return result.data.session;
}

function characterMemoryPath(instanceId, suffix = "") {
  return `/3d-center/characters/${encodeURIComponent(instanceId)}/memory${suffix}`;
}

function memoryQuery(options = {}) {
  const query = new URLSearchParams(
    Object.entries(options).filter(([, value]) => value != null)
  ).toString();
  return query ? `?${query}` : "";
}

export async function getCharacterMemory(instanceId, options = {}) {
  const result = await getJson(
    `${characterMemoryPath(instanceId)}${memoryQuery(options)}`,
    { communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(result.data?.error || "Character memory unavailable.");
  return result.data.character_memory;
}

export async function listCharacterMemorySessions(instanceId, options = {}) {
  const result = await getJson(
    `${characterMemoryPath(instanceId, "/sessions")}${memoryQuery(options)}`,
    { communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(
      result.data?.error || "Character memory sessions unavailable."
    );
  return result.data;
}

export async function getCharacterMemorySession(
  instanceId,
  memorySessionId,
  options = {}
) {
  const result = await getJson(
    `${characterMemoryPath(instanceId, `/sessions/${encodeURIComponent(memorySessionId)}`)}${memoryQuery(options)}`,
    { communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(
      result.data?.error || "Character memory session unavailable."
    );
  return result.data.character_memory;
}

export async function deleteCharacterMemorySession(
  instanceId,
  memorySessionId,
  options = {}
) {
  const result = await deleteJson(
    `${characterMemoryPath(instanceId, `/sessions/${encodeURIComponent(memorySessionId)}`)}${memoryQuery(options)}`,
    { communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(result.data?.error || "Character memory deletion failed.");
  return result.data.deletion;
}

export async function resetCharacterMemory(instanceId, options = {}) {
  const result = await deleteJson(
    `${characterMemoryPath(instanceId)}${memoryQuery(options)}`,
    { communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(result.data?.error || "Character memory reset failed.");
  return result.data.deletion;
}

export async function reconsolidateCharacterMemory(
  instanceId,
  { memorySessionId = null, ...options } = {}
) {
  const result = await postJson(
    `${characterMemoryPath(instanceId, "/reconsolidate")}${memoryQuery(options)}`,
    { memory_session_id: memorySessionId },
    { timeoutMs: 30_000, communicationScene: "athena_3d_center" }
  );
  if (!result.data?.success)
    throw new Error(
      result.data?.error || "Character memory reconsolidation failed."
    );
  return result.data.reconsolidation;
}

export async function connectPerformanceStream({
  sessionId,
  workspaceId,
  threadId,
  afterSequence = -1,
  onEvent,
}) {
  const ticket = await issueRealtimeTicket("athena-3d-center", sessionId);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({
    realtimeTicket: ticket,
    workspace_id: String(workspaceId),
    after_sequence: String(afterSequence),
    ...(threadId ? { thread_id: String(threadId) } : {}),
  });
  const socket = new WebSocket(
    `${protocol}//${window.location.host}/api/3d-center/sessions/${encodeURIComponent(sessionId)}/stream?${query}`
  );
  socket.addEventListener("message", (event) => {
    try {
      onEvent?.(JSON.parse(event.data));
    } catch {
      // Invalid frames are ignored; the authoritative event can be recovered.
    }
  });
  return socket;
}
