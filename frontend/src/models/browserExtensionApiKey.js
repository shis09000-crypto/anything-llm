import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

const BrowserExtensionApiKey = {
  getAll: async () => {
    return await getJson("/browser-extension/api-keys")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, {
          success: false,
          error: e.message,
          apiKeys: [],
        });
      });
  },

  generateKey: async () => {
    return await postJson("/browser-extension/api-keys/new")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },

  revoke: async (id) => {
    return await deleteJson(`/browser-extension/api-keys/${id}`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },
};

export default BrowserExtensionApiKey;
