import { postJson } from "@/lib/communication/apiClient";
import {
  FILE_KINDS,
  postJsonDownloadEventStream,
} from "@/lib/communication/fileClient";

const LemonadeUtils = {
  /**
   * Download a Lemonade model.
   * @param {string} modelId - The ID of the model to download.
   * @param {(percentage: number) => void} progressCallback - The callback to receive the progress percentage. If the model is already downloaded, it will be called once with 100.
   * @returns {Promise<{success: boolean, error: string|null}>}
   */
  downloadModel: async function (
    modelId,
    basePath = "",
    progressCallback = () => {}
  ) {
    let terminalResult = null;
    try {
      await postJsonDownloadEventStream(
        "/utils/lemonade/download-model",
        { modelId, basePath },
        {
          blobKind: FILE_KINDS.modelDownloadStream,
          onEvent: (data) => {
            switch (data?.type) {
              case "success":
                terminalResult = { success: true };
                break;
              case "error":
                terminalResult = {
                  success: false,
                  error: data?.error || data?.message,
                };
                break;
              case "progress":
                progressCallback(data?.percentage);
                break;
              default:
                break;
            }
          },
        }
      );
      return terminalResult || { success: true };
    } catch (error) {
      console.error("Error downloading model:", error);
      return {
        success: false,
        error:
          error?.message || "An error occurred while downloading the model",
      };
    }
  },

  /**
   * Delete a Lemonade model from local storage.
   * If the model is currently loaded, it will be unloaded first.
   * @param {string} modelId - The ID of the model to delete.
   * @param {string} basePath - The base path of the Lemonade server.
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  deleteModel: async function (modelId, basePath = "") {
    try {
      const { data } = await postJson("/utils/lemonade/delete-model", {
        modelId,
        basePath,
      });
      if (!data.success) {
        return {
          success: false,
          error: data.error || "An error occurred while deleting the model",
        };
      }

      return {
        success: true,
        message: data.message,
      };
    } catch (error) {
      console.error("Error deleting model:", error);
      return {
        success: false,
        error: error?.message || "An error occurred while deleting the model",
      };
    }
  },
};

export default LemonadeUtils;
