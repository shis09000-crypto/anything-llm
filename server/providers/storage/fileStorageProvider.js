const fs = require("fs");
const path = require("path");
const {
  diagnosticSummary,
  ensureStoragePath,
  storagePath,
  storageRoot,
} = require("../../utils/environment");
const { isWithin, normalizePath } = require("../../utils/files/pathSafety");

function storagePathError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function assertInsideRoot(targetPath, { allowRoot = false } = {}) {
  const root = path.resolve(storageRoot());
  const target = path.resolve(targetPath);
  if (target === root && allowRoot) return target;
  if (!isWithin(root, target)) {
    throw storagePathError(
      "FILE_STORAGE_PATH_OUTSIDE_ROOT",
      "file_storage_path_outside_root"
    );
  }
  return target;
}

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

function pathSummary(target, stat) {
  return {
    path: target,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
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

  root() {
    return path.resolve(storageRoot());
  },

  assertWithinRoot(targetPath, options = {}) {
    return assertInsideRoot(targetPath, options);
  },

  resolvePath(target = "", options = {}) {
    const root = this.root();
    const base = options.base ? path.resolve(options.base) : root;
    assertInsideRoot(base, { allowRoot: true });

    const hasTarget =
      target !== null && target !== undefined && String(target).trim() !== "";
    const rawTarget = hasTarget ? String(target) : "";
    const resolved = hasTarget
      ? path.isAbsolute(rawTarget)
        ? path.resolve(rawTarget)
        : path.resolve(base, normalizePath(rawTarget))
      : base;
    assertInsideRoot(resolved, { allowRoot: options.allowRoot === true });

    if (options.base && resolved !== base && !isWithin(base, resolved)) {
      throw storagePathError(
        "FILE_STORAGE_PATH_OUTSIDE_BASE",
        "file_storage_path_outside_base"
      );
    }

    if (!options.allowRoot && resolved === root) {
      throw storagePathError(
        "FILE_STORAGE_ROOT_OPERATION_FORBIDDEN",
        "file_storage_root_operation_forbidden"
      );
    }

    return resolved;
  },

  existsPath(target, options = {}) {
    return fs.existsSync(this.resolvePath(target, options));
  },

  statPath(target, options = {}) {
    const resolved = this.resolvePath(target, options);
    if (!fs.existsSync(resolved)) return null;
    return pathSummary(resolved, fs.statSync(resolved));
  },

  isFilePath(target, options = {}) {
    return this.statPath(target, options)?.isFile === true;
  },

  isDirectoryPath(target, options = {}) {
    return this.statPath(target, options)?.isDirectory === true;
  },

  ensureDirPath(target, options = {}) {
    const resolved = this.resolvePath(target, {
      ...options,
      allowRoot: options.allowRoot === true,
    });
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  },

  readFilePath(target, encodingOrOptions = null, maybeOptions = {}) {
    const encoding =
      typeof encodingOrOptions === "string" ? encodingOrOptions : null;
    const options =
      typeof encodingOrOptions === "object" && encodingOrOptions !== null
        ? encodingOrOptions
        : maybeOptions;
    const resolved = this.resolvePath(target, options);
    return encoding
      ? fs.readFileSync(resolved, encoding)
      : fs.readFileSync(resolved);
  },

  writeFilePath(target, data, options = {}) {
    const resolved = this.resolvePath(target, options);
    if (options.ensureDir !== false)
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, data, options.encoding || undefined);
    return resolved;
  },

  readJsonPath(target, options = {}) {
    return JSON.parse(this.readFilePath(target, "utf8", options));
  },

  writeJsonPath(target, value, options = {}) {
    return this.writeFilePath(target, JSON.stringify(value, null, 2), {
      ...options,
      encoding: "utf8",
    });
  },

  readDirPath(target, options = {}) {
    const resolved = this.resolvePath(target, {
      ...options,
      allowRoot: options.allowRoot === true,
    });
    if (!fs.existsSync(resolved)) return [];
    return fs.readdirSync(resolved, {
      withFileTypes: options.withFileTypes === true,
    });
  },

  deletePath(target, options = {}) {
    const resolved = this.resolvePath(target, options);
    if (resolved === this.root()) {
      throw storagePathError(
        "FILE_STORAGE_DELETE_ROOT_FORBIDDEN",
        "file_storage_delete_root_forbidden"
      );
    }
    if (!fs.existsSync(resolved)) return false;
    fs.rmSync(resolved, {
      recursive: options.recursive === true,
      force: options.force === true,
    });
    return true;
  },

  renamePath(from, to, options = {}) {
    const fromPath = this.resolvePath(from, options);
    const toPath = this.resolvePath(to, options.toOptions || options);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.renameSync(fromPath, toPath);
    return toPath;
  },

  copyPath(from, to, options = {}) {
    const fromPath = this.resolvePath(from, options);
    const toPath = this.resolvePath(to, options.toOptions || options);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.copyFileSync(fromPath, toPath);
    return toPath;
  },

  createReadStreamPath(target, streamOptions = {}, pathOptions = {}) {
    return fs.createReadStream(
      this.resolvePath(target, pathOptions),
      streamOptions
    );
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
