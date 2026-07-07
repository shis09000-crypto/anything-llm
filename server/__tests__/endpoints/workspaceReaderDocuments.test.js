const fs = require("fs");
const os = require("os");
const path = require("path");

function loadEndpoint(storageDir, helpersMock = null) {
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
  jest.doMock("../../utils/fileAccessPolicy", () => ({
    validateReadPath: jest.fn(),
  }));
  jest.doMock("exceljs", () => ({
    Workbook: jest.fn(),
  }));
  jest.doMock("@mintplex-labs/mdpdf", () => ({
    markdownToPdf: jest.fn(async () =>
      Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
    ),
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
  jest.doMock("../../utils/authz/resourceAccess", () => ({
    fileBackedOwnerMetadata: (user = null) => ({
      ownerScopeVersion: 1,
      ownerUserId: user?.id ?? null,
      ownerAuthUserId: user?.authUserId ?? null,
    }),
    getAuthorizedFileBackedResource: jest.fn(async () => ({
      auth: { multiUser: false, authenticated: true },
      user: null,
    })),
    requestAuthContext: jest.fn(async () => ({
      multiUser: false,
      authenticated: true,
      user: null,
    })),
    stripFileBackedOwnerMetadata: (metadata = {}) => {
      const {
        ownerScopeVersion: _ownerScopeVersion,
        ownerUserId: _ownerUserId,
        ownerAuthUserId: _ownerAuthUserId,
        ...publicMetadata
      } = metadata || {};
      return publicMetadata;
    },
  }));
  jest.doMock(
    "../../utils/helpers",
    () =>
      helpersMock || {
        getLLMProvider: jest.fn(),
      }
  );
  const { ReaderRuntime } = require("../../modules/reader/runtime");
  return {
    ...ReaderRuntime.documents,
    ...ReaderRuntime.access,
    ...ReaderRuntime.preview,
    ...ReaderRuntime.postprocess,
    ...ReaderRuntime.media,
    ...ReaderRuntime.classification,
    ...ReaderRuntime.ocr,
    ...ReaderRuntime.epub,
  };
}

const TEST_READER_DOCUMENT_ID = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";

function writeMarkdownReaderDocument(api, workspace, overrides = {}) {
  const readerDocumentId = overrides.readerDocumentId || TEST_READER_DOCUMENT_ID;
  const documentRoot = api.readerDocumentRoot(workspace, readerDocumentId);
  fs.mkdirSync(documentRoot, { recursive: true });
  fs.writeFileSync(
    path.join(documentRoot, "original.md"),
    overrides.text || "哲学思想与理性传统。".repeat(200)
  );
  fs.writeFileSync(
    path.join(documentRoot, "metadata.json"),
    JSON.stringify({
      readerDocumentId,
      originalName: overrides.originalName || "哲学书.md",
      storedName: "original.md",
      mimeType: "text/markdown",
      documentType: "markdown",
      size: 1024,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      ...overrides.metadata,
    })
  );
  fs.writeFileSync(
    path.join(documentRoot, "content.json"),
    JSON.stringify({
      documentType: "markdown",
      markdown: overrides.text || "哲学思想与理性传统。".repeat(200),
    })
  );
  return { readerDocumentId, documentRoot };
}

function readerContentRequest(headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    headers: normalized,
    path: "/api/reader-documents/test/original",
    route: { path: "/api/reader-documents/:readerDocumentId/original" },
    clientContext: {
      clientId: normalized["x-athena-client-id"] || "client-a",
      requestId: "request-a",
    },
    header(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
}

function readerContentResponse(userId = 7) {
  return {
    locals: {
      user: { id: userId },
    },
  };
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
        size: 501 * 1024 * 1024,
      })
    ).toThrow("Reader document exceeds the 500MB limit.");
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
        "production",
        "reader-documents",
        "workspace-a",
        "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a"
      )
    );
  });

  it("resolves standalone reader document roots outside workspace scopes", () => {
    const { readerDocumentRoot, STANDALONE_READER_SCOPE } =
      loadEndpoint(storageDir);
    const root = readerDocumentRoot(
      STANDALONE_READER_SCOPE,
      "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a"
    );
    expect(root).toContain(
      path.join(
        storageDir,
        "production",
        "reader-documents",
        "__global_reader__",
        "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a"
      )
    );
    expect(root).not.toContain(path.join("reader-documents", "workspace-a"));
  });

  it("does not expose file-backed owner metadata in reader responses", () => {
    const { metadataWithOriginalUrl, STANDALONE_READER_SCOPE } =
      loadEndpoint(storageDir);
    const metadata = metadataWithOriginalUrl(
      STANDALONE_READER_SCOPE,
      "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a",
      {
        originalName: "book.pdf",
        mimeType: "application/pdf",
        size: 1024,
        originalFingerprint: "abc123",
        ownerScopeVersion: 1,
        ownerUserId: 10,
        ownerAuthUserId: "auth-10",
      }
    );

    expect(metadata).toMatchObject({
      originalName: "book.pdf",
      readerDocumentWorkspaceSlug: null,
      originalUrl:
        "/api/reader-documents/2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a/original",
      stream: {
        streamUrl:
          "/api/reader-documents/2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a/original",
        url: "/api/reader-documents/2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a/original",
        size: 1024,
        etag: "abc123",
        supportsRange: true,
        cacheControl: "private, max-age=604800, no-transform",
        mimeType: "application/pdf",
        documentType: "pdf",
      },
    });
    expect(metadata).not.toHaveProperty("ownerScopeVersion");
    expect(metadata).not.toHaveProperty("ownerUserId");
    expect(metadata).not.toHaveProperty("ownerAuthUserId");
  });

  it("does not expose stale DOCX preview URL when preview.pdf is missing", () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const readerDocumentId = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";
    fs.mkdirSync(api.readerDocumentRoot(workspace, readerDocumentId), {
      recursive: true,
    });

    const metadata = api.metadataWithOriginalUrl(workspace, readerDocumentId, {
      readerDocumentId,
      originalName: "合同.docx",
      storedName: "original.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      documentType: "docx",
      size: 1024,
      previewPdfName: "preview.pdf",
      previewPdfUrl: "/api/reader-documents/stale/preview.pdf",
    });

    expect(metadata.previewPdfName).toBeNull();
    expect(metadata.previewPdfUrl).toBeNull();
    expect(metadata.previewMimeType).toBeNull();
    expect(metadata.previewStatus).toBe("missing");
  });

  it("exposes DOCX preview URL only when preview.pdf exists", () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const readerDocumentId = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";
    const documentRoot = api.readerDocumentRoot(workspace, readerDocumentId);
    fs.mkdirSync(documentRoot, { recursive: true });
    fs.writeFileSync(path.join(documentRoot, "preview.pdf"), "%PDF-1.7\n");

    const metadata = api.metadataWithOriginalUrl(workspace, readerDocumentId, {
      readerDocumentId,
      originalName: "合同.docx",
      storedName: "original.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      documentType: "docx",
      size: 1024,
      previewPdfName: "preview.pdf",
    });

    expect(metadata.previewPdfUrl).toBe(
      "/api/workspace/workspace-a/reader-documents/2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a/preview.pdf"
    );
    expect(metadata.previewMimeType).toBe("application/pdf");
    expect(metadata.previewStatus).toBe("ready");
  });

  it("exposes Markdown preview URL only when preview.pdf exists", () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const readerDocumentId = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";
    const documentRoot = api.readerDocumentRoot(workspace, readerDocumentId);
    fs.mkdirSync(documentRoot, { recursive: true });
    fs.writeFileSync(path.join(documentRoot, "preview.pdf"), "%PDF-1.7\n");

    const metadata = api.metadataWithOriginalUrl(workspace, readerDocumentId, {
      readerDocumentId,
      originalName: "笔记.md",
      storedName: "original.md",
      mimeType: "text/markdown",
      documentType: "markdown",
      size: 1024,
      previewPdfName: "preview.pdf",
    });

    expect(metadata.previewPdfUrl).toBe(
      "/api/workspace/workspace-a/reader-documents/2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a/preview.pdf"
    );
    expect(metadata.previewMimeType).toBe("application/pdf");
    expect(metadata.previewStatus).toBe("ready");
  });

  it("reports reader preview engine status without exposing document content", () => {
    const api = loadEndpoint(storageDir);
    const status = api.readerPreviewEngineStatus();

    expect(status.docx.engine).toBe("libreoffice");
    expect(typeof status.docx.available).toBe("boolean");
    expect(status.markdown.engine).toBe("mdpdf");
    expect(status.markdown.available).toBe(true);
    expect(Array.isArray(status.fonts.required)).toBe(true);
  });

  it("lists PDF reader documents when a legacy manifest is missing", async () => {
    const {
      listReaderDocumentsForWorkspace,
      readerDocumentRoot,
      readOptionalReaderPdfManifest,
    } = loadEndpoint(storageDir);
    const readerDocumentId = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";
    const workspace = { id: 1, slug: "workspace-a" };
    const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
    fs.mkdirSync(documentRoot, { recursive: true });
    fs.writeFileSync(
      path.join(documentRoot, "metadata.json"),
      JSON.stringify({
        originalName: "legacy-book.pdf",
        mimeType: "application/pdf",
        documentType: "pdf",
        size: 1024,
        originalFingerprint: "legacy-fingerprint",
        createdAt: "2026-07-01T00:00:00.000Z",
      })
    );

    expect(
      readOptionalReaderPdfManifest(documentRoot, readerDocumentId)
    ).toBeNull();

    const documents = await listReaderDocumentsForWorkspace({
      request: {},
      response: {},
      workspace,
    });

    expect(documents).toHaveLength(1);
    expect(documents[0].readerDocumentId).toBe(readerDocumentId);
    expect(documents[0].metadata).toMatchObject({
      originalName: "legacy-book.pdf",
      pagePreviewUrl:
        "/api/workspace/workspace-a/reader-documents/2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a/page-preview",
      pdfManifest: null,
    });
  });

  it("hides tombstoned reader documents from list responses", async () => {
    const {
      listReaderDocumentsForWorkspace,
      markReaderDocumentDeleted,
      readerDocumentIsDeleted,
      readerDocumentRoot,
    } = loadEndpoint(storageDir);
    const readerDocumentId = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";
    const workspace = { id: 1, slug: "workspace-a" };
    const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
    fs.mkdirSync(documentRoot, { recursive: true });
    const metadata = {
      readerDocumentId,
      originalName: "deleted-book.md",
      storedName: "original.md",
      mimeType: "text/markdown",
      documentType: "markdown",
      size: 128,
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(documentRoot, "metadata.json"),
      JSON.stringify(metadata)
    );
    fs.writeFileSync(
      path.join(documentRoot, "content.json"),
      JSON.stringify({ documentType: "markdown", blocks: [] })
    );

    markReaderDocumentDeleted({ workspace, readerDocumentId, metadata });

    expect(readerDocumentIsDeleted(documentRoot)).toBe(true);
    const documents = await listReaderDocumentsForWorkspace({
      request: {},
      response: {},
      workspace,
    });
    expect(documents).toEqual([]);
  });

  it("detects visible duplicate uploads and ignores tombstoned matches", async () => {
    const {
      duplicateSignatureFor,
      findReaderDuplicateCandidate,
      markReaderDocumentDeleted,
      readerDocumentRoot,
    } = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const readerDocumentId = "2f3291ca-5c2b-4a89-90fd-e8ff4de55b4a";
    const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
    const leadText =
      "这是一段用于重复检测的开头文字，长度需要超过一百个字符，确保哈希可以稳定生成并且后端能够识别同一本书籍的重复上传。继续补足字符。".repeat(
        3
      );
    const signature = duplicateSignatureFor({
      originalName: "重复测试.md",
      leadText,
    });
    fs.mkdirSync(documentRoot, { recursive: true });
    const metadata = {
      readerDocumentId,
      originalName: "重复测试.md",
      storedName: "original.md",
      mimeType: "text/markdown",
      documentType: "markdown",
      size: 256,
      createdAt: "2026-07-01T00:00:00.000Z",
      readerDuplicate: signature,
    };
    fs.writeFileSync(
      path.join(documentRoot, "metadata.json"),
      JSON.stringify(metadata)
    );
    fs.writeFileSync(
      path.join(documentRoot, "content.json"),
      JSON.stringify({ documentType: "markdown", blocks: [] })
    );

    const request = { body: {} };
    const response = {};
    const visibleResult = await findReaderDuplicateCandidate({
      request,
      response,
      uploadWorkspace: workspace,
      originalName: "重复测试.md",
      leadText,
    });
    expect(visibleResult.duplicate).toMatchObject({
      readerDocumentId,
      title: "重复测试.md",
      workspaceSlug: "workspace-a",
    });

    markReaderDocumentDeleted({ workspace, readerDocumentId, metadata });
    const deletedResult = await findReaderDuplicateCandidate({
      request: { body: { ignoredReaderDocumentIds: readerDocumentId } },
      response,
      uploadWorkspace: workspace,
      originalName: "重复测试.md",
      leadText,
    });
    expect(deletedResult.duplicate).toBeNull();
  });

  it("sets cacheable byte-range headers for reader originals", () => {
    const { readerOriginalEtag, setReaderOriginalHeaders } =
      loadEndpoint(storageDir);
    const originalPath = path.join(storageDir, "book.pdf");
    fs.writeFileSync(originalPath, Buffer.from("0123456789"));
    const headers = {};
    const response = {
      setHeader: jest.fn((name, value) => {
        headers[name] = value;
      }),
    };

    setReaderOriginalHeaders(response, originalPath, {
      mimeType: "application/pdf",
      originalFingerprint: "abc123",
      size: 10,
    });

    expect(
      readerOriginalEtag(originalPath, { originalFingerprint: "abc123" })
    ).toBe('"reader-abc123"');
    expect(headers).toMatchObject({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=604800, no-transform",
      "Content-Type": "application/pdf",
      ETag: '"reader-abc123"',
      "X-Reader-Stream": "range",
    });
  });

  it("requires sensitive session or dev-control grant for reader content", () => {
    const api = loadEndpoint(storageDir);
    const workspace = api.STANDALONE_READER_SCOPE;
    const readerDocumentId = TEST_READER_DOCUMENT_ID;
    const response = readerContentResponse(7);

    expect(
      api.validateReaderContentAccess({
        request: readerContentRequest({
          "x-athena-client-id": "client-a",
        }),
        response,
        workspace,
        readerDocumentId,
        endpoint: "original",
      })
    ).toMatchObject({
      ok: false,
      error: "sensitive_session_required",
    });

    const sessionRequest = readerContentRequest({
      "x-athena-client-id": "client-a",
    });
    const session = api.readerSensitiveSessionForResponse(
      sessionRequest,
      response,
      workspace,
      readerDocumentId
    );
    const sessionAccess = api.validateReaderContentAccess({
      request: readerContentRequest({
        "x-athena-client-id": "client-a",
        "x-athena-sensitive-session": session.token,
      }),
      response,
      workspace,
      readerDocumentId,
      endpoint: "original",
    });
    expect(sessionAccess).toMatchObject({
      ok: true,
      via: "sensitive-session",
    });

    const {
      issueReaderDebugAccessGrant,
      READER_DEBUG_ACCESS_HEADER,
    } = require("../../utils/devControl/readerDebugAccess");
    const grant = issueReaderDebugAccessGrant({
      userId: 7,
      clientId: "client-a",
      workspaceSlug: null,
      readerDocumentId,
      endpoints: ["original"],
    });
    const grantAccess = api.validateReaderContentAccess({
      request: readerContentRequest({
        "x-athena-client-id": "client-a",
        [READER_DEBUG_ACCESS_HEADER]: grant.debugGrantId,
      }),
      response,
      workspace,
      readerDocumentId,
      endpoint: "original",
    });
    expect(grantAccess).toMatchObject({
      ok: true,
      via: "dev-control-debug-grant",
    });
  });

  it("reports reader OCR config without leaking secrets", () => {
    const { readerOcrConfigStatus } = loadEndpoint(storageDir);
    const configured = readerOcrConfigStatus({
      READER_OCR_PROVIDER: "alibaba",
      READER_OCR_MODEL_PREF: "qwen3.5-ocr",
      READER_OCR_API_KEY: "sk-secret",
      READER_OCR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    expect(configured).toEqual({
      success: true,
      configured: true,
      provider: "alibaba",
      modelConfigured: true,
      apiKeyConfigured: true,
      baseUrlConfigured: true,
      reason: "configured",
    });
    expect(JSON.stringify(configured)).not.toContain("sk-secret");

    expect(
      readerOcrConfigStatus({
        READER_OCR_PROVIDER: "alibaba",
        READER_OCR_API_KEY: "sk-secret",
        READER_OCR_BASE_URL:
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })
    ).toMatchObject({
      configured: false,
      modelConfigured: false,
      apiKeyConfigured: true,
      baseUrlConfigured: true,
      reason: "missing_model",
    });
    expect(
      readerOcrConfigStatus({
        READER_OCR_PROVIDER: "alibaba",
        READER_OCR_MODEL_PREF: "qwen3.5-ocr",
        READER_OCR_BASE_URL:
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
      })
    ).toMatchObject({
      configured: false,
      modelConfigured: true,
      apiKeyConfigured: false,
      baseUrlConfigured: true,
      reason: "missing_api_key",
    });
    expect(
      readerOcrConfigStatus({
        READER_OCR_PROVIDER: "alibaba",
        READER_OCR_MODEL_PREF: "qwen3.5-ocr",
        READER_OCR_API_KEY: "sk-secret",
      })
    ).toMatchObject({
      configured: false,
      modelConfigured: true,
      apiKeyConfigured: true,
      baseUrlConfigured: false,
      reason: "missing_base_url",
    });
    expect(readerOcrConfigStatus({})).toMatchObject({
      configured: false,
      provider: "none",
      reason: "disabled",
    });
  });

  it("caps classification samples before model use", () => {
    const { cappedClassificationSamples, classificationSampleCharCount } =
      loadEndpoint(storageDir);
    const samples = [{ text: "a".repeat(2_000) }, { text: "b".repeat(2_000) }];
    const capped = cappedClassificationSamples(samples);
    expect(classificationSampleCharCount(capped)).toBe(3_000);
    expect(capped[1].text).toHaveLength(1_000);
  });

  it("builds server-side samples without exceeding the LLM payload cap", () => {
    const { buildReaderClassificationSamples, classificationSampleCharCount } =
      loadEndpoint(storageDir);
    const result = buildReaderClassificationSamples("哲学思想".repeat(30_000));
    expect(result.ok).toBe(true);
    expect(result.totalChars).toBeGreaterThanOrEqual(100_000);
    expect(result.sampleCount).toBe(5);
    expect(result.sampleStrategy).toBe("balanced-5x500");
    expect(classificationSampleCharCount(result.samples)).toBeLessThanOrEqual(
      3_000
    );
  });

  it("caps server-side markdown extraction at the classification text limit", async () => {
    const { extractReaderClassificationText } = loadEndpoint(storageDir);
    const filePath = path.join(storageDir, "large.md");
    fs.writeFileSync(filePath, "正文".repeat(60_000));
    const text = await extractReaderClassificationText({
      documentType: "markdown",
      originalPath: filePath,
    });
    expect(text.length).toBeLessThanOrEqual(100_000);
  });

  it("sanitizes postprocess task requests", () => {
    const { sanitizedPostprocessTasks } = loadEndpoint(storageDir);
    expect(
      sanitizedPostprocessTasks(["thumbnail", "bad", "classification"])
    ).toEqual(["thumbnail", "classification"]);
    expect(sanitizedPostprocessTasks([])).toEqual([
      "preview",
      "thumbnail",
      "classification",
      "pdfManifest",
    ]);
  });

  it("returns an active postprocess status instead of duplicating jobs", async () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const { readerDocumentId } = writeMarkdownReaderDocument(api, workspace);

    const first = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["classification"],
      categories: [{ id: "unknown", name: "未知分类" }],
    });
    const second = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["classification"],
      categories: [{ id: "unknown", name: "未知分类" }],
    });

    expect(first.status).toBe("queued");
    expect(["queued", "processing"]).toContain(second.status);
    expect(second.requestedTasks).toEqual(["classification"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("generates Markdown preview PDF during preview postprocess", async () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const { readerDocumentId, documentRoot } = writeMarkdownReaderDocument(
      api,
      workspace
    );

    const queued = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["preview"],
      categories: [],
      force: true,
    });
    expect(queued.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const status = api.readReaderPostprocessStatus(
      documentRoot,
      readerDocumentId
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.join(documentRoot, "metadata.json"), "utf8")
    );
    expect(status.tasks.preview.status).toBe("complete");
    expect(metadata.previewPdfName).toBe("preview.pdf");
    expect(metadata.previewStatus).toBe("ready");
    expect(metadata.previewSource).toBe("mdpdf");
    expect(metadata.previewAttemptCount).toBe(1);
    expect(metadata.previewLastError).toBeNull();
    expect(fs.existsSync(path.join(documentRoot, "preview.pdf"))).toBe(true);
  });

  it("retries old failed Markdown preview metadata when forced", async () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const { readerDocumentId, documentRoot } = writeMarkdownReaderDocument(
      api,
      workspace,
      {
        metadata: {
          previewStatus: "failed",
          previewWarning: "mdpdf was unavailable",
          previewLastError: "mdpdf was unavailable",
          previewAttemptCount: 3,
          previewFingerprint: "old-fingerprint",
        },
      }
    );

    const queued = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["preview"],
      categories: [],
      force: true,
    });
    expect(queued.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 80));

    const metadata = JSON.parse(
      fs.readFileSync(path.join(documentRoot, "metadata.json"), "utf8")
    );
    expect(metadata.previewStatus).toBe("ready");
    expect(metadata.previewPdfName).toBe("preview.pdf");
    expect(metadata.previewWarning).toBeNull();
    expect(metadata.previewLastError).toBeNull();
    expect(metadata.previewAttemptCount).toBe(4);
  });

  it("reuses completed postprocess results unless forced", () => {
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const { readerDocumentId, documentRoot } = writeMarkdownReaderDocument(
      api,
      workspace
    );
    const completedStatus = {
      schemaVersion: 1,
      readerDocumentId,
      status: "complete",
      requestedTasks: ["classification"],
      queuedAt: "2026-07-01T00:00:00.000Z",
      startedAt: "2026-07-01T00:00:01.000Z",
      completedAt: "2026-07-01T00:00:02.000Z",
      updatedAt: "2026-07-01T00:00:02.000Z",
      tasks: {
        classification: {
          status: "complete",
          reason: "done",
          result: {
            success: true,
            categoryStatus: "classified",
            category: {
              primaryCategoryId: "philosophy",
              primaryCategoryName: "哲学思想",
              source: "llm",
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(documentRoot, "postprocess.json"),
      JSON.stringify(completedStatus)
    );

    const reused = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["classification"],
      categories: [{ id: "philosophy", name: "哲学思想" }],
    });
    expect(reused.status).toBe("complete");
    expect(reused.queuedAt).toBe(completedStatus.queuedAt);

    const forced = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["classification"],
      categories: [{ id: "philosophy", name: "哲学思想" }],
      force: true,
    });
    expect(forced.status).toBe("queued");
  });

  it("skips automatic classification when disabled but allows forced manual classification", async () => {
    process.env.READER_AUTO_CLASSIFICATION_ENABLED = "false";
    const api = loadEndpoint(storageDir);
    const workspace = { id: 1, slug: "workspace-a" };
    const { readerDocumentId } = writeMarkdownReaderDocument(api, workspace);

    expect(api.readerAutoClassificationEnabled()).toBe(false);
    const skipped = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["classification"],
      categories: [{ id: "unknown", name: "未知分类" }],
    });
    expect(skipped.tasks.classification.status).toBe("skipped");
    expect(skipped.tasks.classification.reason).toBe("自动分类已关闭。");

    const manual = api.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: ["classification"],
      categories: [{ id: "unknown", name: "未知分类" }],
      force: true,
    });
    expect(manual.status).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("prioritizes target and nearby pages for PDF preview windows", () => {
    const { orderedPdfPreviewWindowPages } = loadEndpoint(storageDir);
    expect(
      orderedPdfPreviewWindowPages({
        centerPage: 20,
        manifest: { pageCount: 24 },
        before: 2,
        after: 3,
      })
    ).toEqual([20, 21, 19, 22, 18, 23]);
    expect(
      orderedPdfPreviewWindowPages({
        centerPage: 2,
        manifest: { pageCount: 3 },
        before: 4,
        after: 4,
      })
    ).toEqual([2, 3, 1]);
  });

  it("starts large PDF preview prebuild with target pages before full sweep", () => {
    const { orderedPdfPreviewPrebuildPages } = loadEndpoint(storageDir);
    const pages = orderedPdfPreviewPrebuildPages({
      manifest: { pageCount: 40 },
      focusPage: 20,
      includeAll: true,
    });
    expect(pages.slice(0, 6)).toEqual([20, 21, 19, 22, 18, 23]);
    expect(pages).toContain(1);
    expect(pages).toContain(40);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("parses classification JSON from thinking and wrapped responses", () => {
    const { parseClassificationJson } = loadEndpoint(storageDir);
    expect(
      parseClassificationJson(
        '<think>推理过程</think>{"primaryCategoryId":"philosophy"}'
      )
    ).toEqual({ primaryCategoryId: "philosophy" });
    expect(
      parseClassificationJson('```json\n{"primaryCategoryId":"history"}\n```')
    ).toEqual({ primaryCategoryId: "history" });
    expect(
      parseClassificationJson(
        '分类结果如下："书籍分类" {"primaryCategoryId":"economics","confidence":0.9}。'
      )
    ).toEqual({ primaryCategoryId: "economics", confidence: 0.9 });
  });

  it("falls back when DeepSeek key is missing", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const { classifyReaderDocumentWithDeepSeek } = loadEndpoint(storageDir);
    const result = await classifyReaderDocumentWithDeepSeek({
      categories: [{ id: "philosophy", name: "哲学思想" }],
      samples: [{ text: "哲学思想与理性传统。" }],
    });
    expect(result.categoryStatus).toBe("unknown");
    expect(result.reason).toBe("分类模型未配置，已归入未知分类。");
    expect(result.reason).not.toMatch(/DEEPSEEK|API_KEY|stack/i);
  });

  it("uses fixed DeepSeek flash model and validates category ids", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const getChatCompletion = jest.fn(async () => ({
      textResponse: JSON.stringify({
        primaryCategoryId: "invented",
        primaryCategoryName: "自创分类",
        confidence: 0.9,
        tags: ["测试"],
        evidence: ["测试"],
        reason: "测试",
      }),
      metrics: { duration: 0.01 },
    }));
    const getLLMProvider = jest.fn(() => ({
      compressMessages: jest.fn(async ({ userPrompt }) => [
        { role: "user", content: userPrompt },
      ]),
      getChatCompletion,
    }));
    const { classifyReaderDocumentWithDeepSeek } = loadEndpoint(storageDir, {
      getLLMProvider,
    });
    const result = await classifyReaderDocumentWithDeepSeek({
      title: "book",
      documentType: "epub",
      categories: [{ id: "philosophy", name: "哲学思想" }],
      samples: [{ text: "哲学思想与理性传统。" }],
      sampleStrategy: "balanced-2x200",
      totalChars: 500,
    });
    expect(getLLMProvider).toHaveBeenCalledWith({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(getChatCompletion).toHaveBeenCalledWith(expect.any(Array), {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });
    expect(result.categoryStatus).toBe("unknown");
    expect(result.reason).toBe("分类模型选择了不存在的分类，已归入未知分类。");
  });

  it("classifies valid DeepSeek JSON responses with reasoning content", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const getChatCompletion = jest.fn(async () => ({
      textResponse:
        '<think>这本书讨论理性、存在和知识传统。</think>{"primaryCategoryId":"philosophy","primaryCategoryName":"哲学思想","secondaryCategory":"西方哲学","confidence":0.88,"tags":["哲学"],"evidence":["理性、存在和知识传统"],"reason":"文本明显讨论哲学思想。"}',
      metrics: { duration: 0.02 },
    }));
    const getLLMProvider = jest.fn(() => ({
      compressMessages: jest.fn(async ({ userPrompt }) => [
        { role: "user", content: userPrompt },
      ]),
      getChatCompletion,
    }));
    const { classifyReaderDocumentWithDeepSeek } = loadEndpoint(storageDir, {
      getLLMProvider,
    });
    const result = await classifyReaderDocumentWithDeepSeek({
      title: "西方哲学史",
      documentType: "epub",
      categories: [
        { id: "unknown", name: "未知分类" },
        { id: "philosophy", name: "哲学思想" },
      ],
      samples: [{ text: "理性、存在和知识传统构成了哲学史的主要线索。" }],
      sampleStrategy: "balanced-2x200",
      totalChars: 500,
    });

    expect(result.categoryStatus).toBe("classified");
    expect(result.category.primaryCategoryId).toBe("philosophy");
    expect(result.category.source).toBe("llm");
    expect(getChatCompletion).toHaveBeenCalledWith(expect.any(Array), {
      temperature: 0.1,
      responseFormat: { type: "json_object" },
    });
  });

  it("matches classification categories by localized name", () => {
    const { validateClassificationResult } = loadEndpoint(storageDir);
    const result = validateClassificationResult({
      result: {
        primaryCategoryId: "金融经济",
        primaryCategoryName: "金融经济",
        confidence: 0.88,
        reason: "文本讨论金融与投资。",
      },
      categories: [
        { id: "unknown", name: "未知分类" },
        { id: "finance", name: "金融经济" },
      ],
      sampleStrategy: "balanced-2x200",
    });

    expect(result.categoryStatus).toBe("classified");
    expect(result.category.primaryCategoryId).toBe("finance");
    expect(result.category.primaryCategoryName).toBe("金融经济");
    expect(result.category.source).toBe("llm");
  });

  it("falls back on invalid classification JSON", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const getLLMProvider = jest.fn(() => ({
      compressMessages: jest.fn(async ({ userPrompt }) => [
        { role: "user", content: userPrompt },
      ]),
      getChatCompletion: jest.fn(async () => ({
        textResponse: "<think>推理</think>不是 JSON",
        metrics: { duration: 0.01 },
      })),
    }));
    const { classifyReaderDocumentWithDeepSeek } = loadEndpoint(storageDir, {
      getLLMProvider,
    });
    const result = await classifyReaderDocumentWithDeepSeek({
      title: "book",
      documentType: "pdf",
      categories: [{ id: "philosophy", name: "哲学思想" }],
      samples: [{ text: "哲学思想与理性传统。" }],
      sampleStrategy: "balanced-2x200",
      totalChars: 500,
    });
    expect(result.categoryStatus).toBe("unknown");
    expect(result.reason).toBe("分类模型返回格式异常，已归入未知分类。");
  });

  it("falls back on low confidence", () => {
    const { validateClassificationResult } = loadEndpoint(storageDir);
    const result = validateClassificationResult({
      result: {
        primaryCategoryId: "philosophy",
        confidence: 0.4,
      },
      categories: [
        { id: "unknown", name: "未知分类" },
        { id: "philosophy", name: "哲学思想" },
      ],
      sampleStrategy: "balanced-2x200",
    });
    expect(result.categoryStatus).toBe("unknown");
    expect(result.reason).toBe("分类置信度较低，已归入未知分类。");
  });

  it("uses title keyword fallback for low-confidence finance books", () => {
    const { validateClassificationResult } = loadEndpoint(storageDir);
    const result = validateClassificationResult({
      title: "涛动周期论超高清版本_可搜索.pdf",
      result: {
        primaryCategoryId: "finance",
        confidence: 0.35,
      },
      categories: [
        { id: "unknown", name: "未知分类" },
        { id: "finance", name: "金融经济" },
      ],
      sampleStrategy: "balanced-2x200",
    });

    expect(result.categoryStatus).toBe("classified");
    expect(result.categoryStage).toBe("fallback-rule");
    expect(result.category.primaryCategoryId).toBe("finance");
    expect(result.category.source).toBe("fallback-rule");
    expect(result.reason).toContain("金融经济");
    expect(result.reason).not.toContain("未知分类");
    expect(result.category.confidence).toBeLessThan(0.55);
  });
});
