import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";
import { readerServerStateStore } from "@/utils/serverState/readerServerStateStore";

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
      return {
        response: new Response(null, { status: 200 }),
        data: {
          success: true,
          documents: Array.isArray(documents) ? documents : [],
        },
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (options.allowCacheFallback === false) throw error;
      const cachedDocuments = readerServerStateStore.getDocumentList(slug, {
        allowStale: true,
      });
      if (!cachedDocuments) throw error;
      return {
        response: new Response(null, { status: 200 }),
        data: {
          success: true,
          cached: true,
          stale: true,
          documents: cachedDocuments,
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
    if (response.ok && data?.success) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
  },
  get: async function (slug, readerDocumentId, options = {}) {
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
        return result.data;
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
    return {
      response: new Response(null, { status: 200 }),
      data: data || { success: false },
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
    const { response, blob } = await requestBlob(originalUrl, {
      signal: options.signal,
      blobKind: BLOB_KINDS.readerOriginal,
      communicationScene: "reader-open",
      task: options.task,
    });
    return { response, blob };
  },
  pagePreviewBlob: async function (originalUrl, pageNumber = 1, options = {}) {
    const previewUrl = pagePreviewUrlForOriginal(originalUrl, pageNumber);
    if (!previewUrl) throw new Error("Reader page preview URL unavailable.");
    const { response, blob } = await requestBlob(previewUrl, {
      signal: options.signal,
      blobKind: BLOB_KINDS.readerPreview,
      communicationScene: "reader-open",
      task: options.task,
    });
    return { response, blob, previewUrl };
  },
  previewBlob: async function (previewUrl, options = {}) {
    const { response, blob } = await requestBlob(previewUrl, {
      signal: options.signal,
      blobKind: BLOB_KINDS.readerPreview,
      communicationScene: "reader-open",
      task: options.task,
    });
    return { response, blob };
  },
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
    if (response.ok && data?.success) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
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
    if (response.ok && data?.success) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
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
    if (response.ok && data?.success) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
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
    if (response.ok && data?.metadata?.readerDocumentId) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
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
    if (response.ok && data?.metadata?.readerDocumentId) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
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
    if (response.ok && data?.metadata?.readerDocumentId) {
      readerServerStateStore.upsertDocument(slug, data);
    }
    return { response, data };
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
