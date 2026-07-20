const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const {
  WATCH_DIRECTORY,
  SUPPORTED_FILETYPE_CONVERTERS,
} = require("../utils/constants");
const { isTextType, normalizePath, isWithin } = require("../utils/files");
const RESERVED_FILES = ["__HOTDIR__.md"];
const MAX_INPUT_BYTES = 500 * 1_024 * 1_024;
const { validateArchive } = require("../utils/archiveGuard");
const { currentTaskDirectory } = require("../utils/taskContext");

function invalidInput(reason) {
  return { success: false, reason, documents: [] };
}

function copyOpenedInputToTask(sourcePath, extension) {
  const ownedDirectory = !currentTaskDirectory();
  const directory =
    currentTaskDirectory() ||
    fs.mkdtempSync(path.join(os.tmpdir(), "collector-job-"));
  const target = path.join(
    directory,
    `input-${crypto.randomUUID()}${extension || ""}`
  );
  let sourceFd = null;
  let targetFd = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(sourceFd);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) {
      throw new Error("collector_input_size_or_type_invalid");
    }
    if (Number(stat.nlink) !== 1) {
      throw new Error("collector_input_hardlink_forbidden");
    }
    targetFd = fs.openSync(
      target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = fs.readSync(
        sourceFd,
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset
      );
      if (bytesRead <= 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(targetFd, buffer, written, bytesRead - written);
      }
      offset += bytesRead;
    }
    if (offset !== stat.size)
      throw new Error("collector_input_copy_incomplete");
    fs.fsyncSync(targetFd);
    return { path: target, ownedDirectory, directory };
  } catch (error) {
    try {
      fs.rmSync(target, { force: true });
    } catch {}
    if (ownedDirectory) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {}
    }
    throw error;
  } finally {
    if (targetFd !== null) fs.closeSync(targetFd);
    if (sourceFd !== null) fs.closeSync(sourceFd);
  }
}

/**
 * Process a single file and return the documents
 * @param {string} targetFilename - The filename to process
 * @param {Object} options - The options for the file processing
 * @param {boolean} options.parseOnly - If true, the file will not be saved as a document even when `writeToServerDocuments` is called in the handler. Must be explicitly set to true to use.
 * @param {Object} metadata - The metadata for the file processing
 * @returns {Promise<{success: boolean, reason: string, documents: Object[]}>} - The documents from the file processing
 */
async function processSingleFile(targetFilename, options = {}, metadata = {}) {
  const internalSourcePath = options.internalSourcePath || null;
  const processorOptions = { ...options };
  delete processorOptions.internalSourcePath;
  if (
    !targetFilename ||
    path.basename(targetFilename) !== targetFilename ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(targetFilename)
  ) {
    return invalidInput("collector_invalid_upload_handle");
  }
  const sourceRoot = internalSourcePath
    ? currentTaskDirectory()
    : path.resolve(WATCH_DIRECTORY);
  if (internalSourcePath && !sourceRoot) {
    return invalidInput("Collector task isolation context is unavailable.");
  }
  const fullFilePath = normalizePath(
    internalSourcePath || path.resolve(WATCH_DIRECTORY, targetFilename)
  );

  if (!isWithin(path.resolve(sourceRoot), fullFilePath))
    return invalidInput("Filename is a not a valid path to process.");

  if (RESERVED_FILES.includes(targetFilename))
    return {
      success: false,
      reason: "Filename is a reserved filename and cannot be processed.",
      documents: [],
    };

  if (!fs.existsSync(fullFilePath))
    return invalidInput("File does not exist in upload directory.");

  const lstat = fs.lstatSync(fullFilePath);
  if (lstat.isSymbolicLink())
    return invalidInput("Symbolic-link inputs are not permitted.");
  const realFilePath = fs.realpathSync(fullFilePath);
  if (!isWithin(path.resolve(sourceRoot), realFilePath))
    return invalidInput("Resolved file path leaves the upload directory.");
  if (!lstat.isFile() || lstat.size > MAX_INPUT_BYTES)
    return invalidInput("Input file exceeds the 500 MiB processing limit.");

  const fileExtension = path.extname(fullFilePath).toLowerCase();
  if (fullFilePath.includes(".") && !fileExtension) {
    return {
      success: false,
      reason: `No file extension found. This file cannot be processed.`,
      documents: [],
    };
  }

  let processFileAs = fileExtension;
  if (!SUPPORTED_FILETYPE_CONVERTERS.hasOwnProperty(fileExtension)) {
    if (isTextType(fullFilePath)) {
      console.log(
        `\x1b[33m[Collector]\x1b[0m The provided filetype of ${fileExtension} does not have a preset and will be processed as .txt.`
      );
      processFileAs = ".txt";
    } else {
      return {
        success: false,
        reason: `File extension ${fileExtension} not supported for parsing and cannot be assumed as text file type.`,
        documents: [],
      };
    }
  }

  let taskInput = null;
  try {
    taskInput = copyOpenedInputToTask(realFilePath, fileExtension);
    await validateArchive(taskInput.path);
  } catch (error) {
    if (taskInput?.path) {
      try {
        fs.rmSync(taskInput.path, { force: true });
      } catch {}
    }
    if (taskInput?.ownedDirectory) {
      try {
        fs.rmSync(taskInput.directory, { recursive: true, force: true });
      } catch {}
    }
    return {
      success: false,
      reason: `Archive safety validation failed: ${error.message}`,
      documents: [],
    };
  }

  const FileTypeProcessor = require(SUPPORTED_FILETYPE_CONVERTERS[
    processFileAs
  ]);
  try {
    return await FileTypeProcessor({
      fullFilePath: taskInput.path,
      filename: targetFilename,
      options: processorOptions,
      metadata,
    });
  } finally {
    try {
      fs.rmSync(taskInput.path, { force: true });
    } catch {}
    if (taskInput.ownedDirectory) {
      try {
        fs.rmSync(taskInput.directory, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = {
  processSingleFile,
};
