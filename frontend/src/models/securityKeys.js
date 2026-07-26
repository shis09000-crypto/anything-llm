import { getJson, postJson } from "@/lib/communication/apiClient";
import { sensitiveSessionCenter } from "@/utils/sensitive/sensitiveSessionCenter";

const target = {
  resourceType: "key-control",
  resourceId: "global",
  ownerScope: "system:key-control",
};

function sensitiveOptions(action) {
  return {
    signing: "required",
    communicationScene: "key-governance",
    headers: sensitiveSessionCenter.headers(target),
    task: {
      kind: "key-governance",
      label: `key-governance:${action}`,
      scope: { domain: "security", action },
      priority: "P0",
      policy: "foreground",
      resource: "network",
      protected: true,
      abortable: false,
      dedupeKey: `key-governance:${action}`,
    },
  };
}

const SecurityKeys = {
  async status() {
    const { data } = await getJson("/admin/security/keys/status", {
      communicationScene: "key-governance",
    });
    return data;
  },

  async unlock(currentPassword) {
    const { data } = await postJson(
      "/admin/security/keys/session",
      { currentPassword },
      { signing: "required", communicationScene: "key-governance" }
    );
    if (data?.sensitiveSession) {
      sensitiveSessionCenter.beginViewer(data.sensitiveSession, {
        ...target,
        exclusiveByResourceType: true,
      });
    }
    return data;
  },

  async preflight() {
    const { data } = await postJson(
      "/admin/security/keys/preflight",
      {},
      sensitiveOptions("preflight")
    );
    return data;
  },

  async prepareRotation() {
    const idempotencyKey = globalThis.crypto?.randomUUID?.() || `${Date.now()}`;
    const { data } = await postJson(
      "/admin/security/keys/rotations",
      { idempotencyKey },
      sensitiveOptions("prepare-rotation")
    );
    return data;
  },

  async approveRotation(jobId) {
    const approvalId = globalThis.crypto?.randomUUID?.() || `${Date.now()}`;
    const options = sensitiveOptions("approve-rotation");
    const { data } = await postJson(
      `/admin/security/keys/rotations/${encodeURIComponent(jobId)}/approve`,
      { approvalId },
      {
        ...options,
        headers: { ...options.headers, "Idempotency-Key": approvalId },
      }
    );
    return data;
  },

  async executeRotation(jobId) {
    const { data } = await postJson(
      `/admin/security/keys/rotations/${encodeURIComponent(jobId)}/execute`,
      {},
      sensitiveOptions("execute-rotation")
    );
    return data;
  },

  close() {
    return sensitiveSessionCenter.endViewer(target, "key-center-close");
  },
};

export default SecurityKeys;
