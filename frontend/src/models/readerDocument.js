import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";

function readerDocumentsPath(slug = null) {
  return slug ? `/workspace/${slug}/reader-documents` : "/reader-documents";
}

function withReaderQuery(path, options = {}) {
  const params = new URLSearchParams();
  if (options.detail) params.set("detail", options.detail);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

const ReaderDocument = {
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
    return { response, data };
  },
  get: async function (slug, readerDocumentId, options = {}) {
    const { response, data } = await getJson(
      withReaderQuery(`${readerDocumentsPath(slug)}/${readerDocumentId}`, {
        detail: options.detail,
      }),
      { signal: options.signal, communicationScene: "reader-open" }
    );
    return { response, data };
  },
  delete: async function (slug, readerDocumentId, options = {}) {
    const { response, data } = await deleteJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}`,
      options
    );
    return { response, data };
  },
  originalBlob: async function (originalUrl) {
    const { response, blob } = await requestBlob(originalUrl, {
      blobKind: BLOB_KINDS.readerOriginal,
      communicationScene: "reader-open",
    });
    return { response, blob };
  },
  previewBlob: async function (previewUrl) {
    const { response, blob } = await requestBlob(previewUrl, {
      blobKind: BLOB_KINDS.readerPreview,
      communicationScene: "reader-open",
    });
    return { response, blob };
  },
  thumbnailBlob: async function (thumbnailUrl) {
    const { response, blob } = await requestBlob(thumbnailUrl, {
      blobKind: BLOB_KINDS.readerThumbnail,
      communicationScene: "reader-open",
    });
    return { response, blob };
  },
  fromWorkspace: async function (slug, docPath) {
    const params = new URLSearchParams({ docPath });
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/from-workspace?${params.toString()}`,
      { communicationScene: "reader-open" }
    );
    return { response, data };
  },
  fromLocalPath: async function (slug, absolutePath) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/from-local-path`,
      { absolutePath },
      { communicationScene: "reader-open" }
    );
    return { response, data };
  },
  reopenLocalPath: async function (slug, readerDocumentId) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/reopen-local-path`,
      undefined,
      { communicationScene: "reader-open" }
    );
    return { response, data };
  },
  classify: async function (slug, payload = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/classify`,
      payload
    );
    return { response, data };
  },
  postprocess: async function (slug, readerDocumentId, payload = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/postprocess`,
      payload,
      { communicationScene: "reader-open" }
    );
    return { response, data };
  },
  postprocessStatus: async function (slug, readerDocumentId) {
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/postprocess`,
      { communicationScene: "reader-open" }
    );
    return { response, data };
  },
  ocrConfig: async function (slug) {
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/ocr-config`
    );
    return { response, data };
  },
  ocrScreenshot: async function (slug, payload = {}) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/ocr-screenshot`,
      payload
    );
    return { response, data };
  },
};

export default ReaderDocument;
