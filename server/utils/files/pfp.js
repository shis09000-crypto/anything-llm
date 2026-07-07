const { getType } = require("mime");
const {
  FileStorageProvider,
} = require("../../providers/storage/fileStorageProvider");
const { DataAccessCenter } = require("../dataAccess");
const { storagePath } = require("../environment");

const User = DataAccessCenter.user;
const Workspace = DataAccessCenter.workspace;

function fetchPfp(pfpPath) {
  let exists = false;
  try {
    exists = !!pfpPath && FileStorageProvider.existsPath(pfpPath);
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      found: false,
      buffer: null,
      size: 0,
      mime: "none/none",
    };
  }

  const mime = getType(pfpPath);
  const buffer = FileStorageProvider.readFilePath(pfpPath);
  return {
    found: true,
    buffer,
    size: buffer.length,
    mime,
  };
}

async function determinePfpFilepath(id) {
  const numberId = Number(id);
  const user = await User.get({ id: numberId });
  const pfpFilename = user?.pfpFilename || null;
  if (!pfpFilename) return null;

  const basePath = storagePath("assets", "pfp");
  let pfpFilepath = null;
  try {
    pfpFilepath = FileStorageProvider.resolvePath(pfpFilename, {
      base: basePath,
    });
  } catch {
    return null;
  }
  if (!FileStorageProvider.existsPath(pfpFilepath)) return null;
  return pfpFilepath;
}

async function determineWorkspacePfpFilepath(slug) {
  const workspace = await Workspace.get({ slug });
  const pfpFilename = workspace?.pfpFilename || null;
  if (!pfpFilename) return null;

  const basePath = storagePath("assets", "pfp");
  let pfpFilepath = null;
  try {
    pfpFilepath = FileStorageProvider.resolvePath(pfpFilename, {
      base: basePath,
    });
  } catch {
    return null;
  }
  if (!FileStorageProvider.existsPath(pfpFilepath)) return null;
  return pfpFilepath;
}

module.exports = {
  fetchPfp,
  determinePfpFilepath,
  determineWorkspacePfpFilepath,
};
