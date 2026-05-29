const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { Document } = require("../models/documents");
const { fileData, isWithin, normalizePath } = require("../utils/files");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");

const SCHEMA_VERSION = 1;
const MAX_READER_FILE_SIZE = 50 * 1024 * 1024;
const READER_DOCUMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES = {
  ".md": ["text/markdown", "text/plain", "application/octet-stream"],
  ".markdown": ["text/markdown", "text/plain", "application/octet-stream"],
  ".pdf": ["application/pdf", "application/octet-stream"],
  ".docx": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
  ],
  ".xlsx": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",
  ],
};

const readerDocumentsPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, "../storage/reader-documents")
    : path.resolve(process.env.STORAGE_DIR, "reader-documents");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_READER_FILE_SIZE },
}).single("file");

function safeSegment(value, label) {
  const text = String(value || "");
  if (
    !text ||
    text.includes("..") ||
    path.isAbsolute(text) ||
    /[\\/]/.test(text)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return text;
}

function safeWorkspaceSegment(workspace) {
  return safeSegment(workspace.slug, "workspace slug");
}

function assertReaderDocumentId(readerDocumentId) {
  const id = safeSegment(readerDocumentId, "reader document id");
  if (!READER_DOCUMENT_ID_PATTERN.test(id))
    throw new Error("Invalid reader document id.");
  return id;
}

function normalizedExtension(filename = "") {
  const ext = path.extname(String(filename).toLowerCase());
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, ext))
    throw new Error("Unsupported reader document type.");
  return ext;
}

function assertAllowedUpload(file) {
  if (!file) throw new Error("Missing file.");
  if (file.size > MAX_READER_FILE_SIZE)
    throw new Error("Reader document exceeds the 50MB limit.");
  const ext = normalizedExtension(file.originalname);
  const mime = String(file.mimetype || "").toLowerCase();
  if (!ALLOWED_TYPES[ext].includes(mime))
    throw new Error("Reader document MIME type is not allowed.");
  return { ext, mime };
}

function safeResolve(root, ...segments) {
  const target = path.resolve(root, ...segments);
  if (target !== root && !isWithin(root, target))
    throw new Error("Invalid reader document path.");
  return target;
}

function readerWorkspaceRoot(workspace) {
  const root = path.resolve(readerDocumentsPath);
  const workspaceSegment = safeWorkspaceSegment(workspace);
  return safeResolve(root, workspaceSegment);
}

function readerDocumentRoot(workspace, readerDocumentId) {
  const workspaceRoot = readerWorkspaceRoot(workspace);
  const id = assertReaderDocumentId(readerDocumentId);
  return safeResolve(workspaceRoot, id);
}

function documentTypeFromExt(ext) {
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return ext.replace(".", "");
}

function markdownBlocks(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let index = 0;
  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) {
      buffer = [];
      return;
    }
    blocks.push({
      blockId: `block-${index++}`,
      type: /^#{1,6}\s/.test(content) ? "heading" : "paragraph",
      text: content,
    });
    buffer = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) flush();
    buffer.push(line);
  }
  flush();
  return blocks;
}

