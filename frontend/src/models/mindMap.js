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

  async graphPath(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/path?${searchParams.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载推理路径失败。");
        return data;
      })
      .catch((error) => ({ error: error.message }));
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

  async nodeEvidence(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/evidence/node?${searchParams.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载节点证据失败。");
        return data.evidence;
      })
      .catch((error) => ({ error: error.message }));
  },

  async edgeEvidence(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/evidence/edge?${searchParams.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载关系证据失败。");
        return data.evidence;
      })
      .catch((error) => ({ error: error.message }));
  },

  async recordEvidenceUsage(slug, body = {}) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/evidence/usage`,
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

  async nodeMetrics(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/node-metrics?${searchParams.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载重要性指标失败。");
        return data.metrics;
      })
      .catch((error) => ({ error: error.message }));
  },

  async graphContext(slug, body = {}) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/graph-context`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "加载节点上下文失败。");
        return data.context;
      })
      .catch((error) => ({ error: error.message }));
  },

  async resolveNode(slug, body = {}) {
    return await fetch(`${API_BASE}/workspace/${slug}/knowledge/resolve-node`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok && !data?.candidates)
          throw new Error(data.error || data.reason || "解析节点身份失败。");
        return data;
      })
      .catch((error) => ({ success: false, error: error.message }));
  },

  async recomputeNodeMetrics(slug, body = {}) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/knowledge/node-metrics/recompute`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "请求重算指标失败。");
        return data.result;
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
