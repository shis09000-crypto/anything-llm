import {
  FILE_KINDS,
  postJsonDownloadEventStream,
} from "@/lib/communication/fileClient";

const DMRUtils = {
  /**
   * Download a DMR model.
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
        "/utils/dmr/download-model",
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
  // Uninstall a DMR model is not supported via the API
};

export default DMRUtils;
