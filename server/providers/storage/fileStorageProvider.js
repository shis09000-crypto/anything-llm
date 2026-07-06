const fs = require("fs");
const path = require("path");
const {
  diagnosticSummary,
  ensureStoragePath,
  storagePath,
  storageRoot,
} = require("../../utils/environment");
const { isWithin, normalizePath } = require("../../utils/files");

function safeResolve(...segments) {
  const root = storageRoot();
  const target = path.resolve(
    root,
    ...segments.map((segment) => normalizePath(segment))
  );
  if (!isWithin(root, target) && target !== root) {
    const error = new Error("file_storage_path_outside_root");
    error.code = "FILE_STORAGE_PATH_OUTSIDE_ROOT";
    throw error;
  }
  return target;
}

const FileStorageProvider = {
  adapterName: "local-file-storage",
  providerType: "file-storage",

  capabilities() {
    return {
      read: true,
      write: true,
      delete: true,
      transactions: false,
      remote: false,
      adapterTargets: {
        objectStorage: "reserved",
      },
    };
  },

  summary() {
    const diagnostics = diagnosticSummary();
    return {
      adapterName: this.adapterName,
      providerType: this.providerType,
      root: diagnostics.storageRoot,
      paths: diagnostics.paths,
      capabilities: this.capabilities(),
    };
  },

  resolve(...segments) {
    return safeResolve(...segments);
  },

  exists(...segments) {
    return fs.existsSync(this.resolve(...segments));
  },

  stat(...segments) {
    const target = this.resolve(...segments);
    if (!fs.existsSync(target)) return null;
    const stat = fs.statSync(target);
    return {
      path: target,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  },

  ensureDir(...segments) {
    return ensureStoragePath(...segments);
  },

  storagePath(...segments) {
    return storagePath(...segments);
  },
};

module.exports = { FileStorageProvider };
