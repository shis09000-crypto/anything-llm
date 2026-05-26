import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const WorkspaceOverview = {
  async get(slug, params = {}, options = {}) {
    if (!slug) return { error: "missing_workspace" };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await fetch(`${API_BASE}/workspace/${slug}/overview${query}`, {
      method: "GET",
      headers: baseHeaders(),
      signal: options.signal,
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载工作区首页失败。");
        return data.overview;
      })
      .catch((error) => ({ error: error.message }));
  },

  async recordUsage(slug, body = {}) {
    if (!slug) return null;
    return await fetch(
      `${API_BASE}/workspace/${slug}/overview/recommendation-usage`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    )
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  },
};

export default WorkspaceOverview;
