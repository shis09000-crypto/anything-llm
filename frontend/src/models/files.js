import { FILE_KINDS, downloadBlobFile } from "@/lib/communication/fileClient";

const StorageFiles = {
  /**
   * Download a file from the server
   * @param {string} filename - The filename to download
   * @returns {Promise<Blob|null>}
   */
  download: async function (storageFilename) {
    return await downloadBlobFile(
      `/agent-skills/generated-files/${encodeURIComponent(storageFilename)}`,
      {
        blobKind: FILE_KINDS.generatedFile,
      }
    )
      .then(({ blob }) => blob)
      .catch((e) => {
        console.error("Download failed:", e);
        return null;
      });
  },
};

export default StorageFiles;
