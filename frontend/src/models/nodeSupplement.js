import { API_BASE } from "@/utils/constants";
import { baseHeaders } from "@/utils/request";

const NodeSupplement = {
  async list(slug, nodeKey) {
    if (!slug || !nodeKey) return { success: false, supplements: [] };
    const params = new URLSearchParams({ nodeKey });
    return await fetch(
      `${API_BASE}/workspace/${slug}/node-supplements?${params.toString()}`,
      {
        method: "GET",
        headers: baseHeaders(),
      }
    )
      .then((res) => res.json())
      .catch((error) => ({
        success: false,
        supplements: [],
        error: error.message,
      }));
  },

  async create(slug, body = {}) {
    return await fetch(`${API_BASE}/workspace/${slug}/node-supplements`, {
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

  async upload(slug, formData) {
    return await fetch(
      `${API_BASE}/workspace/${slug}/node-supplements/upload`,
      {
        method: "POST",
        headers: baseHeaders(),
        body: formData,
      }
    )
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },

  async createText(slug, body = {}) {
    return await fetch(`${API_BASE}/workspace/${slug}/node-supplements/text`, {
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

  async delete(slug, id) {
    return await fetch(`${API_BASE}/workspace/${slug}/node-supplements/${id}`, {
      method: "DELETE",
      headers: baseHeaders(),
    })
      .then((res) => res.json())
      .catch((error) => ({ success: false, error: error.message }));
  },
};

export default NodeSupplement;