function contentForUpload({ readerDocumentId, documentType, buffer }) {
  if (documentType === "markdown") {
    const text = buffer.toString("utf8");
    return {
      schemaVersion: SCHEMA_VERSION,
      readerDocumentId,
      documentType,
      blocks: markdownBlocks(text),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType,
    ...(documentType === "xlsx" ? { sheets: [] } : {}),
    ...(documentType === "pdf" ? { pages: [] } : {}),
    ...(documentType === "docx" ? { blocks: [] } : {}),
  };
}

function parsedWorkspaceContent(readerDocumentId, data = {}) {
  const text = data.pageContent || "";
  return {
    schemaVersion: SCHEMA_VERSION,
    readerDocumentId,
    documentType: "markdown",
    blocks: markdownBlocks(text),
    parsedOnly: true,
  };
}

function sendUploadError(response, error) {
  if (error?.code === "LIMIT_FILE_SIZE") {
    return response.status(400).json({
      success: false,
      error: "Reader document exceeds the 50MB limit.",
    });
  }
  return response.status(400).json({
    success: false,
    error: error.message || "Invalid reader document upload.",
  });
}

function workspaceReaderDocumentsEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/reader-documents/upload",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      upload(request, response, async (uploadError) => {
        try {
          if (uploadError) return sendUploadError(response, uploadError);
          const workspace = response.locals.workspace;
          const { ext, mime } = assertAllowedUpload(request.file);
          const readerDocumentId = crypto.randomUUID();
          const documentType = documentTypeFromExt(ext);
          const storedName = `original${ext}`;
          const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
          fs.mkdirSync(documentRoot, { recursive: true });

          const originalPath = safeResolve(documentRoot, storedName);
          fs.writeFileSync(originalPath, request.file.buffer);

          const content = contentForUpload({
            readerDocumentId,
            documentType,
            buffer: request.file.buffer,
          });
          const metadata = {
            schemaVersion: SCHEMA_VERSION,
            readerDocumentId,
            source: "reader_upload",
            originalName: request.file.originalname,
            storedName,
            mimeType: mime,
            size: request.file.size,
            createdAt: new Date().toISOString(),
          };

          fs.writeFileSync(
            safeResolve(documentRoot, "content.json"),
            JSON.stringify(content, null, 2)
          );
          fs.writeFileSync(
            safeResolve(documentRoot, "metadata.json"),
            JSON.stringify(metadata, null, 2)
          );

          return response.status(200).json({
            success: true,
            readerDocumentId,
            content,
            metadata,
          });
        } catch (error) {
          return sendUploadError(response, error);
        }
      });
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/from-workspace",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const docPath = normalizePath(String(request.query.docPath || ""));
        const document = await Document.get({
          workspaceId: workspace.id,
          docpath: docPath,
        });
        if (!document)
          return response
            .status(404)
            .json({ success: false, error: "Workspace document not found." });

        const data = await fileData(document.docpath);
        if (!data?.pageContent)
          return response.status(404).json({
            success: false,
            error: "Workspace parsed content not found.",
          });

        const readerDocumentId = crypto.randomUUID();
        const content = parsedWorkspaceContent(readerDocumentId, data);
        const metadata = {
          schemaVersion: SCHEMA_VERSION,
          readerDocumentId,
          source: "workspace_parsed",
          originalName: data.title || path.basename(docPath),
          storedName: null,
          mimeType: "text/markdown",
          size: Buffer.byteLength(data.pageContent || "", "utf8"),
          createdAt: new Date().toISOString(),
          docPath,
          parsedOnly: true,
          notice: "该文档不是原始版式，仅展示已解析内容",
        };

        return response.status(200).json({
          success: true,
          content,
          metadata,
        });
      } catch (error) {
        return response
          .status(400)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId/original",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const documentRoot = readerDocumentRoot(
          workspace,
          request.params.readerDocumentId
        );
        const metadata = JSON.parse(
          fs.readFileSync(safeResolve(documentRoot, "metadata.json"), "utf8")
        );
        const originalPath = safeResolve(documentRoot, metadata.storedName);
        return response.sendFile(originalPath);
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/reader-documents/:readerDocumentId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const readerDocumentId = assertReaderDocumentId(
          request.params.readerDocumentId
        );
        const documentRoot = readerDocumentRoot(workspace, readerDocumentId);
        const content = JSON.parse(
          fs.readFileSync(safeResolve(documentRoot, "content.json"), "utf8")
        );
        const metadata = JSON.parse(
          fs.readFileSync(safeResolve(documentRoot, "metadata.json"), "utf8")
        );

        return response.status(200).json({
          success: true,
          content,
          metadata: {
            ...metadata,
            originalUrl: `/api/workspace/${workspace.slug}/reader-documents/${readerDocumentId}/original`,
          },
        });
      } catch (error) {
        return response
          .status(404)
          .json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = {
  MAX_READER_FILE_SIZE,
  workspaceReaderDocumentsEndpoints,
  _private: {
    assertAllowedUpload,
    assertReaderDocumentId,
    readerDocumentRoot,
    safeSegment,
  },
};
