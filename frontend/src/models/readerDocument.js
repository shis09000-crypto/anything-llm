import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

function apiUrl(pathOrUrl) {
  if (!pathOrUrl) return pathOrUrl;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (API_BASE.startsWith("http") && pathOrUrl.startsWith("/api/")) {
    return `${API_BASE.replace(/\/api\/?$/, "")}${pathOrUrl}`;
  }
  return pathOrUrl;
}

function readerDocumentsBase(slug = null) {
  return slug
    ? `${API_BASE}/workspace/${slug}/reader-documents`
    : `${API_BASE}/reader-documents`;
}

const ReaderDocument = {
  upload: async function (slug, formData) {
    const response = await fetch(`${readerDocumentsBase(slug)}/upload`, {
      method: "POST",
      body: formData,
      headers: baseHeaders(),
    });
    const data = await response.json();
    return { response, data };
  },
  get: async function (slug, readerDocumentId) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/${readerDocumentId}`,
      { method: "GET", headers: baseHeaders() }
    );
    const data = await response.json();
    return { response, data };
  },
  delete: async function (slug, readerDocumentId) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/${readerDocumentId}`,
      { method: "DELETE", headers: baseHeaders() }
    );
    const data = await response.json();
    return { response, data };
  },
  originalBlob: async function (originalUrl) {
    const response = await fetch(apiUrl(originalUrl), {
      method: "GET",
      headers: baseHeaders(),
    });
    const blob = await response.blob();
    return { response, blob };
  },
  previewBlob: async function (previewUrl) {
    const response = await fetch(apiUrl(previewUrl), {
      method: "GET",
      headers: baseHeaders(),
    });
    const blob = await response.blob();
    return { response, blob };
  },
  fromWorkspace: async function (slug, docPath) {
    const apiBase = API_BASE.startsWith("http")
      ? API_BASE
      : `${window.location.origin}${API_BASE}`;
    const url = new URL(
      `${apiBase}/workspace/${slug}/reader-documents/from-workspace`
    );
    url.searchParams.set("docPath", docPath);
    const response = await fetch(url, {
      method: "GET",
      headers: baseHeaders(),
    });
    const data = await response.json();
    return { response, data };
  },
  fromLocalPath: async function (slug, absolutePath) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/from-local-path`,
      {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ absolutePath }),
      }
    );
    const data = await response.json();
    return { response, data };
  },
  reopenLocalPath: async function (slug, readerDocumentId) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/${readerDocumentId}/reopen-local-path`,
      {
        method: "POST",
        headers: baseHeaders(),
      }
    );
    const data = await response.json();
    return { response, data };
  },
  classify: async function (slug, payload = {}) {
    const response = await fetch(`${readerDocumentsBase(slug)}/classify`, {
      method: "POST",
      headers: { ...baseHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    return { response, data };
  },
  postprocess: async function (slug, readerDocumentId, payload = {}) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/${readerDocumentId}/postprocess`,
      {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const data = await response.json();
    return { response, data };
  },
  postprocessStatus: async function (slug, readerDocumentId) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/${readerDocumentId}/postprocess`,
      { method: "GET", headers: baseHeaders() }
    );
    const data = await response.json();
    return { response, data };
  },
  ocrConfig: async function (slug) {
    const response = await fetch(`${readerDocumentsBase(slug)}/ocr-config`, {
      method: "GET",
      headers: baseHeaders(),
    });
    const data = await response.json();
    return { response, data };
  },
  ocrScreenshot: async function (slug, payload = {}) {
    const response = await fetch(
      `${readerDocumentsBase(slug)}/ocr-screenshot`,
      {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const data = await response.json();
    return { response, data };
  },
};

export default ReaderDocument;
