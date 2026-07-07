const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const { validWorkspaceSlug } = require("../../utils/middleware/validWorkspace");
const { getClientContext } = require("../../utils/clientIdentity");
const {
  sensitiveSessionTokenFromRequest,
} = require("../../utils/authz/sensitiveSessions");
const documentsCore = require("./documentsCore");
const httpContentHandlers = require("./httpContentHandlers");
const httpDocumentHandlers = require("./httpDocumentHandlers");
const httpIngestHandlers = require("./httpIngestHandlers");
const httpPostprocessHandlers = require("./httpPostprocessHandlers");
const httpUtilityHandlers = require("./httpUtilityHandlers");
const thumbnailMaintenance = require("./thumbnailMaintenance");

const MAX_READER_FILE_SIZE = 500 * 1024 * 1024;
const STANDALONE_READER_SCOPE = documentsCore.STANDALONE_READER_SCOPE;

function readerTraceLog(stage, detail = {}) {
  console.info("[ReaderTrace]", {
    stage,
    ...detail,
  });
}

function readerAccessTrace(endpoint) {
  return (request, response, next) => {
    const startedAt = Date.now();
    let clientContext = null;
    try {
      clientContext = getClientContext(request);
    } catch {
      clientContext = null;
    }
    response.on("finish", () => {
      readerTraceLog("finish", {
        endpoint,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
        readerDocumentId: request.params?.readerDocumentId || null,
        workspaceSlug: request.params?.slug || null,
        standalone: !request.params?.slug,
        sensitiveHeaderPresent: !!sensitiveSessionTokenFromRequest(request),
        clientIdPresent: !!clientContext?.clientId,
        requestId:
          request?.signedRequest?.requestId ||
          clientContext?.requestId ||
          request?.communicationRequestId ||
          null,
      });
    });
    next();
  };
}

const standaloneReaderScope = (_request, response, next) => {
  response.locals.workspace = STANDALONE_READER_SCOPE;
  next();
};

const standaloneAuth = [
  validatedRequest,
  flexUserRoleValid([ROLES.all]),
  standaloneReaderScope,
];
const workspaceAuth = [
  validatedRequest,
  flexUserRoleValid([ROLES.all]),
  validWorkspaceSlug,
];

function call(handler) {
  return async (request, response) => await handler(request, response);
}

function registerReaderRoutes({
  app,
  basePath,
  auth,
  tracePrefix,
  includeWorkspaceImport = false,
}) {
  app.get(basePath, auth, call(httpUtilityHandlers.listDocuments));
  app.post(`${basePath}/upload`, auth, call(httpIngestHandlers.upload));
  if (includeWorkspaceImport) {
    app.get(
      `${basePath}/from-workspace`,
      auth,
      call(httpIngestHandlers.fromWorkspace)
    );
  }
  app.post(
    `${basePath}/from-local-path`,
    auth,
    call(httpIngestHandlers.fromLocalPath)
  );
  app.post(`${basePath}/classify`, auth, call(httpUtilityHandlers.classify));
  app.get(`${basePath}/ocr-config`, auth, call(httpUtilityHandlers.ocrConfig));
  app.post(
    `${basePath}/ocr-screenshot`,
    auth,
    call(httpUtilityHandlers.ocrScreenshot)
  );
  app.post(
    `${basePath}/:readerDocumentId/postprocess`,
    auth,
    call(httpPostprocessHandlers.enqueuePostprocess)
  );
  app.get(
    `${basePath}/:readerDocumentId/postprocess`,
    auth,
    call(httpPostprocessHandlers.postprocessStatus)
  );
  app.post(
    `${basePath}/:readerDocumentId/reopen-local-path`,
    auth,
    call(httpPostprocessHandlers.reopenLocalPath)
  );
  app.get(
    `${basePath}/:readerDocumentId/preview.pdf`,
    [readerAccessTrace(`${tracePrefix}.preview.pdf`), ...auth],
    call(httpContentHandlers.previewPdf)
  );
  app.get(
    `${basePath}/:readerDocumentId/thumbnail.jpg`,
    [readerAccessTrace(`${tracePrefix}.thumbnail`), ...auth],
    call(httpContentHandlers.thumbnail)
  );
  app.get(
    `${basePath}/:readerDocumentId/page-preview`,
    [readerAccessTrace(`${tracePrefix}.page-preview`), ...auth],
    call(httpContentHandlers.pagePreview)
  );
  app.get(
    `${basePath}/:readerDocumentId/original`,
    [readerAccessTrace(`${tracePrefix}.original`), ...auth],
    call(httpContentHandlers.original)
  );
  app.get(
    `${basePath}/:readerDocumentId`,
    [readerAccessTrace(`${tracePrefix}.metadata`), ...auth],
    call(httpDocumentHandlers.metadataGet)
  );
  app.delete(
    `${basePath}/:readerDocumentId`,
    auth,
    call(httpDocumentHandlers.deleteDocument)
  );
}

function workspaceReaderDocumentsEndpoints(app) {
  if (!app) return;
  thumbnailMaintenance.startReaderThumbnailMaintenancePatrol();

  registerReaderRoutes({
    app,
    basePath: "/reader-documents",
    auth: standaloneAuth,
    tracePrefix: "standalone",
  });
  registerReaderRoutes({
    app,
    basePath: "/workspace/:slug/reader-documents",
    auth: workspaceAuth,
    tracePrefix: "workspace",
    includeWorkspaceImport: true,
  });
}

module.exports = {
  MAX_READER_FILE_SIZE,
  readerAccessTrace,
  workspaceReaderDocumentsEndpoints,
};
