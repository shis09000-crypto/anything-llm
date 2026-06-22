import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback as rawOrFallback } from "@/lib/communication/apiError";

const Embed = {
  embeds: async () => {
    return await getJson("/embeds")
      .then(({ data }) => data?.embeds || [])
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  newEmbed: async (data) => {
    return await postJson("/embeds/new", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { embed: null, error: e.message });
      });
  },
  updateEmbed: async (embedId, data) => {
    return await postJson(`/embed/update/${embedId}`, data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteEmbed: async (embedId) => {
    return await deleteJson(`/embed/${embedId}`)
      .then(() => ({ success: true, error: null }))
      .catch((e) => {
        console.error(e);
        return { success: true, error: e.message };
      });
  },
  chats: async (offset = 0) => {
    return await postJson("/embed/chats", { offset })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return [];
      });
  },
  deleteChat: async (chatId) => {
    return await deleteJson(`/embed/chats/${chatId}`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
};

export default Embed;
