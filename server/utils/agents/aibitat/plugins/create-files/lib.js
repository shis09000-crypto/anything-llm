const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { randomBytes } = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { storagePath } = require("../../../../environment");

/**
 * Manages file creation operations for binary document formats.
 * Handles both browser download and filesystem write modes.
 * All generated files are saved to storage/generated-files directory.
 */
class CreateFilesManager {
  static WRITE_VERIFY_ATTEMPTS = 2;

  #outputDirectory = null;
  #isInitialized = false;

  /**
   * Gets the output directory for generated files.
   * @returns {string} The output directory path (storage/generated-files)
   */
  #getOutputDirectory() {
    return storagePath("generated-files");
  }

  /**
   * Initializes the create-files manager and ensures output directory exists.
   * @returns {Promise<string>} The output directory path
   */
  async #initialize() {
    this.#outputDirectory = this.#getOutputDirectory();

    try {
      await fs.mkdir(this.#outputDirectory, { recursive: true });
    } catch (error) {
      console.error(
        `Warning: Could not create output directory ${this.#outputDirectory}: ${error.message}`
      );
    }

    this.#isInitialized = true;
    return this.#outputDirectory;
  }

  /**
   * Ensures the create-files manager is initialized before use.
   * @returns {Promise<void>}
   */
  async ensureInitialized() {
    if (!this.#isInitialized) await this.#initialize();
  }

  /**
   * Checks if file creation tools are available.
   * @returns {boolean} True if tools are available
   */
  isToolAvailable() {
    try {
      for (const dependency of [
        "@mintplex-labs/mdpdf",
        "docx",
        "exceljs",
        "pptxgenjs",
      ])
        require.resolve(dependency);

      const outputDirectory = this.#getOutputDirectory();
      const writableTarget = fsSync.existsSync(outputDirectory)
        ? outputDirectory
        : path.dirname(outputDirectory);
      fsSync.accessSync(writableTarget, fsSync.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gets the output directory path.
   * @returns {Promise<string>} The output directory path
   */
  async getOutputDirectory() {
    await this.ensureInitialized();
    return this.#outputDirectory;
  }

  async #syncDirectory(dirPath) {
    let dirHandle = null;
    try {
      dirHandle = await fs.open(dirPath, "r");
      await dirHandle.sync();
    } catch {
      // Directory fsync is not supported on every filesystem.
    } finally {
      if (dirHandle) await dirHandle.close();
    }
  }

  async #atomicWriteBuffer(filePath, buffer) {
    const parentDir = path.dirname(filePath);
    const tempPath = path.join(
      parentDir,
      `.${path.basename(filePath)}.${randomBytes(16).toString("hex")}.tmp`
    );
    let fileHandle = null;
    try {
      await fs.mkdir(parentDir, { recursive: true });
      fileHandle = await fs.open(tempPath, "w");
      await fileHandle.writeFile(buffer);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await fs.rename(tempPath, filePath);
      await this.#syncDirectory(parentDir);
    } catch (error) {
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch {}
      }
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
  }

  async #verifyBinaryFile(filePath, expectedBuffer) {
    const actualBuffer = await fs.readFile(filePath);
    if (
      !Buffer.isBuffer(actualBuffer) ||
      !actualBuffer.equals(expectedBuffer)
    ) {
      throw new Error(
        `Write verification failed for ${filePath}: expected ${expectedBuffer.length} bytes but read ${actualBuffer?.length ?? 0} bytes.`
      );
    }
    return {
      path: filePath,
      bytes: actualBuffer.length,
      verified: true,
    };
  }

  /**
   * Writes binary content (Buffer) to a file.
   * @param {string} filePath - Validated absolute path to write to
   * @param {Buffer} buffer - Binary content to write
   * @returns {Promise<{path: string, bytes: number, verified: boolean}>}
   */
  async writeBinaryFile(filePath, buffer) {
    const fileSizeBytes = buffer.length;
    const fileSizeKB = (fileSizeBytes / 1024).toFixed(2);
    const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

    console.log(
      `[CreateFilesManager] writeBinaryFile starting - path: ${filePath}, size: ${fileSizeKB}KB (${fileSizeMB}MB)`
    );

    let lastError = null;
    for (
      let attempt = 1;
      attempt <= CreateFilesManager.WRITE_VERIFY_ATTEMPTS;
      attempt++
    ) {
      try {
        await this.#atomicWriteBuffer(filePath, buffer);
        const result = await this.#verifyBinaryFile(filePath, buffer);

        console.log(
          `[CreateFilesManager] writeBinaryFile completed - file saved to: ${filePath}, verified=${result.verified}, bytes=${result.bytes}`
        );
        return result;
      } catch (error) {
        lastError = error;
        if (attempt >= CreateFilesManager.WRITE_VERIFY_ATTEMPTS) break;
      }
    }
    throw lastError;
  }

  /**
   * Gets the MIME type for a file extension.
   * @param {string} extension - File extension (with or without dot)
   * @returns {string} MIME type
   */
  getMimeType(extension) {
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    const mimeTypes = {
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".csv": "text/csv",
      ".json": "application/json",
      ".html": "text/html",
      ".xml": "application/xml",
      ".zip": "application/zip",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".mp3": "audio/mpeg",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
    };
    return mimeTypes[ext.toLowerCase()] || "application/octet-stream";
  }

  /**
   * Checks if a file exists.
   * @param {string} filePath - Path to check
   * @returns {Promise<boolean>} True if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads a file as a Buffer.
   * @param {string} filePath - Path to the file
   * @returns {Promise<Buffer>} File content as Buffer
   */
  async readBinaryFile(filePath) {
    return await fs.readFile(filePath);
  }

  /**
   * Registers an output to be persisted in the chat history.
   * This allows files and other outputs to be re-rendered when viewing historical messages.
   * @param {object} aibitat - The aibitat instance to register the output on
   * @param {string} type - The type of output (e.g., "PptxFileDownload")
   * @param {object} payload - The output payload data
   */
  registerOutput(aibitat, type, payload) {
    if (!aibitat) {
      console.warn(
        "[CreateFilesManager] Cannot register output - aibitat instance not provided"
      );
      return;
    }

    if (!aibitat._pendingOutputs) {
      aibitat._pendingOutputs = [];
    }

    aibitat._pendingOutputs.push({ type, payload });
    console.log(
      `[CreateFilesManager] Registered output: type=${type}, total pending=${aibitat._pendingOutputs.length}`
    );
  }

  /**
   * Generates a standardized filename for generated files.
   * Format: {fileType}-{fileUUID}.{extension}
   * @param {string} fileType - Type identifier (e.g., 'pptx', 'xlsx')
   * @param {string} extension - File extension (without dot)
   * @returns {string} The generated filename
   */
  generateFilename(fileType, extension) {
    const fileUUID = uuidv4();
    return `${fileType}-${fileUUID}.${extension}`;
  }

  /**
   * Parses a generated filename to extract its components.
   * @param {string} filename - The filename to parse
   * @returns {{fileType: string, fileUUID: string, extension: string} | null}
   */
  parseFilename(filename) {
    const match = filename.match(/^([a-z]+)-([a-f0-9-]{36})\.(\w+)$/i);
    if (!match) return null;
    return {
      fileType: match[1],
      fileUUID: match[2],
      extension: match[3],
    };
  }

  /**
   * Saves a generated file to storage and returns metadata for WebSocket/DB storage.
   * This is the primary method for persisting agent-generated files.
   * @param {object} params
   * @param {string} params.fileType - Type identifier (e.g., 'pptx', 'xlsx')
   * @param {string} params.extension - File extension (without dot)
   * @param {Buffer} params.buffer - The file content as a Buffer
   * @param {string} params.displayFilename - The user-friendly filename for display
   * @returns {Promise<{filename: string, displayFilename: string, fileSize: number, storagePath: string}>}
   */
  async saveGeneratedFile({ fileType, extension, buffer, displayFilename }) {
    await this.ensureInitialized();

    const filename = this.generateFilename(fileType, extension);
    const storagePath = path.join(this.#outputDirectory, filename);

    const writeResult = await this.writeBinaryFile(storagePath, buffer);

    console.log(
      `[CreateFilesManager] saveGeneratedFile - saved ${filename} (${(buffer.length / 1024).toFixed(2)}KB), verified=${writeResult.verified}`
    );

    return {
      filename,
      displayFilename,
      fileSize: buffer.length,
      storagePath,
    };
  }

  /**
   * Retrieves a generated file by its storage filename.
   * @param {string} filename - The storage filename (must match {fileType}-{uuid}.{ext} format)
   * @returns {Promise<{buffer: Buffer, storagePath: string} | null>}
   */
  async getGeneratedFile(filename) {
    await this.ensureInitialized();

    // Defense-in-depth: validate filename format to prevent path traversal
    if (!this.parseFilename(filename)) {
      console.warn(
        `[CreateFilesManager] getGeneratedFile - rejected invalid filename format: ${filename}`
      );
      return null;
    }

    const storagePath = path.join(this.#outputDirectory, filename);
    const exists = await this.fileExists(storagePath);
    if (!exists) return null;

    const buffer = await this.readBinaryFile(storagePath);
    return { buffer, storagePath };
  }

  /**
   * Sanitizes a filename for use in Content-Disposition header to prevent header injection.
   * Removes/replaces characters that could be used for header manipulation.
   * @param {string} filename - The filename to sanitize
   * @returns {string} Sanitized filename safe for Content-Disposition header
   */
  sanitizeFilenameForHeader(filename) {
    if (!filename || typeof filename !== "string") return "download";
    return filename
      .replace(/[\r\n"\\]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .substring(0, 255);
  }

  /**
   * Gets the AnythingLLM logo for branding.
   * @param {Object} options
   * @param {boolean} [options.forDarkBackground=false] - True to get light logo (for dark backgrounds), false for dark logo (for light backgrounds)
   * @param {"buffer"|"dataUri"} [options.format="buffer"] - Return format: "buffer" for raw Buffer, "dataUri" for base64 data URI
   * @returns {Buffer|string|null} Logo as Buffer, data URI string, or null if file not found
   */
  getLogo({ forDarkBackground = false, format = "buffer" } = {}) {
    const assetsPath = storagePath("assets");
    const filename = forDarkBackground
      ? "anything-llm.png"
      : "anything-llm-invert.png";
    try {
      if (format === "dataUri") {
        const base64 = fsSync.readFileSync(
          path.join(assetsPath, filename),
          "base64"
        );
        return `image/png;base64,${base64}`;
      }
      return fsSync.readFileSync(path.join(assetsPath, filename));
    } catch {
      return null;
    }
  }
}

module.exports = new CreateFilesManager();
