/* global jest, describe, beforeEach, afterEach, it, expect */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const originalStorageDir = process.env.STORAGE_DIR;

async function loadCreateFilesLib() {
  jest.resetModules();
  const storageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "anythingllm-create-files-")
  );
  process.env.STORAGE_DIR = storageDir;
  const createFilesLib = require("../../../utils/agents/aibitat/plugins/create-files/lib");
  return { createFilesLib, storageDir };
}

describe("create-files write verification", () => {
  let storageDir = null;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (storageDir) {
      await fs.rm(storageDir, { recursive: true, force: true });
      storageDir = null;
    }
    if (originalStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = originalStorageDir;
  });

  it("saves generated files only after the written buffer is verified", async () => {
    const loaded = await loadCreateFilesLib();
    const createFilesLib = loaded.createFilesLib;
    storageDir = loaded.storageDir;
    const buffer = Buffer.from("verified generated file", "utf-8");

    const savedFile = await createFilesLib.saveGeneratedFile({
      fileType: "text",
      extension: "txt",
      buffer,
      displayFilename: "verified.txt",
    });

    expect(savedFile.displayFilename).toBe("verified.txt");
    expect(savedFile.fileSize).toBe(buffer.length);
    expect(savedFile.storagePath).toContain(
      path.join(storageDir, "generated-files")
    );
    await expect(fs.readFile(savedFile.storagePath)).resolves.toEqual(buffer);
  });

  it("throws instead of returning metadata when generated file verification fails", async () => {
    const loaded = await loadCreateFilesLib();
    const createFilesLib = loaded.createFilesLib;
    storageDir = loaded.storageDir;
    const originalReadFile = fs.readFile.bind(fs);
    jest.spyOn(fs, "readFile").mockImplementation(async (filePath, ...args) => {
      if (String(filePath).includes(`${path.sep}generated-files${path.sep}`)) {
        return Buffer.from("corrupt generated file", "utf-8");
      }
      return originalReadFile(filePath, ...args);
    });

    await expect(
      createFilesLib.saveGeneratedFile({
        fileType: "text",
        extension: "txt",
        buffer: Buffer.from("expected generated file", "utf-8"),
        displayFilename: "broken.txt",
      })
    ).rejects.toThrow("Write verification failed");
  });
});
