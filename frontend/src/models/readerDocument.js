import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";

function readerDocumentsPath(slug = null) {
  return slug ? `/workspace/${slug}/reader-documents` : "/reader-documents";
}

const ReaderDocument = {
  upload: async function (slug, formData) {
    const { response, data } = await uploadFormData(
      `${readerDocumentsPath(slug)}/upload`,
      formData,
      { uploadKind: UPLOAD_KINDS.readerDocument }
    );
    return { response, data };
  },
  get: async function (slug, readerDocumentId) {
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}`
    );
    return { response, data };
  },
  delete: async function (slug, readerDocumentId) {
    const { response, data } = await deleteJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}`
    );
    return { response, data };
  },
  originalBlob: async function (originalUrl) {
    const { response, blob } = await requestBlob(originalUrl, {
      blobKind: BLOB_KINDS.readerOriginal,
    });
    return { response, blob };
  },
  previewBlob: async function (previewUrl) {
    const { response, blob } = await requestBlob(previewUrl, {
      blobKind: BLOB_KINDS.readerPreview,
    });
    return { response, blob };
  },
  fromWorkspace: async function (slug, docPath) {
    const params = new URLSearchParams({ docPath });
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/from-workspace?${params.toString()}`
    );
    return { response, data };
  },
  fromLocalPath: async function (slug, absolutePath) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/from-local-path`,
      { absolutePath }
    );
    return { response, data };
  },
  reopenLocalPath: async function (slug, readerDocumentId) {
    const { response, data } = await postJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/reopen-local-path`,
      undefined
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
      payload
    );
    return { response, data };
  },
  postprocessStatus: async function (slug, readerDocumentId) {
    const { response, data } = await getJson(
      `${readerDocumentsPath(slug)}/${readerDocumentId}/postprocess`
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
