import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
  isApiAbortError,
} from "@/lib/communication/apiError";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";

function overviewTask(label, slug, surface = "workspace-overview") {
  return {
    label,
    kind: "workspace-overview",
    priority: "P1",
    policy: "visible",
    resource: "network",
    abortable: true,
    scope: {
      route: "workspace-chat",
      surface,
      ...(slug ? { workspaceSlug: slug } : {}),
    },
  };
}

function overviewActionTask(label, slug, surface = "workspace-overview") {
  return {
    ...overviewTask(label, slug, surface),
    priority: "P0",
    policy: "foreground",
    protected: true,
    abortable: false,
    intentRank: 3,
  };
}

function overviewInitialLoadTask(slug) {
  return {
    ...overviewTask("workspace-overview:get", slug),
    protected: true,
    abortable: false,
    intentRank: 2,
  };
}

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
      communicationScene: options.communicationScene || "workspace-overview",
      onRequestMetadata: options.onRequestMetadata,
      task:
        options.task === undefined
          ? overviewInitialLoadTask(slug)
          : options.task,
    })
      .then(({ data }) => data.overview)
      .catch((error) => {
        if (isApiAbortError(error)) throw error;
        return {
          error: responseError(error, "加载工作区首页失败。"),
          failureKind: error?.status ? "http_error" : "network_error",
          requestId: error?.details?.requestId || "",
        };
      });
  },

  async recordUsage(slug, body = {}, options = {}) {
    if (!slug) return null;
    return await postJson(
      `/workspace/${slug}/overview/recommendation-usage`,
      body,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-overview",
        task:
          options.task === undefined
            ? overviewTask("workspace-overview:record-usage", slug)
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch(() => null);
  },

  async getKnowledgeProfile(slug, options = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await getJson(`/workspace/${slug}/knowledge/profile`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-overview",
      task:
        options.task === undefined
          ? overviewTask("workspace-overview:knowledge-profile", slug)
          : options.task,
    })
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async updateKnowledgeProfile(slug, body = {}, options = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await postJson(`/workspace/${slug}/knowledge/profile`, body, {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-overview",
      task:
        options.task === undefined
          ? overviewActionTask("workspace-overview:update-knowledge", slug)
          : options.task,
    })
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async listWorkspaceSupplements(slug, params = {}, options = {}) {
    if (!slug) return { success: false, supplements: [] };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(`/workspace/${slug}/workspace-supplements${query}`, {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-supplement-visible",
      task:
        options.task === undefined
          ? overviewTask(
              "workspace-overview:list-supplements",
              slug,
              "workspace-supplements"
            )
          : options.task,
    })
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async workspaceSupplementPrompt(slug, params = {}, options = {}) {
    if (!slug) return { success: false, prompt: "" };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(
      `/workspace/${slug}/workspace-supplements/prompt${query}`,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-supplement-visible",
        task:
          options.task === undefined
            ? overviewTask(
                "workspace-overview:supplement-prompt",
                slug,
                "workspace-supplements"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async workspaceSupplementToolManifestPreview(
    slug,
    params = {},
    options = {}
  ) {
    if (!slug) return { success: false, manifest: null };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(
      `/workspace/${slug}/workspace-supplements/tool-manifest-preview${query}`,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-supplement-visible",
        task:
          options.task === undefined
            ? overviewTask(
                "workspace-overview:supplement-tool-preview",
                slug,
                "workspace-supplements"
              )
            : options.task,
      }
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

  async createWorkspaceSupplementText(slug, body = {}, options = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await postJson(
      `/workspace/${slug}/workspace-supplements/text`,
      body,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-supplement-action",
        task:
          options.task === undefined
            ? overviewActionTask(
                "workspace-overview:create-supplement-text",
                slug,
                "workspace-supplements"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async uploadWorkspaceSupplement(slug, formData, options = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await uploadFormData(
      `/workspace/${slug}/workspace-supplements/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.workspaceSupplement,
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-supplement-action",
        task:
          options.task === undefined
            ? overviewActionTask(
                "workspace-overview:upload-supplement",
                slug,
                "workspace-supplements"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async bindWorkspaceSupplement(slug, body = {}, options = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await postJson(
      `/workspace/${slug}/workspace-supplements/bind`,
      body,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-supplement-action",
        task:
          options.task === undefined
            ? overviewActionTask(
                "workspace-overview:bind-supplement",
                slug,
                "workspace-supplements"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async deleteWorkspaceSupplement(slug, id, options = {}) {
    if (!slug || !id) return { success: false, error: "missing_supplement" };
    return await deleteJson(`/workspace/${slug}/workspace-supplements/${id}`, {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-supplement-action",
      task:
        options.task === undefined
          ? overviewActionTask(
              "workspace-overview:delete-supplement",
              slug,
              "workspace-supplements"
            )
          : options.task,
    })
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },

  async listVisualAssets(slug, params = {}, options = {}) {
    if (!slug) return { success: false, assets: [] };
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      searchParams.set(key, value);
    });
    const query = searchParams.toString() ? `?${searchParams.toString()}` : "";
    return await getJson(`/workspace/${slug}/visual-assets${query}`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "visual-assets",
      task:
        options.task === undefined
          ? overviewTask("workspace-overview:list-visual-assets", slug)
          : options.task,
    })
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, {
          success: false,
          assets: [],
          error: error.message,
        })
      );
  },

  async uploadVisualAsset(slug, formData, options = {}) {
    if (!slug) return { success: false, error: "missing_workspace" };
    return await uploadFormData(
      `/workspace/${slug}/visual-assets/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.visualAsset,
        signal: options.signal,
        communicationScene: options.communicationScene || "visual-assets",
        task:
          options.task === undefined
            ? overviewActionTask("workspace-overview:upload-visual-asset", slug)
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async deleteVisualAsset(slug, id, options = {}) {
    if (!slug || !id) return { success: false, error: "missing_visual_asset" };
    return await deleteJson(`/workspace/${slug}/visual-assets/${id}`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "visual-assets",
      task:
        options.task === undefined
          ? overviewActionTask("workspace-overview:delete-visual-asset", slug)
          : options.task,
    })
      .then(({ data }) => data)
      .catch((error) =>
        rawOrFallback(error, { success: false, error: error.message })
      );
  },
};

export default WorkspaceOverview;
