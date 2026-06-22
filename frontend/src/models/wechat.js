import { getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

const WeChat = {
  getConfig: async function () {
    return await getJson("/wechat/config")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { config: null, error: e.message });
      });
  },

  saveConfig: async function (updates = {}) {
    return await postJson("/wechat/config", updates)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },

  generateQrCode: async function () {
    return await postJson("/wechat/qrcode")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },

  getStatus: async function () {
    return await getJson("/wechat/status")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },

  disconnect: async function () {
    return await postJson("/wechat/disconnect")
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return apiErrorFallback(e, { success: false, error: e.message });
      });
  },
};

export default WeChat;
