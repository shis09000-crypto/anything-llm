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

  async getKnowledgeProfile(slug) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await fetch(`${API_BASE}/workspace/${slug}/knowledge/profile`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async updateKnowledgeProfile(slug, body = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await fetch(`${API_BASE}/workspace/${slug}/knowledge/profile`, {
      method: "POST",
      headers: {
        ...baseHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async listWorkspaceSupplements(slug, params = {}) {
    if (!slug) return { success: false, supplements: [] };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements${query}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async workspaceSupplementPrompt(slug, params = {}) {
    if (!slug) return { success: false, prompt: "" };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements/prompt${query}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async workspaceSupplementToolManifestPreview(slug, params = {}) {
    if (!slug) return { success: false, manifest: null };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements/tool-manifest-preview${query}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({
        success: false,
        manifest: null,
        error: error.message,
      }));
  },

  async createWorkspaceSupplementText(slug, body = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements/text`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async uploadWorkspaceSupplement(slug, formData) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements/upload`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: formData,
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async bindWorkspaceSupplement(slug, body = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements/bind`,
      {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async deleteWorkspaceSupplement(slug, id) {
    if (!slug || !id) return { success: false, error: "missing_supplement" };
    return await fetch(
      `${API_BASE}/workspace/${slug}/workspace-supplements/${id}`,
      {
        method: "DELETE",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async listVisualAssets(slug, params = {}) {
    if (!slug) return { success: false, assets: [] };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await fetch(`${API_BASE}/workspace/${slug}/visual-assets${query}`, {
      method: "GET",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((error) => ({ success: false, assets: [], error: error.message }));
  },

  async uploadVisualAsset(slug, formData) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await fetch(`${API_BASE}/workspace/${slug}/visual-assets/upload`, {
      method: "POST",
      headers: baseHeaders(),
      body: formData,
    })
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async deleteVisualAsset(slug, id) {
    if (!slug || !id) return { success: false, error: "missing_visual_asset" };
    return await fetch(`${API_BASE}/workspace/${slug}/visual-assets/${id}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },
};

export default WorkspaceOverview;
