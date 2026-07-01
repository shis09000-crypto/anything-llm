import { getJson, postJson } from "@/lib/communication/apiClient";

const WorkspaceHealth = {
  async beacon(slug, options = {}) {
    if (!slug) return { error: "missing_workspace" };
    return await getJson(`/workspace/${slug}/health/beacon`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "health-idle",
    })
      .then(({ data }) => data.beacon || null)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return {
          unknown: true,
          score: null,
          status: "unknown",
          summary: "健康状态暂时不可用",
        };
      });
  },

  async refresh(slug, options = {}) {
    if (!slug) return { error: "missing_workspace" };
    return await postJson(`/workspace/${slug}/health/refresh`, null, {
      signal: options.signal,
      communicationScene: options.communicationScene || "settings-tab",
    })
      .then(({ data }) => data.beacon || null)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return {
          unknown: true,
          score: null,
          status: "unknown",
          summary: "健康状态暂时不可用",
        };
      });
  },
};

export default WorkspaceHealth;
