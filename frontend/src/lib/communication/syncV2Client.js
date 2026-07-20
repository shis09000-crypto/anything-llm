import { getJson, patchJson, postJson } from "./apiClient";
import { getJsonSse } from "./streamClient";

const syncTask = (label, priority = "P1") => ({
  label,
  kind: "sync-v2",
  priority,
  policy: priority === "P0" ? "foreground" : "maintenance",
  resource: "network",
  protected: true,
  abortable: true,
  scope: { route: "sync-v2", surface: label },
});

export const syncV2Client = {
  async manifest({ signal = null, manifestHash = null } = {}) {
    const query = manifestHash
      ? `?manifestHash=${encodeURIComponent(manifestHash)}`
      : "";
    return getJson(`/sync/v2/manifest${query}`, {
      signal,
      communicationScene: "sync-v2",
      task: syncTask("manifest", "P0"),
    }).then(({ data }) => data);
  },

  async batchGet(nodes = [], { signal = null } = {}) {
    return postJson(
      "/sync/v2/nodes:batchGet",
      { nodes },
      {
        signal,
        communicationScene: "sync-v2",
        task: syncTask("nodes-batch-get"),
      }
    ).then(({ data }) => data);
  },

  async events(after, { signal = null, limit = 200 } = {}) {
    return getJson(
      `/sync/v2/events?after=${encodeURIComponent(after)}&limit=${limit}`,
      {
        signal,
        communicationScene: "sync-v2",
        task: syncTask("events-replay"),
      }
    ).then(({ data }) => data);
  },

  async stream(
    after,
    { signal = null, onEvent = null, onReady = null, onError = null } = {}
  ) {
    return getJsonSse({
      path: `/sync/v2/stream?after=${encodeURIComponent(
        Math.max(0, Number(after) || 0)
      )}`,
      signal,
      openWhenHidden: true,
      communicationScene: "sync-v2",
      task: syncTask("event-stream"),
      retryOnError: true,
      async onMessage(message) {
        if (message?.type === "heartbeat") return;
        if (message?.type === "syncV2.ready") {
          await onReady?.(message);
          return;
        }
        if (message?.type === "syncV2.event" && message.event) {
          await onEvent?.(message.event);
        }
      },
      onError(error) {
        onError?.(error);
        return 1_000;
      },
    });
  },

  async acknowledge(lastAppliedSeq, { signal = null } = {}) {
    return postJson(
      "/sync/v2/cursor",
      { lastAppliedSeq },
      {
        signal,
        communicationScene: "sync-v2",
        task: syncTask("cursor-ack", "P2"),
      }
    ).then(({ data }) => data);
  },

  async mutate(mutation, { signal = null } = {}) {
    return patchJson(
      `/sync/v2/nodes/${encodeURIComponent(mutation.nodeKey)}`,
      mutation,
      {
        signal,
        headers: {
          "If-Match": String(mutation.baseVersion),
          "Idempotency-Key": mutation.mutationId,
        },
        communicationScene: "sync-v2-mutation",
        task: syncTask("mutation", "P0"),
      }
    ).then(({ data }) => data);
  },

  async mutateBatch(mutations = [], { signal = null } = {}) {
    return postJson(
      "/sync/v2/mutations:batch",
      { mutations },
      {
        signal,
        communicationScene: "sync-v2-mutation",
        task: syncTask("mutation-batch", "P0"),
      }
    ).then(({ data }) => data);
  },
};

export default syncV2Client;
