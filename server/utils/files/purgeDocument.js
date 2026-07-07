const path = require("path");
const {
  purgeVectorCache,
  purgeSourceDocument,
  normalizePath,
  documentsPath,
} = require(".");
const {
  FileStorageProvider,
} = require("../../providers/storage/fileStorageProvider");
const { DataAccessCenter } = require("../dataAccess");

async function purgeDocument(filename = null) {
  if (!filename || !normalizePath(filename)) return;

  await purgeVectorCache(filename);
  await purgeSourceDocument(filename);
  const workspaces = await DataAccessCenter.workspace.where();
  for (const workspace of workspaces) {
    await DataAccessCenter.document.removeDocuments(workspace, [filename]);
  }
  return;
}

async function purgeWorkspaceDocument(workspace = null, filename = null) {
  if (!workspace || !filename || !normalizePath(filename)) return false;
  const document = await DataAccessCenter.document.get({
    workspaceId: workspace.id,
    docpath: filename,
  });
  if (!document) return false;
  await DataAccessCenter.document.removeDocuments(workspace, [filename]);
  return true;
}

/**
 * Purge a folder and all its contents. This will also remove all vector-cache files and workspace document associations
 * for the documents within the folder.
 * @notice This function is not recursive. It only purges the contents of the specified folder.
 * @notice You cannot purge the `custom-documents` folder.
 * @param {string} folderName - The name/path of the folder to purge.
 * @returns {Promise<void>}
 */
async function purgeFolder(folderName = null) {
  if (!folderName) return;
  const subFolder = normalizePath(folderName);
  const subFolderPath = FileStorageProvider.resolvePath(subFolder, {
    base: documentsPath,
  });
  const validRemovableSubFolders = FileStorageProvider.readDirPath(
    documentsPath
  )
    .map((folder) => {
      // Filter out any results which are not folders or
      // are the protected custom-documents folder.
      if (folder === "custom-documents") return null;
      const subfolderPath = FileStorageProvider.resolvePath(folder, {
        base: documentsPath,
      });
      if (!FileStorageProvider.isDirectoryPath(subfolderPath)) return null;
      return folder;
    })
    .filter((subFolder) => !!subFolder);

  if (
    !validRemovableSubFolders.includes(subFolder) ||
    !FileStorageProvider.isDirectoryPath(subFolderPath)
  )
    return;

  const filenames = FileStorageProvider.readDirPath(subFolderPath).map((file) =>
    path.join(subFolder, file)
  );
  const workspaces = await DataAccessCenter.workspace.where();

  const purgePromises = [];
  // Remove associated Vector-cache files
  for (const filename of filenames) {
    const rmVectorCache = () =>
      new Promise((resolve) =>
        purgeVectorCache(filename).then(() => resolve(true))
      );
    purgePromises.push(rmVectorCache);
  }

  // Remove workspace document associations
  for (const workspace of workspaces) {
    const rmWorkspaceDoc = () =>
      new Promise((resolve) =>
        DataAccessCenter.document
          .removeDocuments(workspace, filenames)
          .then(() => resolve(true))
      );
    purgePromises.push(rmWorkspaceDoc);
  }

  await Promise.all(purgePromises.flat().map((f) => f()));
  FileStorageProvider.deletePath(subFolderPath, { recursive: true }); // Delete target document-folder and source files.

  return;
}

module.exports = {
  purgeDocument,
  purgeWorkspaceDocument,
  purgeFolder,
};
