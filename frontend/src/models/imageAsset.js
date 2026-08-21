import {
  deleteJson,
  getJson,
  patchJson,
  postJson,
} from "@/lib/communication/apiClient";

function queryString(filters = {}) {
  const search = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    search.set(key, String(value));
  });
  const value = search.toString();
  return value ? `?${value}` : "";
}

const ImageAsset = {
  async list(filters = {}) {
    const { data } = await getJson(`/image-assets${queryString(filters)}`, {
      communicationScene: "image-assets-list",
    });
    return data;
  },
  async update(assetId, patch) {
    const { data } = await patchJson(
      `/image-assets/${encodeURIComponent(assetId)}`,
      patch,
      { communicationScene: "image-asset-update" }
    );
    return data;
  },
  async sync(assetId) {
    const { data } = await postJson(
      `/image-assets/${encodeURIComponent(assetId)}/sync`,
      {},
      { communicationScene: "image-asset-sync" }
    );
    return data;
  },
  async delete(assetId) {
    const { data } = await deleteJson(
      `/image-assets/${encodeURIComponent(assetId)}`,
      { communicationScene: "image-asset-delete" }
    );
    return data;
  },
};

export default ImageAsset;
