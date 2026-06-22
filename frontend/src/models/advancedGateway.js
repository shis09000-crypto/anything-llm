import { getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback as rawOrFallback } from "@/lib/communication/apiError";

const AdvancedGateway = {
  getConfig: async function () {
    return await getJson("/advanced-gateway/config")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { config: null, error: e.message });
      });
  },

  saveConfig: async function (updates = {}) {
    return await postJson("/advanced-gateway/config", updates)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },

  testConnection: async function () {
    return await postJson("/advanced-gateway/test")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
};

export default AdvancedGateway;
