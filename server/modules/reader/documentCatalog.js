const crypto = require("crypto");
const fs = require("fs");
const {
  getAuthorizedFileBackedResource,
  getAuthorizedWorkspace,
} = require("../../utils/authz/resourceAccess");
const classificationPipeline = require("./classificationPipeline");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const pdfMedia = require("./pdfMedia");
const postprocessPipeline = require("./postprocessPipeline");
const readerLinks = require("./readerLinks");

const READER_DUPLICATE_LEAD_TEXT_CHARS = 100;

function isoNow() {
  return new Date().toISOString();
}

function readerDocumentNotFoundError() {
  const error = new Error("Reader document not found.");
  error.status = 404;
  return error;
}

function normalizeDuplicateTitle(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\.(pdf|docx|xlsx|epub|md|markdown|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeDuplicateLeadText(value = "") {
  return classificationPipeline
    .compactClassificationText(value)
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .slice(0, READER_DUPLICATE_LEAD_TEXT_CHARS);
}

function hashDuplicateLeadText(value = "") {
  const normalized = normalizeDuplicateLeadText(value);
  if (!normalized || normalized.length < READER_DUPLICATE_LEAD_TEXT_CHARS)
    return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function duplicateSignatureFor({ originalName = "", leadText = "" }) {
  return {
    titleKey: normalizeDuplicateTitle(originalName),
    leadTextHash: hashDuplicateLeadText(leadText),
  };
}

async function textFromPdfFirstPages(originalPath, pageLimit = 3) {
  const pdfjs = classificationPipeline.optionalRequire(
    "pdfjs-dist/legacy/build/pdf"
  );
  if (!pdfjs?.getDocument) {
    const pdfParse = classificationPipeline.optionalRequire("pdf-parse");
    if (typeof pdfParse !== "function") return "";
    const data = await pdfParse(fs.readFileSync(originalPath), {
      max: Math.max(1, pageLimit),
    });
    return classificationPipeline.compactClassificationText(data?.text || "");
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(originalPath)),
  });
  const pdfDocument = await loadingTask.promise;
  const accumulator = classificationPipeline.createClassificationAccumulator(
    READER_DUPLICATE_LEAD_TEXT_CHARS * 4
  );
  try {
    const limit = Math.min(pdfDocument.numPages || 0, Math.max(1, pageLimit));
    for (let pageNo = 1; pageNo <= limit; pageNo += 1) {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      accumulator.append(content.items.map((item) => item.str || "").join(" "));
      page.cleanup?.();
      if (
        normalizeDuplicateLeadText(accumulator.text()).length >=
        READER_DUPLICATE_LEAD_TEXT_CHARS
      )
        break;
    }
  } finally {
    await pdfDocument.destroy?.();
  }
  return accumulator.text();
}

async function extractReaderDuplicateLeadText({
  documentType,
  originalPath,
  buffer = null,
}) {
  if (documentType === "markdown" && buffer)
    return buffer
      .toString("utf8")
      .slice(0, READER_DUPLICATE_LEAD_TEXT_CHARS * 8);
  if (!originalPath || !documentsCore.validNonEmptyFile(originalPath))
    return "";
  if (documentType === "pdf")
    return await textFromPdfFirstPages(originalPath, 3);
  return await classificationPipeline.extractReaderClassificationText({
    documentType,
    originalPath,
  });
}

function ignoredReaderDocumentIdsFromRequest(request) {
  const raw =
    request.body?.ignoredReaderDocumentIds ||
    request.body?.ignoredReaderDocumentId ||
    "";
  const values = Array.isArray(raw)
    ? raw
    : (() => {
        try {
          const parsed = JSON.parse(String(raw || "[]"));
          return Array.isArray(parsed) ? parsed : [raw];
        } catch {
          return String(raw || "")
            .split(",")
            .map((id) => id.trim());
        }
      })();
  return new Set(
    values
      .map((id) => {
        try {
          return documentsCore.assertReaderDocumentId(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );
}

function duplicateCandidateMetadata(metadata = {}) {
  return {
    titleKey:
      metadata.readerDuplicate?.titleKey ||
      metadata.duplicateTitleKey ||
      normalizeDuplicateTitle(metadata.originalName),
    leadTextHash:
      metadata.readerDuplicate?.leadTextHash ||
      metadata.duplicateLeadTextHash ||
      null,
  };
}

async function ensureDuplicateSignatureForCandidate({
  documentRoot,
  metadata,
}) {
  const current = duplicateCandidateMetadata(metadata);
  if (current.titleKey && current.leadTextHash) return current;
  try {
    const originalPath = await documentsCore.originalPathForReaderDocument({
      documentRoot,
      metadata,
    });
    const leadText = await extractReaderDuplicateLeadText({
      documentType: ingestCore.documentTypeFromMetadata(metadata),
      originalPath,
    });
    const signature = duplicateSignatureFor({
      originalName: metadata.originalName,
      leadText,
    });
    if (signature.titleKey && signature.leadTextHash) {
      documentsCore.writeReaderJsonFile(documentRoot, "metadata.json", {
        ...metadata,
        readerDuplicate: {
          ...(metadata.readerDuplicate || {}),
          ...signature,
          calculatedAt: isoNow(),
        },
      });
    }
    return signature;
  } catch {
    return current;
  }
}

async function assertAuthorizedStandaloneReaderDocument({
  request,
  response,
  readerDocumentId,
  metadata,
}) {
  const access = await getAuthorizedFileBackedResource({
    request,
    response,
    metadata,
    resourceType: "standalone_reader_document",
    resourceId: readerDocumentId,
  });
  if (!access) throw readerDocumentNotFoundError();
  return access;
}

async function readAuthorizedStandaloneReaderMetadata(
  request,
  response,
  documentRoot,
  readerDocumentId,
  endpoint,
  options = {}
) {
  const metadata = documentsCore.readReaderJsonFile(
    documentRoot,
    "metadata.json",
    null,
    {
      readerDocumentId,
      endpoint,
    }
  );
  await assertAuthorizedStandaloneReaderDocument({
    request,
    response,
    readerDocumentId,
    metadata,
  });
  if (!options.allowDeleted) {
    if (documentsCore.readerDocumentIsDeleted(documentRoot, metadata))
      throw readerDocumentNotFoundError();
  }
  return metadata;
}

async function duplicateScanWorkspaces(request, response, uploadWorkspace) {
  const workspaces = [documentsCore.STANDALONE_READER_SCOPE];
  const requestedWorkspaceSlug = String(
    request.body?.workspaceSlug || ""
  ).trim();
  if (requestedWorkspaceSlug && uploadWorkspace?.readerStandalone) {
    try {
      const workspaceSlug = documentsCore.safeSegment(
        requestedWorkspaceSlug,
        "workspace slug"
      );
      const authorizedWorkspace = await getAuthorizedWorkspace({
        request,
        response,
        workspaceSlug,
      });
      if (authorizedWorkspace) workspaces.push(authorizedWorkspace);
    } catch {}
  } else if (!uploadWorkspace?.readerStandalone) {
    workspaces.push(uploadWorkspace);
  }
  return workspaces.filter(
    (workspace, index, list) =>
      workspace &&
      list.findIndex(
        (item) =>
          (item.readerStorageSegment || item.slug) ===
          (workspace.readerStorageSegment || workspace.slug)
      ) === index
  );
}

async function findReaderDuplicateCandidate({
  request,
  response,
  uploadWorkspace,
  originalName,
  leadText,
}) {
  const uploadSignature = duplicateSignatureFor({ originalName, leadText });
  if (!uploadSignature.titleKey || !uploadSignature.leadTextHash) {
    return { duplicate: null, signature: uploadSignature, duplicateIndex: 2 };
  }
  const ignoredIds = ignoredReaderDocumentIdsFromRequest(request);
  let visibleSameTitleCount = 0;
  for (const workspace of await duplicateScanWorkspaces(
    request,
    response,
    uploadWorkspace
  )) {
    const workspaceRoot = documentsCore.readerWorkspaceRoot(workspace);
    if (!fs.existsSync(workspaceRoot)) continue;
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let readerDocumentId = null;
      try {
        readerDocumentId = documentsCore.assertReaderDocumentId(entry.name);
      } catch {
        continue;
      }
      const documentRoot = documentsCore.readerDocumentRoot(
        workspace,
        readerDocumentId
      );
      let metadata = null;
      try {
        metadata = documentsCore.readReaderMetadata(documentRoot, {
          readerDocumentId,
          endpoint: "duplicate-scan",
        });
      } catch {
        continue;
      }
      if (documentsCore.readerDocumentIsDeleted(documentRoot, metadata))
        continue;
      if (ignoredIds.has(readerDocumentId)) {
        console.warn("[ReaderDuplicate] ignored id is not deleted; scanning", {
          readerDocumentId,
        });
      }
      if (workspace.readerStandalone) {
        try {
          await assertAuthorizedStandaloneReaderDocument({
            request,
            response,
            readerDocumentId,
            metadata,
          });
        } catch {
          continue;
        }
      }
      const candidate = duplicateCandidateMetadata(metadata);
      if (candidate.titleKey !== uploadSignature.titleKey) continue;
      visibleSameTitleCount += 1;
      const signature = candidate.leadTextHash
        ? candidate
        : await ensureDuplicateSignatureForCandidate({
            documentRoot,
            metadata,
          });
      if (signature.leadTextHash !== uploadSignature.leadTextHash) continue;
      return {
        duplicate: {
          readerDocumentId,
          title: documentsCore.decodeMaybeMojibakeFilename(
            metadata.originalName
          ),
          createdAt: metadata.createdAt || null,
          workspaceSlug: workspace.readerStandalone ? null : workspace.slug,
        },
        signature: uploadSignature,
        duplicateIndex: Math.max(2, visibleSameTitleCount + 1),
      };
    }
  }
  return {
    duplicate: null,
    signature: uploadSignature,
    duplicateIndex: Math.max(2, visibleSameTitleCount + 1),
  };
}

function shouldQueueThumbnailMaintenance({ workspace, readerDocumentId }) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  if (documentsCore.readerDocumentIsDeleted(documentRoot)) return false;
  if (readerLinks.existingThumbnailUrlForDocument(workspace, readerDocumentId))
    return false;
  const status = postprocessPipeline.readReaderPostprocessStatus(
    documentRoot,
    readerDocumentId
  );
  const task = status.tasks?.thumbnail || null;
  if (["queued", "processing"].includes(task?.status)) return false;
  if (task?.status === "failed") {
    const lastUpdated = new Date(
      task.updatedAt || task.queuedAt || 0
    ).getTime();
    if (
      Number.isFinite(lastUpdated) &&
      Date.now() - lastUpdated < 30 * 60 * 1000
    )
      return false;
  }
  return true;
}

function queueThumbnailMaintenance({
  workspace,
  readerDocumentId,
  reason = "missing-thumbnail",
}) {
  if (!shouldQueueThumbnailMaintenance({ workspace, readerDocumentId })) return;
  console.log("[ReaderThumbnailMaintenance] queued", {
    readerDocumentId,
    workspace: workspace?.slug || workspace?.readerStorageSegment || null,
    reason,
  });
  postprocessPipeline.enqueueReaderPostprocessJob({
    workspace,
    readerDocumentId,
    tasks: ["thumbnail"],
    categories: [],
  });
}

async function listReaderDocumentsForWorkspace({
  request,
  response,
  workspace,
}) {
  const workspaceRoot = documentsCore.readerWorkspaceRoot(workspace);
  if (!fs.existsSync(workspaceRoot)) return [];
  const documents = [];
  const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let readerDocumentId = null;
    try {
      readerDocumentId = documentsCore.assertReaderDocumentId(entry.name);
    } catch {
      continue;
    }
    const documentRoot = documentsCore.readerDocumentRoot(
      workspace,
      readerDocumentId
    );
    let metadata = null;
    try {
      metadata = documentsCore.readReaderMetadata(documentRoot, {
        readerDocumentId,
        endpoint: "list",
      });
      if (documentsCore.readerDocumentIsDeleted(documentRoot, metadata))
        continue;
      if (workspace.readerStandalone) {
        await assertAuthorizedStandaloneReaderDocument({
          request,
          response,
          readerDocumentId,
          metadata,
        });
      }
    } catch {
      continue;
    }
    const pdfManifest = pdfMedia.readOptionalReaderPdfManifest(
      documentRoot,
      readerDocumentId
    );
    pdfMedia.scheduleReaderPdfPreviewBackfillFromList({
      workspace,
      readerDocumentId,
      documentRoot,
      metadata,
      manifest: pdfManifest,
    });
    const enrichedMetadata = pdfManifest
      ? { ...metadata, pdfManifest }
      : metadata;
    queueThumbnailMaintenance({
      workspace,
      readerDocumentId,
      reason: "list",
    });
    documents.push({
      readerDocumentId,
      warning: metadata.previewWarning || null,
      contentSummary: documentsCore.readerContentSummary({
        content: null,
        metadata: enrichedMetadata,
      }),
      metadata: readerLinks.metadataWithOriginalUrl(
        workspace,
        readerDocumentId,
        enrichedMetadata
      ),
      postprocess: postprocessPipeline.readerPostprocessResponse(
        workspace,
        readerDocumentId
      ).postprocess,
    });
  }
  return documents.sort(
    (a, b) =>
      new Date(b.metadata?.createdAt || 0).getTime() -
      new Date(a.metadata?.createdAt || 0).getTime()
  );
}

module.exports = {
  assertAuthorizedStandaloneReaderDocument,
  duplicateSignatureFor,
  extractReaderDuplicateLeadText,
  findReaderDuplicateCandidate,
  listReaderDocumentsForWorkspace,
  queueThumbnailMaintenance,
  readAuthorizedStandaloneReaderMetadata,
  shouldQueueThumbnailMaintenance,
};
