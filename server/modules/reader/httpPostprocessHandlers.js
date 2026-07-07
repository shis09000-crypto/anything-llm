const fs = require("fs");
const { READER_WORKER_INTENTS } = require("../../utils/readerWorker/contract");
const accessGate = require("./accessGate");
const documentCatalog = require("./documentCatalog");
const documentsCore = require("./documentsCore");
const ingestCore = require("./ingestCore");
const postprocessPipeline = require("./postprocessPipeline");
const previewPipeline = require("./previewPipeline");
const readerLinks = require("./readerLinks");

function writeReaderDocumentFiles(
  workspace,
  readerDocumentId,
  content,
  metadata
) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  fs.mkdirSync(documentRoot, { recursive: true });
  documentsCore.writeReaderJsonFile(documentRoot, "content.json", content);
  documentsCore.writeReaderJsonFile(documentRoot, "metadata.json", metadata);
  return documentRoot;
}

async function finalizeReaderDocumentMetadata({
  workspace,
  readerDocumentId,
  metadata,
  originalPath,
  buffer = null,
}) {
  const fingerprint = buffer
    ? ingestCore.fingerprintForBuffer(buffer)
    : ingestCore.fingerprintForBuffer(fs.readFileSync(originalPath));
  return await previewPipeline.ensurePdfPreview({
    workspace,
    readerDocumentId,
    metadata: {
      ...metadata,
      originalFingerprint: fingerprint,
    },
    originalPath,
    fingerprint,
    previewUrlForDocument: readerLinks.previewUrlForDocument,
  });
}

function postprocessIntentFromRequest(request) {
  return request.body?.intent === "manual"
    ? READER_WORKER_INTENTS.MANUAL
    : READER_WORKER_INTENTS.OPEN;
}

function postprocessForceFromRequest(request) {
  return request.body?.force === true || request.body?.intent === "manual";
}

async function metadataForPostprocessEndpoint({
  request,
  response,
  workspace,
  readerDocumentId,
  endpoint,
  allowDeleted = false,
}) {
  const documentRoot = documentsCore.readerDocumentRoot(
    workspace,
    readerDocumentId
  );
  if (workspace.readerStandalone) {
    return await documentCatalog.readAuthorizedStandaloneReaderMetadata(
      request,
      response,
      documentRoot,
      readerDocumentId,
      endpoint,
      { allowDeleted }
    );
  }
  return documentsCore.readReaderJsonFile(documentRoot, "metadata.json", null, {
    readerDocumentId,
    endpoint,
  });
}

async function enqueuePostprocess(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    await metadataForPostprocessEndpoint({
      request,
      response,
      workspace,
      readerDocumentId,
      endpoint: "postprocess.enqueue",
    });
    const status = await postprocessPipeline.enqueueReaderPostprocessJob({
      workspace,
      readerDocumentId,
      tasks: request.body?.tasks,
      categories: request.body?.categories,
      force: postprocessForceFromRequest(request),
      userId: response.locals.user?.id || null,
      intent: postprocessIntentFromRequest(request),
    });
    return response.status(202).json({
      ...postprocessPipeline.readerPostprocessResponse(
        workspace,
        readerDocumentId
      ),
      postprocess: status,
      status: status.status,
    });
  } catch (error) {
    return response
      .status(error.status || 400)
      .json({ success: false, error: error.message });
  }
}

async function postprocessStatus(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    await metadataForPostprocessEndpoint({
      request,
      response,
      workspace,
      readerDocumentId,
      endpoint: "postprocess.status",
    });
    return response
      .status(200)
      .json(
        postprocessPipeline.readerPostprocessResponse(
          workspace,
          readerDocumentId
        )
      );
  } catch (error) {
    return response.status(404).json({ success: false, error: error.message });
  }
}

async function reopenLocalPath(request, response) {
  try {
    const workspace = response.locals.workspace;
    const readerDocumentId = documentsCore.assertReaderDocumentId(
      request.params.readerDocumentId
    );
    const previousMetadata = await metadataForPostprocessEndpoint({
      request,
      response,
      workspace,
      readerDocumentId,
      endpoint: "reopen-local-path",
    });
    if (!previousMetadata.localPath) {
      const error = new Error("Reader document has no local path binding.");
      error.status = 400;
      throw error;
    }

    const { absolutePath, stat } = await documentsCore.validateLocalReaderPath(
      previousMetadata.localPath,
      request.body?.fileAccessContext || {}
    );
    const buffer = fs.readFileSync(absolutePath);
    const { content, metadata } = ingestCore.contentAndMetadataForLocalPath({
      readerDocumentId,
      absolutePath,
      buffer,
      stat,
    });
    const nextMetadata = {
      ...previousMetadata,
      ...metadata,
      reopenedAt: new Date().toISOString(),
    };

    writeReaderDocumentFiles(
      workspace,
      readerDocumentId,
      content,
      nextMetadata
    );
    const finalMetadata = await finalizeReaderDocumentMetadata({
      workspace,
      readerDocumentId,
      metadata: nextMetadata,
      originalPath: absolutePath,
      buffer,
    });
    writeReaderDocumentFiles(
      workspace,
      readerDocumentId,
      content,
      finalMetadata
    );

    return response.status(200).json({
      success: true,
      warning: finalMetadata.previewWarning || null,
      readerDocumentId,
      sensitiveSession: accessGate.readerSensitiveSessionForResponse(
        request,
        response,
        workspace,
        readerDocumentId,
        "reader-local-path-reopen"
      ),
      content,
      metadata: readerLinks.metadataWithOriginalUrl(
        workspace,
        readerDocumentId,
        finalMetadata
      ),
    });
  } catch (error) {
    return response.status(error.status || 400).json({
      success: false,
      error: error.message,
    });
  }
}

module.exports = {
  enqueuePostprocess,
  postprocessStatus,
  reopenLocalPath,
};
