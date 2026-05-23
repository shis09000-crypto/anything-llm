import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const MindMap = {
  async list(slug, threadSlug = null) {
    const params = new URLSearchParams();
    if (threadSlug) params.set("threadSlug", threadSlug);
    const query = params.toString() ? `?${params.toString()}` : "";
    return await fetch(`${API_BASE}/workspace/${slug}/mind-maps${query}`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((data) => data.mindMaps || [])
      .catch(() => []);
  },

  async generate(slug, body = {}) {
    return await fetch(`${API_BASE}/workspace/${slug}/mind-maps/generate`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "生成思维导图失败。");
        return data;
      })
      .catch((error) => ({ error: error.message }));
  },

  async graph(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await fetch(
      `${API_BASE}/workspace/${slug}/mind-maps/graph?${searchParams.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载知识图谱失败。");
        return data;
      })
      .catch((error) => ({ error: error.message }));
  },

  async concepts(slug, query = "", limit = 10) {
    if (!query?.trim()) return [];
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/concepts?${params.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .then((data) => data.concepts || [])
      .catch(() => []);
  },

  async graphStats(slug) {
    return await fetch(`${API_BASE}/workspace/${slug}/knowledge/stats`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .then((data) => data.stats || null)
      .catch(() => null);
  },

  async repairStatus(slug) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/repair-status`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .then((data) => data.repair || null)
      .catch(() => null);
  },

  async repair(slug, body = {}) {
    return await fetch(`${API_BASE}/workspace/${slug}/knowledge/repair`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "知识图谱修复失败。");
        return data.result;
      })
      .catch((error) => ({ error: error.message }));
  },

  async releaseQuarantine(slug, issueId) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/repair/quarantine/${issueId}/release`,
      {
        method: "POST",
        headers: baseHeaders(),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "解除隔离失败。");
        return data.issue;
      })
      .catch((error) => ({ error: error.message }));
  },

  async updateViewport(slug, id, viewport = null) {
    if (!id) return null;
    return await fetch(
      `${API_BASE}/workspace/${slug}/mind-maps/${id}/viewport`,
      {
        method: "PATCH",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ viewport }),
      }
    )
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
  },
};

export default MindMap;
