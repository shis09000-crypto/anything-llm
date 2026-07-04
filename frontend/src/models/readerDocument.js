import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";
import { readerServerStateStore } from "@/utils/serverState/readerServerStateStore";
import { sensitiveSessionCenter } from "@/utils/sensitive/sensitiveSessionCenter";
import {
  READER_DOCUMENT_RESOURCE_TYPE,
  readerAccessDescriptorForDocument,
  readerAccessDescriptorFromUrl,
  readerSessionMatchesDescriptor,
  normalizeReaderDocumentLinks,
} from "@/utils/chat/readerLinkMaintenance";

function readerDocumentsPath(slug = null) {
  return slug ? `/workspace/${slug}/reader-documents` : "/reader-documents";
}

function withReaderQuery(path, options = {}) {
  const params = new URLSearchParams();
  if (options.detail) params.set("detail", options.detail);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function pagePreviewUrlForOriginal(originalUrl, pageNumber = 1) {
  const url = String(originalUrl || "");
  if (!url) return null;
  const base = url.replace(/\/original(?:\?.*)?$/i, "/page-preview");
  if (base === url) return null;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}page=${Math.max(1, Math.round(Number(pageNumber) || 1))}`;
}

function readerDocumentDebug(stage, detail = {}) {
  if (typeof window === "undefined") return;
  const payload = {
    stage,
    at: Math.round(window.performance?.now?.() || Date.now()),
    ...detail,
  };
  window.dispatchEvent(
    new CustomEvent("athena-reader-document-stage", { detail: payload })
  );
  const debugEnabled =
    window.__ATHENA_READER_DEBUG__ === true ||
    window.localStorage?.getItem?.("athenaReaderDebug") === "true" ||
    window.location?.search?.includes("athenaReaderDebug=1");
  if (debugEnabled) console.debug("[reader:document]", payload);
}

function storeReaderSensitiveSession(documentData = {}, fallbackId = null) {
  const session = documentData?.sensitiveSession;
  const descriptor = readerAccessDescriptorForDocument(
    documentData,
    fallbackId
  );
  if (!session || !descriptor?.readerDocumentId) {
    readerDocumentDebug("sensitive-session-missing", {
      readerDocumentId: fallbackId || documentData?.readerDocumentId || null,
      hasSession: !!session,
      hasDescriptor: !!descriptor?.readerDocumentId,
    });
    return null;
  }
  const storedSession = sensitiveSessionCenter.beginViewer(session, {
    resourceType: READER_DOCUMENT_RESOURCE_TYPE,
    resourceId: descriptor.resourceId,
    aliasResourceIds: [descriptor.readerDocumentId],
    ownerScope: descriptor.ownerScope || session.ownerScope || null,
    exclusiveByResourceType: true,
    reason: "reader-open",
  });
  readerDocumentDebug("sensitive-session-stored", {
    readerDocumentId: descriptor.readerDocumentId,
    namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
    resourceId: descriptor.resourceId,
    ownerScope: descriptor.ownerScope,
    hasToken: !!storedSession?.token,
  });
  return storedSession;
}

function isReaderAuthError(errorOrResponse = null) {
  const status = Number(
    errorOrResponse?.status ||
      errorOrResponse?.response?.status ||
      errorOrResponse?.details?.status ||
      0
  );
  if ([401, 403].includes(status)) return true;
  const message = String(errorOrResponse?.message || errorOrResponse || "");
  return /\b(401|403)\b/.test(message);
}

async function fetchReaderDocumentDirect(slug, readerDocumentId, options = {}) {
  readerDocumentDebug("direct-fetch-start", {
    readerDocumentId,
    workspaceSlug: slug || null,
    detail: options.detail || null,
  });
  const { response, data } = await getJson(
    withReaderQuery(`${readerDocumentsPath(slug)}/${readerDocumentId}`, {
      detail: options.detail,
    }),
    {
      signal: options.signal,
      communicationScene: "reader-open",
      task: options.task,
    }
  );
  const normalizedData = normalizeReaderDocumentLinks(data, {
    workspaceSlug: slug,
    readerDocumentId,
  });
  readerDocumentDebug("direct-fetch-done", {
    readerDocumentId,
    workspaceSlug: slug || null,
    detail: options.detail || null,
    status: response?.status || 0,
    success: normalizedData?.success === true,
    hasMetadata: !!normalizedData?.metadata,
    hasSensitiveSession: !!normalizedData?.sensitiveSession,
    originalUrl: normalizedData?.metadata?.originalUrl || null,
  });
  if (response.ok && normalizedData?.success) {
    const storedSession = storeReaderSensitiveSession(
      normalizedData,
      readerDocumentId
    );
    readerDocumentDebug("direct-fetch-session-state", {
      readerDocumentId,
      workspaceSlug: slug || null,
      hasStoredSession: !!storedSession?.token,
      ownerScope: storedSession?.ownerScope || null,
    });
    if (options.cache !== false)
      readerServerStateStore.upsertDocument(slug, normalizedData);
  }
  return {
    response,
    data: normalizedData || { success: false },
  };
}

export async function refreshReaderSensitiveSessionForUrl(
  url = "",
  options = {}
) {
  const descriptor = readerAccessDescriptorFromUrl(url);
  if (!descriptor?.readerDocumentId) {
    readerDocumentDebug("sensitive-session-refresh-skipped", {
      reason: "missing-descriptor",
      url,
    });
    return null;
  }
  readerDocumentDebug("sensitive-session-refresh-start", {
    readerDocumentId: descriptor.readerDocumentId,
    namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
    workspaceSlug: descriptor.workspaceSlug || null,
    ownerScope: descriptor.ownerScope || null,
  });
  const result = await fetchReaderDocumentDirect(
    descriptor.workspaceSlug || null,
    descriptor.readerDocumentId,
    {
      detail: "metadata",
      signal: options.signal,
      task: options.task,
    }
  );
  const ok = result?.response?.ok && result?.data?.success;
  readerDocumentDebug("sensitive-session-refresh-done", {
    readerDocumentId: descriptor.readerDocumentId,
    namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
    status: result?.response?.status || 0,
    success: !!ok,
    hasSensitiveSession: !!result?.data?.sensitiveSession,
    hasHeader: readerSensitiveSessionStateForUrl(
      result?.data?.metadata?.originalUrl || url
    ).hasHeader,
  });
  return ok ? result.data : null;
}

export function readerSensitiveHeadersForUrl(url = "") {
  const state = readerSensitiveSessionStateForUrl(url);
  return state.hasHeader ? { "X-Athena-Sensitive-Session": state.token } : {};
}

export function readerSensitiveSessionStateForUrl(url = "") {
  const descriptor = readerAccessDescriptorFromUrl(url);
  if (!descriptor)
    return {
      hasDescriptor: false,
      hasDirectSession: false,
      hasAliasSession: false,
      hasHeader: false,
      token: null,
    };
  const directSession = sensitiveSessionCenter.get({
    resourceType: READER_DOCUMENT_RESOURCE_TYPE,
    resourceId: descriptor.resourceId,
  });
  if (readerSessionMatchesDescriptor(directSession, descriptor)) {
    return {
      hasDescriptor: true,
      readerDocumentId: descriptor.readerDocumentId,
      namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
      resourceId: descriptor.resourceId,
      ownerScope: descriptor.ownerScope,
      hasDirectSession: true,
      hasAliasSession: false,
      hasHeader: true,
      token: directSession.token,
    };
  }
  const aliasSession = sensitiveSessionCenter.get({
    resourceType: READER_DOCUMENT_RESOURCE_TYPE,
    resourceId: descriptor.readerDocumentId,
  });
  if (readerSessionMatchesDescriptor(aliasSession, descriptor)) {
    return {
      hasDescriptor: true,
      readerDocumentId: descriptor.readerDocumentId,
      namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
      resourceId: descriptor.resourceId,
      ownerScope: descriptor.ownerScope,
      hasDirectSession: false,
      hasAliasSession: true,
      hasHeader: true,
      token: aliasSession.token,
    };
  }
  readerDocumentDebug("sensitive-header-missing", {
    readerDocumentId: descriptor.readerDocumentId,
    namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
    resourceId: descriptor.resourceId,
    ownerScope: descriptor.ownerScope,
  });
  return {
    hasDescriptor: true,
    readerDocumentId: descriptor.readerDocumentId,
    namespace: descriptor.workspaceSlug ? "workspace" : "standalone",
    resourceId: descriptor.resourceId,
    ownerScope: descriptor.ownerScope,
    hasDirectSession: false,
    hasAliasSession: false,
    hasHeader: false,
    token: null,
  };
}

const ReaderDocument = {
  list: async function (slug = null, options = {}) {
    try {
      const documents = await readerServerStateStore.ensureDocumentList(
        slug,
        async ({ signal }) => {
          const { data } = await getJson(readerDocumentsPath(slug), {
            signal,
            communicationScene: "reader-open",
            task: false,
          });
          if (!data?.success) return [];
          return data.documents || [];
        },
        {
          priority: options.task?.priority || "P1",
          intentRank: options.task?.intentRank ?? 3,
          staleWhileRevalidate: options.staleWhileRevalidate !== false,
          signal: options.signal,
          dedupeKey: `server-state:reader.documents:${slug || "global"}`,
          label: `reader:documents:${slug || "global"}`,
        }
      );
      const normalizedDocuments = (
        Array.isArray(documents) ? documents : []
      ).map((documentData) =>
        normalizeReaderDocumentLinks(documentData, { workspaceSlug: slug })
      );
      return {
        response: new Response(null, { status: 200 }),
        data: {
          success: true,
          documents: normalizedDocuments,
        },
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (options.allowCacheFallback === false) throw error;
      const cachedDocuments = readerServerStateStore.getDocumentList(slug, {
        allowStale: true,
      });
      if (!cachedDocuments) throw error;
      const normalizedDocuments = (
        Array.isArray(cachedDocuments) ? cachedDocuments : []
      ).map((documentData) =>
        normalizeReaderDocumentLinks(documentData, { workspaceSlug: slug })
      );
      return {
        response: new Response(null, { status: 200 }),
        data: {
          success: true,
          cached: true,
          stale: true,
          documents: normalizedDocuments,
        },
      };
    }
  },
  upload: async function (slug, formData, options = {}) {
    const { response, data } = await uploadFormData(
      `${readerDocumentsPath(slug)}/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.readerDocument,
        communicationScene: "reader-upload",
        ...options,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
    });
    if (response.ok && normalizedData?.success) {
      storeReaderSensitiveSession(normalizedData);
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  get: async function (slug, readerDocumentId, options = {}) {
    if (options.detail === "content" || options.freshSensitiveSession)
      return await fetchReaderDocumentDirect(slug, readerDocumentId, options);

    const data = await readerServerStateStore.ensureDocument(
      slug,
      readerDocumentId,
      async ({ signal }) => {
        const result = await getJson(
          withReaderQuery(`${readerDocumentsPath(slug)}/${readerDocumentId}`, {
            detail: options.detail,
          }),
          {
            signal,
            communicationScene: "reader-open",
            task: false,
          }
        );
        const normalizedData = normalizeReaderDocumentLinks(result.data, {
          workspaceSlug: slug,
          readerDocumentId,
        });
        const storedSession = storeReaderSensitiveSession(
          normalizedData,
          readerDocumentId
        );
        readerDocumentDebug("cache-fetch-session-state", {
          readerDocumentId,
          workspaceSlug: slug || null,
          hasStoredSession: !!storedSession?.token,
          ownerScope: storedSession?.ownerScope || null,
        });
        return normalizedData;
      },
      {
        priority: options.task?.priority || "P0",
        intentRank: options.task?.intentRank ?? 0,
        staleWhileRevalidate: options.staleWhileRevalidate !== false,
        signal: options.signal,
        dedupeKey: `server-state:reader.document:${slug || "global"}:${readerDocumentId}`,
        label: `reader:document:${readerDocumentId}`,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
      readerDocumentId,
    });
    if (normalizedData?.success)
      readerServerStateStore.upsertDocument(slug, normalizedData);
    return {
      response: new Response(null, { status: 200 }),
      data: normalizedData || { success: false },
    };
  },
  delete: async function (slug, readerDocumentId, options = {}) {
    const task =
      options.task === undefined
        ? {
            label: "reader:delete-document",
            kind: "reader",
            priority: "P0",
            policy: "foreground",
            resource: "network",
            protected: true,
            abortable: false,
            intentRank: 0,
            scope: {
              route: "workspace-chat",
              surface: "reader-delete",
              workspaceSlug: slug || null,
              readerDocumentId,
            },
          }
        : options.task;
    try {
      const { response, data } = await deleteJson(
        `${readerDocumentsPath(slug)}/${readerDocumentId}`,
        {
          ...options,
          communicationScene: options.communicationScene || "reader-action",
          task,
        }
      );
      if ((response.ok && data?.success) || response.status === 404) {
        readerServerStateStore.removeDocument(slug, readerDocumentId);
      }
      return { response, data };
    } catch (error) {
      if (error?.status === 404) {
        readerServerStateStore.removeDocument(slug, readerDocumentId);
      }
      throw error;
    }
  },
  originalBlob: async function (originalUrl, options = {}) {
    const requestOriginal = (url) =>
      requestBlob(url, {
        signal: options.signal,
        headers: {
          ...readerSensitiveHeadersForUrl(url),
          ...(options.headers || {}),
        },
        blobKind: BLOB_KINDS.readerOriginal,
        communicationScene: "reader-open",
        task: options.task,
      });
    try {
      const state = readerSensitiveSessionStateForUrl(originalUrl);
      readerDocumentDebug("original-blob-start", {
        urlNamespace: state.namespace || null,
        hasSensitiveHeader: state.hasHeader,
        hasDirectSession: state.hasDirectSession,
        hasAliasSession: state.hasAliasSession,
      });
      const { response, blob } = await requestOriginal(originalUrl);
      return { response, blob };
    } catch (error) {
      if (options.disableSensitiveRefresh || !isReaderAuthError(error))
        throw error;
      readerDocumentDebug("original-blob-auth-refresh", {
        message: error?.message || String(error),
      });
      const refreshed = await refreshReaderSensitiveSessionForUrl(originalUrl, {
        signal: options.signal,
        task: options.refreshTask || options.task,
      });
      const retryUrl = refreshed?.metadata?.originalUrl || originalUrl;
      const retryState = readerSensitiveSessionStateForUrl(retryUrl);
      readerDocumentDebug("original-blob-auth-retry", {
        refreshed: !!refreshed,
        hasSensitiveHeader: retryState.hasHeader,
        namespace: retryState.namespace || null,
      });
      const { response, blob } = await requestOriginal(retryUrl);
      return { response, blob };
    }
  },
  pagePreviewBlob: async function (originalUrl, pageNumber = 1, options = {}) {
    const previewUrl = pagePreviewUrlForOriginal(originalUrl, pageNumber);
    if (!previewUrl) throw new Error("Reader page preview URL unavailable.");
    const requestPreview = (url) =>
      requestBlob(url, {
        signal: options.signal,
        headers: {
          ...readerSensitiveHeadersForUrl(url),
          ...(options.headers || {}),
        },
        blobKind: BLOB_KINDS.readerPreview,
        communicationScene: "reader-open",
        task: options.task,
      });
    try {
      const { response, blob } = await requestPreview(previewUrl);
      return { response, blob, previewUrl };
    } catch (error) {
      if (options.disableSensitiveRefresh || !isReaderAuthError(error))
        throw error;
      const refreshed = await refreshReaderSensitiveSessionForUrl(originalUrl, {
        signal: options.signal,
        task: options.refreshTask || options.task,
      });
      const retryOriginalUrl = refreshed?.metadata?.originalUrl || originalUrl;
      const retryPreviewUrl =
        pagePreviewUrlForOriginal(retryOriginalUrl, pageNumber) || previewUrl;
      const { response, blob } = await requestPreview(retryPreviewUrl);
      return { response, blob, previewUrl: retryPreviewUrl };
    }
  },
  previewBlob: async function (previewUrl, options = {}) {
    const requestPreview = () =>
      requestBlob(previewUrl, {
        signal: options.signal,
        headers: {
          ...readerSensitiveHeadersForUrl(previewUrl),
          ...(options.headers || {}),
        },
        blobKind: BLOB_KINDS.readerPreview,
        communicationScene: "reader-open",
        task: options.task,
      });
    try {
      const { response, blob } = await requestPreview();
      return { response, blob };
    } catch (error) {
      if (options.disableSensitiveRefresh || !isReaderAuthError(error))
        throw error;
      await refreshReaderSensitiveSessionForUrl(previewUrl, {
        signal: options.signal,
        task: options.refreshTask || options.task,
      });
      const { response, blob } = await requestPreview();
      return { response, blob };
    }
  },
  refreshSensitiveSessionForUrl: refreshReaderSensitiveSessionForUrl,
  thumbnailBlob: async function (thumbnailUrl, options = {}) {
    const { response, blob } = await requestBlob(thumbnailUrl, {
      signal: options.signal,
      blobKind: BLOB_KINDS.readerThumbnail,
      communicationScene: options.communicationScene || "reader-open",
      task: options.task,
    });
    return { response, blob };
  },
  fromWorkspace: async function (slug, docPath, options = {}) {
    const params = new URLSearchParams({ docPath });
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/from-workspace?${params.toString()}`,
      {
        signal: options.signal,
        communicationScene: "reader-open",
        task: options.task,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
    });
    if (response.ok && normalizedData?.success) {
      storeReaderSensitiveSession(normalizedData);
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  fromLocalPath: async function (slug, absolutePath, options = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/from-local-path`,
      { absolutePath },
      {
        signal: options.signal,
        communicationScene: "reader-open",
        task: options.task,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
    });
    if (response.ok && normalizedData?.success) {
      storeReaderSensitiveSession(normalizedData);
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  reopenLocalPath: async function (slug, readerDocumentId, options = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/reopen-local-path`,
      undefined,
      {
        signal: options.signal,
        communicationScene: "reader-open",
        task: options.task,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
      readerDocumentId,
    });
    if (response.ok && normalizedData?.success) {
      storeReaderSensitiveSession(normalizedData, readerDocumentId);
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  classify: async function (slug, payload = {}, options = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/classify`,
      payload,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "reader-maintenance",
        task: options.task,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
      readerDocumentId: payload.readerDocumentId,
    });
    if (response.ok && normalizedData?.metadata?.readerDocumentId) {
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  postprocess: async function (
    slug,
    readerDocumentId,
    payload = {},
    options = {}
  ) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/postprocess`,
      payload,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "reader-open",
        task: options.task,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
      readerDocumentId,
    });
    if (response.ok && normalizedData?.metadata?.readerDocumentId) {
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  postprocessStatus: async function (slug, readerDocumentId, options = {}) {
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/postprocess`,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "reader-open",
        task: options.task,
      }
    );
    const normalizedData = normalizeReaderDocumentLinks(data, {
      workspaceSlug: slug,
      readerDocumentId,
    });
    if (response.ok && normalizedData?.metadata?.readerDocumentId) {
      readerServerStateStore.upsertDocument(slug, normalizedData);
    }
    return { response, data: normalizedData };
  },
  ocrConfig: async function (slug, options = {}) {
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/ocr-config`,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "reader-visible",
        task: options.task,
      }
    );
    return { response, data };
  },
  ocrScreenshot: async function (slug, payload = {}, options = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/ocr-screenshot`,
      payload,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "reader-visible",
        task: options.task,
      }
    );
    return { response, data };
  },
};

export default ReaderDocument;
