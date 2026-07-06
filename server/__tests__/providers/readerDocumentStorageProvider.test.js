const fs = require("fs");
const os = require("os");
const path = require("path");

let tempRoot;

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
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reader-provider-"));
    fs.writeFileSync(path.join(tempRoot, "original.docx"), "docx");
    fs.writeFileSync(path.join(tempRoot, "preview.pdf"), "pdf");
    fs.writeFileSync(path.join(tempRoot, "thumbnail.jpg"), "jpg");
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
