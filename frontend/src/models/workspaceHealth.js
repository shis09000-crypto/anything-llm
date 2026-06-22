import { getJson, postJson } from "@/lib/communication/apiClient";

const WorkspaceHealth = {
  async beacon(slug) {
    if (!slug) return { error: "missing_workspace" };
    return await getJson(`/workspace/${slug}/health/beacon`)
      .then(({ data }) => data.beacon || null)
      .catch(() => ({
        unknown: true,
        score: null,
        status: "unknown",
        summary: "健康状态暂时不可用",
      }));
  },

  async refresh(slug) {
    if (!slug) return { error: "missing_workspace" };
    return await postJson(`/workspace/${slug}/health/refresh`)
      .then(({ data }) => data.beacon || null)
      .catch(() => ({
        unknown: true,
        score: null,
        status: "unknown",
        summary: "健康状态暂时不可用",
      }));
  },
};

export default WorkspaceHealth;
