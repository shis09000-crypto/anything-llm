/* global jest, describe, beforeEach, afterEach, it, expect */
const fs = require("fs/promises");
const path = require("path");

jest.mock("../../../utils/fileAccessPolicy", () => ({
  validateReadPath: jest.fn(async (inputPath) => ({
    allowed: true,
    path: inputPath,
    reason: null,
    message: null,
  })),
  validateWritePath: jest.fn(async (inputPath) => ({
    allowed: true,
    path: inputPath,
    reason: null,
    message: null,
  })),
  getAllowedDirectories: jest.fn(async () => []),
  explainDenial: jest.fn((reason) => reason),
}));

const { validateWritePath } = require("../../../utils/fileAccessPolicy");
const {
  FilesystemWriteTextFile,
} = require("../../../utils/agents/aibitat/plugins/filesystem/write-text-file");

const filesystemRoot = path.resolve(
  __dirname,
  "../../../storage/anythingllm-fs"
);
const testRoot = path.join(filesystemRoot, "__write_verify_tests__");

function setupTool() {
  let tool = null;
  const aibitat = {
    handlerProps: {
      fileAccessContext: {},
      log: jest.fn(),
    },
    introspect: jest.fn(),
    function: (definition) => {
      tool = definition;
    },
  };
  FilesystemWriteTextFile.plugin().setup(aibitat);
  return { tool, aibitat };
}

describe("filesystem-write-text-file", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it("writes relative paths under server/storage/anythingllm-fs and verifies content", async () => {
    const { tool } = setupTool();

    const result = await tool.handler.call(tool, {
      path: "__write_verify_tests__/foo.txt",
      content: "hello from verified write",
    });
    const expectedPath = path.join(testRoot, "foo.txt");

    expect(result).toContain("bytes verified");
    expect(validateWritePath).toHaveBeenCalledWith(expectedPath, {
      tool: "filesystem-write-text-file",
    });
    await expect(fs.readFile(expectedPath, "utf-8")).resolves.toBe(
      "hello from verified write"
    );
  });

  it("creates missing parent directories before writing", async () => {
    const { tool } = setupTool();
    const targetPath = path.join(testRoot, "nested/a.txt");

    const result = await tool.handler.call(tool, {
      path: "__write_verify_tests__/nested/a.txt",
      content: "nested content",
    });

    expect(result).toContain("bytes verified");
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe(
      "nested content"
    );
  });

  it("atomically overwrites existing files and verifies the replacement", async () => {
    const { tool } = setupTool();
    const targetPath = path.join(testRoot, "overwrite.txt");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "old content", "utf-8");

    const result = await tool.handler.call(tool, {
      path: "__write_verify_tests__/overwrite.txt",
      content: "new content",
    });

    expect(result).toContain("bytes verified");
    await expect(fs.readFile(targetPath, "utf-8")).resolves.toBe("new content");
  });

  it("returns an error instead of success when write verification fails", async () => {
    const originalReadFile = fs.readFile.bind(fs);
    jest
      .spyOn(fs, "readFile")
      .mockImplementation(async (filePath, encoding) => {
        if (String(filePath).endsWith("mismatch.txt")) return "corrupt content";
        return originalReadFile(filePath, encoding);
      });
    const { tool } = setupTool();

    const result = await tool.handler.call(tool, {
      path: "__write_verify_tests__/mismatch.txt",
      content: "expected content",
    });

    expect(result).toContain("Error writing file: Write verification failed");
    expect(result).not.toContain("Successfully wrote");
  });
});
