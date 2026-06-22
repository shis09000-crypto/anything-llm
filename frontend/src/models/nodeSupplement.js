import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";

const NodeSupplement = {
  async list(slug, nodeKey) {
    if (!slug || !nodeKey) return { success: false, supplements: [] };
    const params = new URLSearchParams({ nodeKey });
    return await getJson(
      `/workspace/${slug}/node-supplements?${params.toString()}`
    )
      .then(({ data }) => data)
      .catch((error) => ({
        success: false,
        supplements: [],
        error: error.message,
      }));
  },

  async create(slug, body = {}) {
    return await postJson(`/workspace/${slug}/node-supplements`, body)
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async upload(slug, formData) {
    return await uploadFormData(
      `/workspace/${slug}/node-supplements/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.nodeSupplement,
      }
    )
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async createText(slug, body = {}) {
    return await postJson(`/workspace/${slug}/node-supplements/text`, body)
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },

  async delete(slug, id) {
    return await deleteJson(`/workspace/${slug}/node-supplements/${id}`)
      .then(({ data }) => data)
      .catch((error) => ({ success: false, error: error.message }));
  },
};

export default NodeSupplement;
