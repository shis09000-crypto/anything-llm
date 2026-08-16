import { postJson } from "./apiClient";

const PURPOSES = new Set([
  "broadcast",
  "agent",
  "crypto",
  "character-performance",
  "athena-3d-center",
]);

export async function issueRealtimeTicket(
  purpose,
  resourceId = null,
  options = {}
) {
  const normalizedPurpose = String(purpose || "").toLowerCase();
  if (!PURPOSES.has(normalizedPurpose)) {
    throw new Error("Invalid realtime ticket purpose.");
  }
  const result = await postJson(
    "/realtime/ticket",
    {
      purpose: normalizedPurpose,
      ...(resourceId ? { resourceId: String(resourceId) } : {}),
    },
    {
      ...options,
      timeoutMs: options.timeoutMs || 10_000,
      communicationScene: "realtime_auth",
      task: options.task || {
        kind: "realtime-ticket",
        priority: "P0",
        policy: "visible",
        protected: true,
        abortable: true,
        scope: { route: "realtime-ticket", purpose: normalizedPurpose },
      },
    }
  );
  if (!result.data?.success || !result.data?.ticket) {
    throw new Error(result.data?.error || "Realtime ticket request failed.");
  }
  return result.data.ticket;
}
