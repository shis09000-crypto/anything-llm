const fs = require("fs");
const os = require("os");
const path = require("path");

let tempRoot;
let tempBase;
let previousStorageBase;
let previousStorageDir;
let previousStorageApplied;
let previousAppEnv;

const mockReader = {
  assertReaderDocumentId: jest.fn((id) => id),
  readerDocumentRoot: jest.fn(() => tempRoot),
  readReaderMetadata: jest.fn(() => ({
    readerDocumentId: "doc-1",
    documentType: "docx",
    originalName: "original.docx",
    previewPdfName: "preview.pdf",
    originalUrl: "https://example.test/original?token=secret",
    token: "secret",
    text: "raw document body",
  })),
  metadataWithOriginalUrl: jest.fn(() => ({
    originalUrl: "/api/reader-documents/doc-1/original",
    previewPdfUrl: "/api/reader-documents/doc-1/preview.pdf",
    thumbnailUrl: "/api/reader-documents/doc-1/thumbnail.jpg",
  })),
  readerPostprocessResponse: jest.fn(() => ({
    postprocess: { status: "complete" },
  })),
  readerDocumentIsDeleted: jest.fn(() => false),
};

jest.mock("../../endpoints/workspaceReaderDocuments", () => ({
  _private: mockReader,
}));

const {
  ReaderDocumentStorageProvider,
} = require("../../providers/readerDocumentStorageProvider");

describe("ReaderDocumentStorageProvider", () => {
  beforeEach(() => {
    previousStorageBase = process.env.ANYTHINGLLM_STORAGE_BASE_DIR;
    previousStorageDir = process.env.STORAGE_DIR;
    previousStorageApplied = process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
    previousAppEnv = process.env.APP_ENV;
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "reader-provider-"));
    tempRoot = path.join(tempBase, "development");
    process.env.ANYTHINGLLM_STORAGE_BASE_DIR = tempBase;
    process.env.APP_ENV = "development";
    delete process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "original.docx"), "docx");
    fs.writeFileSync(path.join(tempRoot, "preview.pdf"), "pdf");
    fs.writeFileSync(path.join(tempRoot, "thumbnail.jpg"), "jpg");
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempBase, { recursive: true, force: true });
    if (previousStorageBase === undefined)
      delete process.env.ANYTHINGLLM_STORAGE_BASE_DIR;
    else process.env.ANYTHINGLLM_STORAGE_BASE_DIR = previousStorageBase;
    if (previousStorageDir === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = previousStorageDir;
    if (previousStorageApplied === undefined)
      delete process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED;
    else process.env.ANYTHINGLLM_ENV_STORAGE_APPLIED = previousStorageApplied;
    if (previousAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousAppEnv;
  });

  test("returns a redacted reader storage status", () => {
    const status = ReaderDocumentStorageProvider.status({
      workspace: { slug: "research" },
      readerDocumentId: "doc-1",
    });

    expect(status.files).toEqual({
      original: true,
      preview: true,
      thumbnail: true,
    });
    expect(status.urls).toEqual({
      original: true,
      previewPdf: true,
      thumbnail: true,
    });
    expect(status.metadata.originalUrl).toBeUndefined();
    expect(status.metadata.token).toBeUndefined();
    expect(status.metadata.text).toBeUndefined();
    expect(status.postprocess).toEqual({ status: "complete" });
  });

  test("returns a canonical descriptor without sensitive URLs", () => {
    const descriptor = ReaderDocumentStorageProvider.canonicalDescriptor({
      workspace: { readerStandalone: true },
      readerDocumentId: "doc-1",
    });

    expect(descriptor).toMatchObject({
      readerDocumentId: "doc-1",
      standalone: true,
      resourceId: "standalone:doc-1",
      hasOriginalUrl: true,
      hasPreviewPdfUrl: true,
      hasThumbnailUrl: true,
    });
    expect(JSON.stringify(descriptor)).not.toContain("token=secret");
  });
});
