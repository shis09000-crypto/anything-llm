import { getJson, patchJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorMessage, apiErrorRaw } from "@/lib/communication/apiError";

function responseError(error, fallback) {
  return apiErrorRaw(error)?.reason || apiErrorMessage(error, fallback);
}

const MindMap = {
  async list(slug, threadSlug = null) {
    const params = new URLSearchParams();
    if (threadSlug) params.set("threadSlug", threadSlug);
    const query = params.toString() ? `?${params.toString()}` : "";
    return await getJson(`/workspace/${slug}/mind-maps${query}`)
      .then(({ data }) => data.mindMaps || [])
      .catch(() => []);
  },

  async generate(slug, body = {}) {
    return await postJson(`/workspace/${slug}/mind-maps/generate`, body)
      .then(({ data }) => data)
      .catch((error) => ({
        error: responseError(error, "生成思维导图失败。"),
      }));
  },

  async graph(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await getJson(
      `/workspace/${slug}/mind-maps/graph?${searchParams.toString()}`
    )
      .then(({ data }) => data)
      .catch((error) => ({
        error: responseError(error, "加载知识图谱失败。"),
      }));
  },

  async concepts(slug, query = "", limit = 10) {
    if (!query?.trim()) return [];
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return await getJson(
      `/workspace/${slug}/knowledge/concepts?${params.toString()}`
    )
      .then(({ data }) => data.concepts || [])
      .catch(() => []);
  },

  async graphStats(slug) {
    return await getJson(`/workspace/${slug}/knowledge/stats`)
      .then(({ data }) => data.stats || null)
      .catch(() => null);
  },

  async graphPath(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await getJson(
      `/workspace/${slug}/knowledge/path?${searchParams.toString()}`
    )
      .then(({ data }) => data)
      .catch((error) => ({
        error: responseError(error, "加载推理路径失败。"),
      }));
  },

  async repairStatus(slug) {
    return await getJson(`/workspace/${slug}/knowledge/repair-status`)
      .then(({ data }) => data.repair || null)
      .catch(() => null);
  },

  async repair(slug, body = {}) {
    return await postJson(`/workspace/${slug}/knowledge/repair`, body)
      .then(({ data }) => data.result)
      .catch((error) => ({
        error: responseError(error, "知识图谱修复失败。"),
      }));
  },

  async releaseQuarantine(slug, issueId) {
    return await postJson(
      `/workspace/${slug}/knowledge/repair/quarantine/${issueId}/release`
    )
      .then(({ data }) => data.issue)
      .catch((error) => ({
        error: responseError(error, "解除隔离失败。"),
      }));
  },

  async nodeEvidence(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await getJson(
      `/workspace/${slug}/knowledge/evidence/node?${searchParams.toString()}`
    )
      .then(({ data }) => data.evidence)
      .catch((error) => ({
        error: responseError(error, "加载节点证据失败。"),
      }));
  },

  async edgeEvidence(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await getJson(
      `/workspace/${slug}/knowledge/evidence/edge?${searchParams.toString()}`
    )
      .then(({ data }) => data.evidence)
      .catch((error) => ({
        error: responseError(error, "加载关系证据失败。"),
      }));
  },

  async recordEvidenceUsage(slug, body = {}) {
    return await postJson(`/workspace/${slug}/knowledge/evidence/usage`, body)
      .then(({ data }) => data)
      .catch(() => null);
  },

  async nodeMetrics(slug, params = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    return await getJson(
      `/workspace/${slug}/knowledge/node-metrics?${searchParams.toString()}`
    )
      .then(({ data }) => data.metrics)
      .catch((error) => ({
        error: responseError(error, "加载重要性指标失败。"),
      }));
  },

  async graphContext(slug, body = {}) {
    return await postJson(`/workspace/${slug}/knowledge/graph-context`, body)
      .then(({ data }) => data.context)
      .catch((error) => ({
        error: responseError(error, "加载节点上下文失败。"),
      }));
  },

  async resolveNode(slug, body = {}) {
    return await postJson(`/workspace/${slug}/knowledge/resolve-node`, body)
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.raw?.candidates) return error.raw;
        return {
          success: false,
          error: responseError(error, "解析节点身份失败。"),
        };
      });
  },

  async recomputeNodeMetrics(slug, body = {}) {
    return await postJson(
      `/workspace/${slug}/knowledge/node-metrics/recompute`,
      body
    )
      .then(({ data }) => data.result)
      .catch((error) => ({
        error: responseError(error, "请求重算指标失败。"),
      }));
  },

  async updateViewport(slug, id, viewport = null) {
    if (!id) return null;
    return await patchJson(`/workspace/${slug}/mind-maps/${id}/viewport`, {
      viewport,
    })
      .then(({ data }) => data)
      .catch(() => null);
  },
};

export default MindMap;
