import { deleteJson, postJson } from "@/lib/communication/apiClient";

const AgentPlugins = {
  toggleFeature: async function (hubId, active = false) {
    return await postJson(`/experimental/agent-plugins/${hubId}/toggle`, {
      active,
    })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  updatePluginConfig: async function (hubId, updates = {}) {
    return await postJson(`/experimental/agent-plugins/${hubId}/config`, {
      updates,
    })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  deletePlugin: async function (hubId) {
    return await deleteJson(`/experimental/agent-plugins/${hubId}`)
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
};

export default AgentPlugins;
