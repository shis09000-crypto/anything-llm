import { getJson, patchJson, postJson } from "@/lib/communication/apiClient";
import { postJsonSse } from "@/lib/communication/streamClient";

function cognitiveTask(label, slug, protectedTask = false) {
  return {
    label,
    kind: "workspace-cognition",
    priority: protectedTask ? "P0" : "P1",
    policy: protectedTask ? "foreground" : "visible",
    resource: "network",
    protected: protectedTask,
    abortable: !protectedTask,
    scope: {
      route: "workspace-chat",
      surface: "workspace-cognition",
      workspaceSlug: slug,
    },
  };
}

async function unwrap(promise, fallback = {}) {
  return promise
    .then(({ data }) => data)
    .catch((error) => ({ success: false, error: error.message, ...fallback }));
}

const WorkspaceCognition = {
  profile(slug) {
    return unwrap(
      getJson(`/workspace/${slug}/cognition/profile`, {
        communicationScene: "workspace-cognition",
        task: cognitiveTask("cognition:profile", slug),
      }),
      { profile: null }
    );
  },

  items(slug, params = {}) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "")
        search.set(key, value);
    });
    const query = search.toString() ? `?${search.toString()}` : "";
    return unwrap(
      getJson(`/workspace/${slug}/cognition/items${query}`, {
        communicationScene: "workspace-cognition",
        task: cognitiveTask("cognition:items", slug),
      }),
      { assertions: [], positions: [], evidence: [], relations: [] }
    );
  },

  candidates(slug, params = {}) {
    const search = new URLSearchParams(params).toString();
    return unwrap(
      getJson(
        `/workspace/${slug}/cognition/candidates${search ? `?${search}` : ""}`,
        {
          communicationScene: "workspace-cognition",
          task: cognitiveTask("cognition:candidates", slug),
        }
      ),
      { candidates: [] }
    );
  },

  extractionState(slug) {
    return unwrap(
      getJson(`/workspace/${slug}/cognition/extraction/state`, {
        communicationScene: "workspace-cognition",
        task: cognitiveTask("cognition:extraction-state", slug),
      }),
      { threads: [], jobs: [] }
    );
  },

  flush(slug, body = {}) {
    return unwrap(
      postJson(`/workspace/${slug}/cognition/extraction/flush`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:flush", slug, true),
      })
    );
  },

  retryJob(slug, id) {
    return unwrap(
      postJson(
        `/workspace/${slug}/cognition/extraction/jobs/${id}/retry`,
        {},
        {
          communicationScene: "workspace-cognition-action",
          task: cognitiveTask("cognition:retry-job", slug, true),
        }
      )
    );
  },

  reviewCandidate(slug, id, eventType, payload = {}) {
    return unwrap(
      postJson(
        `/workspace/${slug}/cognition/candidates/${id}/reviews`,
        {
          eventType,
          payload,
          idempotencyKey: crypto.randomUUID(),
        },
        {
          communicationScene: "workspace-cognition-action",
          task: cognitiveTask("cognition:review-candidate", slug, true),
        }
      )
    );
  },

  itemHistory(slug, itemKey) {
    return unwrap(
      getJson(`/workspace/${slug}/cognition/items/${itemKey}/history`, {
        communicationScene: "workspace-cognition",
        task: cognitiveTask("cognition:item-history", slug),
      }),
      { items: [], relations: [] }
    );
  },

  ledger(slug) {
    return unwrap(
      getJson(`/workspace/${slug}/cognition/ledger`, {
        communicationScene: "workspace-cognition",
        task: cognitiveTask("cognition:ledger", slug),
      }),
      { items: [], relations: [] }
    );
  },

  createAssertion(slug, body) {
    return unwrap(
      postJson(`/workspace/${slug}/cognition/assertions`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:create-assertion", slug, true),
      })
    );
  },

  patchAssertion(slug, id, body) {
    return unwrap(
      patchJson(`/workspace/${slug}/cognition/assertions/${id}`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:patch-assertion", slug, true),
      })
    );
  },

  patchPosition(slug, id, body) {
    return unwrap(
      patchJson(`/workspace/${slug}/cognition/positions/${id}`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:patch-position", slug, true),
      })
    );
  },

  patchEvidence(slug, id, body) {
    return unwrap(
      patchJson(`/workspace/${slug}/cognition/evidence/${id}`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:patch-evidence", slug, true),
      })
    );
  },

  extractThread(slug, body) {
    return unwrap(
      postJson(`/workspace/${slug}/cognition/extract-thread`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:extract-thread", slug, true),
      })
    );
  },

  createRelation(slug, body) {
    return unwrap(
      postJson(`/workspace/${slug}/cognition/relations`, body, {
        communicationScene: "workspace-cognition-action",
        task: cognitiveTask("cognition:create-relation", slug, true),
      })
    );
  },

  rebuildProfile(slug) {
    return unwrap(
      postJson(
        `/workspace/${slug}/cognition/profile/rebuild`,
        {},
        {
          communicationScene: "workspace-cognition-action",
          task: cognitiveTask("cognition:rebuild-profile", slug, true),
        }
      )
    );
  },

  importAccountMemory(slug, memoryIds) {
    return unwrap(
      postJson(
        `/workspace/${slug}/cognition/import-account-memory`,
        { memoryIds },
        {
          communicationScene: "workspace-cognition-action",
          task: cognitiveTask("cognition:import-memory", slug, true),
        }
      )
    );
  },

  meetingPackets(slug) {
    return unwrap(
      getJson(`/workspace/${slug}/meeting-packets`, {
        communicationScene: "workspace-cognition",
        task: cognitiveTask("meeting:list-packets", slug),
      }),
      { packets: [] }
    );
  },

  createMeetingPacket(slug, body) {
    return unwrap(
      postJson(`/workspace/${slug}/meeting-packets`, body, {
        communicationScene: "meeting-packet-action",
        task: cognitiveTask("meeting:create-packet", slug, true),
      })
    );
  },

  updateMeetingPacket(slug, id, body) {
    return unwrap(
      patchJson(`/workspace/${slug}/meeting-packets/${id}`, body, {
        communicationScene: "meeting-packet-action",
        task: cognitiveTask("meeting:update-packet", slug, true),
      })
    );
  },

  freezeMeetingPacket(slug, id) {
    return unwrap(
      postJson(
        `/workspace/${slug}/meeting-packets/${id}/freeze`,
        {},
        {
          communicationScene: "meeting-packet-action",
          task: cognitiveTask("meeting:freeze-packet", slug, true),
        }
      )
    );
  },

  revokeMeetingPacket(slug, id) {
    return unwrap(
      postJson(
        `/workspace/${slug}/meeting-packets/${id}/revoke`,
        {},
        {
          communicationScene: "meeting-packet-action",
          task: cognitiveTask("meeting:revoke-packet", slug, true),
        }
      )
    );
  },

  startMeetingSession(slug, meetingPacketId) {
    return unwrap(
      postJson(
        `/workspace/${slug}/meeting-sessions`,
        { meetingPacketId },
        {
          communicationScene: "meeting-session-action",
          task: cognitiveTask("meeting:start-session", slug, true),
        }
      )
    );
  },

  async streamMeetingSession({
    slug,
    sessionId,
    body,
    onMessage,
    onError,
    onClose,
  }) {
    return postJsonSse({
      path: `/workspace/${slug}/meeting-sessions/${sessionId}/chat/stream`,
      body,
      communicationScene: "meeting-session",
      task: {
        ...cognitiveTask("meeting:stream", slug, true),
        kind: "chat-stream",
        policy: "realtime",
      },
      onMessage,
      onError,
      onClose,
    });
  },

  respondMeetingApproval(slug, sessionId, requestId, approved) {
    return unwrap(
      postJson(
        `/workspace/${slug}/meeting-sessions/${sessionId}/approvals/${requestId}`,
        { approved },
        {
          communicationScene: "meeting-session-approval",
          task: cognitiveTask("meeting:approval", slug, true),
        }
      )
    );
  },

  meetingAudit(slug, sessionId) {
    return unwrap(
      getJson(`/workspace/${slug}/meeting-sessions/${sessionId}/audit`, {
        communicationScene: "meeting-session",
        task: cognitiveTask("meeting:audit", slug),
      }),
      { audit: [] }
    );
  },
};

export default WorkspaceCognition;
