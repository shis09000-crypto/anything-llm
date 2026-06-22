import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
} from "@/lib/communication/apiError";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";

const WorkspaceOverview = {
  async get(slug, params = {}, options = {}) {
    if (!slug) return { error: "missing_workspace" };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(`/workspace/${slug}/overview${query}`, {
      signal: options.signal,
    })
      .then(({ data }) => data.overview)
      .catch((error) => ({
        error: responseError(error, "加载工作区首页失败。"),
      }));
  },

  async recordUsage(slug, body = {}) {
    if (!slug) return null;
    return await postJson(
      `/workspace/${slug}/overview/recommendation-usage`,
      body
    )
      .then(({ data }) => data)
      .catch(() => null);
  },

  async getKnowledgeProfile(slug) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await getJson(`/workspace/${slug}/knowledge/profile`)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async updateKnowledgeProfile(slug, body = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await postJson(`/workspace/${slug}/knowledge/profile`, body)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async listWorkspaceSupplements(slug, params = {}) {
    if (!slug) return { success: false, supplements: [] };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(`/workspace/${slug}/workspace-supplements${query}`)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async workspaceSupplementPrompt(slug, params = {}) {
    if (!slug) return { success: false, prompt: "" };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(
      `/workspace/${slug}/workspace-supplements/prompt${query}`
    )
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async workspaceSupplementToolManifestPreview(slug, params = {}) {
    if (!slug) return { success: false, manifest: null };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(
      `/workspace/${slug}/workspace-supplements/tool-manifest-preview${query}`
    )
      .then(({ data }) => data)
      .catch((error) => ({
        ...rawOrFallback(error, {
          success: false,
          manifest: null,
          error: error.message,
        }),
      }));
  },

  async createWorkspaceSupplementText(slug, body = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await postJson(`/workspace/${slug}/workspace-supplements/text`, body)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async uploadWorkspaceSupplement(slug, formData) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await uploadFormData(
      `/workspace/${slug}/workspace-supplements/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.workspaceSupplement,
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async bindWorkspaceSupplement(slug, body = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await postJson(`/workspace/${slug}/workspace-supplements/bind`, body)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async deleteWorkspaceSupplement(slug, id) {
    if (!slug || !id) return { success: false, error: "missing_supplement" };
    return await deleteJson(`/workspace/${slug}/workspace-supplements/${id}`)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async listVisualAssets(slug, params = {}) {
    if (!slug) return { success: false, assets: [] };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(`/workspace/${slug}/visual-assets${query}`)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, {
          success: false,
          assets: [],
          error: error.message,
        })
      );
  },

  async uploadVisualAsset(slug, formData) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await uploadFormData(
      `/workspace/${slug}/visual-assets/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.visualAsset,
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async deleteVisualAsset(slug, id) {
    if (!slug || !id) return { success: false, error: "missing_visual_asset" };
    return await deleteJson(`/workspace/${slug}/visual-assets/${id}`)
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },
};

export default WorkspaceOverview;
