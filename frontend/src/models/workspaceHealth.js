import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const WorkspaceHealth = {
  async beacon(slug) {
    if (!slug) return { error: "missing_workspace" };
    return await fetch(`${API_BASE}/workspace/${slug}/health/beacon`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((data) => data.beacon || null)
      .catch(() => ({
        unknown: true,
        score: null,
        status: "unknown",
        summary: "健康状态暂时不可用",
      }));
  },

  async refresh(slug) {
    if (!slug) return { error: "missing_workspace" };
    return await fetch(`${API_BASE}/workspace/${slug}/health/refresh`, {
      method: "POST",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((data) => data.beacon || null)
      .catch(() => ({
        unknown: true,
        score: null,
        status: "unknown",
        summary: "健康状态暂时不可用",
      }));
  },
};

export default WorkspaceHealth;
