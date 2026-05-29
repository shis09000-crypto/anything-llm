const fs = require("fs");
const os = require("os");
const path = require("path");

function loadEndpoint(storageDir) {
  jest.resetModules();
  process.env.NODE_ENV = "production";
  process.env.STORAGE_DIR = storageDir;
  jest.doMock("../../models/documents", () => ({
    Document: { get: jest.fn() },
  }));
  jest.doMock("../../utils/files", () => ({
    fileData: jest.fn(),
    isWithin: (outer, inner) => {
      if (outer === inner) return false;
      const rel = path.relative(outer, inner);
      return !rel.startsWith("../") && rel !== "..";
    },
    normalizePath: (value = "") => path.normalize(String(value).trim()),
  }));
  jest.doMock("../../utils/middleware/multiUserProtected", () => ({
    flexUserRoleValid: () => (_request, _response, next) => next(),
    ROLES: { all: "all" },
  }));
  jest.doMock("../../utils/middleware/validatedRequest", () => ({
    validatedRequest: (_request, _response, next) => next(),
  }));
  jest.doMock("../../utils/middleware/validWorkspace", () => ({
    validWorkspaceSlug: (_request, response, next) => {
      response.locals.workspace = { id: 1, slug: "workspace-a" };
      next();
    },
  }));
  return require("../../endpoints/workspaceReaderDocuments")._private;
}

describe("workspace reader documents", () => {
  const originalEnv = { ...process.env };
  let storageDir;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-reader-"));
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  it("rejects path traversal segments", () => {
    const { safeSegment } = loadEndpoint(storageDir);
    expect(() => safeSegment("../x", "workspace slug")).toThrow();
    expect(() => safeSegment("/tmp/x", "workspace slug")).toThrow();
    expect(() => safeSegment("a/b", "workspace slug")).toThrow();
  });

  it("requires UUID reader document ids", () => {
    const { assertReaderDocumentId } = loadEndpoint(storageDir);
    expect(() => assertReaderDocumentId("report.pdf")).toThrow();
    expect(() =>
      assertReaderDocumentId("2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a")
    ).not.toThrow();
  });

  it("validates file extension, mime, and size", () => {
    const { assertAllowedUpload } = loadEndpoint(storageDir);
    expect(() =>
      assertAllowedUpload({
        originalname: "report.pdf",
        mimetype: "application/pdf",
        size: 1024,
      })
    ).not.toThrow();
    expect(() =>
      assertAllowedUpload({
        originalname: "run.sh",
        mimetype: "text/plain",
        size: 1024,
      })
    ).toThrow("Unsupported reader document type.");
    expect(() =>
      assertAllowedUpload({
        originalname: "book.pdf",
        mimetype: "application/zip",
        size: 1024,
      })
    ).toThrow("Reader document MIME type is not allowed.");
    expect(() =>
      assertAllowedUpload({
        originalname: "huge.md",
        mimetype: "text/plain",
        size: 51 * 1024 * 1024,
      })
    ).toThrow("Reader document exceeds the 50MB limit.");
  });

  it("resolves reader document roots inside the reader namespace", () => {
    const { readerDocumentRoot } = loadEndpoint(storageDir);
    const root = readerDocumentRoot(
      { slug: "workspace-a" },
      "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a"
    );
    expect(root).toContain(
      path.join(
        storageDir,
        "reader-documents",
        "workspace-a",
        "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a"
      )
    );
  });
});
