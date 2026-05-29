import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const ReaderDocument = {
  upload: async function (slug, formData) {
    const response = await fetch(
      `${API_BASE}/workspace/${slug}/reader-documents/upload`,
      {
        method: "POST",
        body: formData,
        headers: baseHeaders(),
      }
    );
    const data = await response.json();
    return { response, data };
  },
  get: async function (slug, readerDocumentId) {
    const response = await fetch(
      `${API_BASE}/workspace/${slug}/reader-documents/${readerDocumentId}`,
      { method: "GET", headers: baseHeaders() }
    );
    const data = await response.json();
    return { response, data };
  },
  originalBlob: async function (originalUrl) {
    const response = await fetch(originalUrl, {
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
};

export default ReaderDocument;
