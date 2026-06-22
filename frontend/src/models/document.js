import { postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback as rawOrFallback } from "@/lib/communication/apiError";

const Document = {
  createFolder: async (name) => {
    return await postJson("/document/create-folder", { name })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  moveToFolder: async (files, folderName) => {
    const data = {
      files: files.map((file) => ({
        from: file.folderName ? `${file.folderName}/${file.name}` : file.name,
        to: `${folderName}/${file.name}`,
      })),
    };

    return await postJson("/document/move-files", data)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
};

export default Document;
