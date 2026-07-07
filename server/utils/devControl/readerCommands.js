const fs = require("fs");
const { getAuthorizedWorkspace } = require("../authz/resourceAccess");
const { publishBroadcastEvent } = require("../broadcast");
const { ReaderRuntime } = require("../../modules/reader");
const {
  ReaderDocumentStorageProvider,
} = require("../../providers/readerDocumentStorageProvider");
const { DataAccessCenter } = require("../dataAccess");
const { broadcastCenter } = require("../broadcast");
const {
  redactDeveloperObject,
  safeReaderMetadataSummary,
} = require("./redactor");
const { appendLog } = require("./logCollector");
const {
  issueReaderDebugAccessGrant,
  normalizeReaderDebugAccessEndpoints,
  readerDebugAccessGrantSnapshot,
  revokeReaderDebugAccessGrant,
} = require("./readerDebugAccess");

const reader = {
  ...ReaderRuntime.documents,
  ...ReaderRuntime.access,
  ...ReaderRuntime.preview,
  ...ReaderRuntime.postprocess,
  ...ReaderRuntime.media,
  ...ReaderRuntime.classification,
  ...ReaderRuntime.ocr,
  ...ReaderRuntime.epub,
};

function currentUserId(response) {
  return Number(response?.locals?.user?.id || 0) || null;
}

function normalizeScope(scope = {}) {
  return {
    workspaceSlug: scope.workspaceSlug || null,
    readerDocumentId: scope.readerDocumentId || null,
    clientId: scope.clientId || null,
  };
}

async function resolveWorkspace({ request, response, scope = {} } = {}) {
  if (scope.workspaceSlug) {
    const workspace = await getAuthorizedWorkspace({
      request,
      response,
      workspaceSlug: scope.workspaceSlug,
    });
    if (!workspace) {
      const error = new Error("Reader workspace not found or not authorized.");
      error.status = 404;
      error.code = "reader_workspace_not_found";
      throw error;
    }
    return workspace;
  }
  return reader.STANDALONE_READER_SCOPE;
}

async function resolveReaderDocument({
  request,
  response,
  scope = {},
  allowDeleted = false,
} = {}) {
  const readerDocumentId = reader.assertReaderDocumentId(
    scope.readerDocumentId
  );
  const workspace = await resolveWorkspace({ request, response, scope });
  const documentRoot = reader.readerDocumentRoot(workspace, readerDocumentId);
  if (!fs.existsSync(documentRoot)) {
    const error = new Error("Reader document not found.");
    error.status = 404;
    error.code = "reader_document_not_found";
    throw error;
  }
  let metadata = null;
  if (workspace.readerStandalone) {
    metadata = await reader.readAuthorizedStandaloneReaderMetadata(
      request,
      response,
      documentRoot,
      readerDocumentId,
      "dev-control",
      { allowDeleted }
    );
  } else {
    metadata = reader.readReaderMetadata(documentRoot, {
      readerDocumentId,
      endpoint: "dev-control",
    });
    if (
      !allowDeleted &&
      reader.readerDocumentIsDeleted(documentRoot, metadata)
    ) {
      const error = new Error("Reader document is deleted or unavailable.");
      error.status = 404;
      error.code = "reader_document_deleted";
      throw error;
    }
  }
  return { workspace, readerDocumentId, documentRoot, metadata };
}

function postprocessSummary(workspace, readerDocumentId) {
  return redactDeveloperObject(
    reader.readerPostprocessResponse(workspace, readerDocumentId)
  );
}

function previewSummary(workspace, readerDocumentId, metadata = {}) {
  const canonical = reader.metadataWithOriginalUrl(
    workspace,
    readerDocumentId,
    metadata
  );
  return {
    readerDocumentId,
    workspaceSlug: workspace?.readerStandalone ? null : workspace?.slug || null,
    documentType: metadata.documentType || canonical.documentType || null,
    needsPreview: reader.metadataNeedsPdfPreview(metadata),
    hasPreviewPdf: !!canonical.previewPdfUrl,
    previewStatus: canonical.previewStatus || metadata.previewStatus || null,
    previewSource: metadata.previewSource || null,
    previewEngineVersion: metadata.previewEngineVersion || null,
    previewAttemptedAt: metadata.previewAttemptedAt || null,
    previewAttemptCount: metadata.previewAttemptCount || 0,
    previewGeneratedAt: metadata.previewGeneratedAt || null,
    previewLastError:
      metadata.previewLastError || metadata.previewWarning || null,
    postprocess: postprocessSummary(workspace, readerDocumentId),
  };
}

function workspaceSlugForDebugGrant(workspace) {
  return workspace?.readerStandalone ? null : workspace?.slug || null;
}

async function listAllReaderDocuments({
  request,
  response,
  workspaceSlug = null,
} = {}) {
  const globalDocuments = await reader.listReaderDocumentsForWorkspace({
    request,
    response,
    workspace: reader.STANDALONE_READER_SCOPE,
  });
  let workspaceDocuments = [];
  let workspace = null;
  if (workspaceSlug) {
    workspace = await resolveWorkspace({
      request,
      response,
      scope: { workspaceSlug },
    });
    workspaceDocuments = await reader.listReaderDocumentsForWorkspace({
      request,
      response,
      workspace,
    });
  }
  return { globalDocuments, workspaceDocuments, workspace };
}

function summarizeDocuments(documents = []) {
  return documents.map((document) => ({
    readerDocumentId: document.readerDocumentId,
    metadata: safeReaderMetadataSummary(document.metadata),
    postprocess: redactDeveloperObject(document.postprocess || {}),
  }));
}

function publishUiCommand({ context, command, params = {}, scope = {} }) {
  const clientId = scope.clientId || context.clientId;
  const event = publishBroadcastEvent(
    {
      namespace: "developerControl",
      type: "readerCommand",
      eventPriority: "critical",
      visibility: "client",
      scope: { userId: context.userId, clientId },
      sourceClientId: context.clientId,
      sourceRequestId: context.requestId,
      resource: {
        kind: "developer-control-reader-command",
        id: context.commandId,
      },
      payload: {
        center: "developer-control",
        command,
        commandId: context.commandId,
        requestId: context.requestId,
        scope: normalizeScope(scope),
        params: redactDeveloperObject(params),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
    { coalesce: false }
  );
  return {
    deliveredEventId: event?.eventId || null,
    clientId,
    connections: broadcastCenter.snapshot().connections,
  };
}

async function readerCommand(
  command,
  { request, response, scope = {}, params = {}, context }
) {
  switch (command) {
    case "reader.snapshot": {
      const { globalDocuments, workspaceDocuments } =
        await listAllReaderDocuments({
          request,
          response,
          workspaceSlug: scope.workspaceSlug || null,
        });
      return {
        globalCount: globalDocuments.length,
        workspaceCount: workspaceDocuments.length,
        documents: {
          global: summarizeDocuments(globalDocuments),
          workspace: summarizeDocuments(workspaceDocuments),
        },
        broadcast: broadcastCenter.snapshot(),
      };
    }
    case "reader.document.status":
    case "reader.document.metadata":
    case "reader.document.prepareOpen":
    case "reader.document.resolveAccess": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: command === "reader.document.status",
      });
      const storageStatus = ReaderDocumentStorageProvider.status({
        workspace: resolved.workspace,
        readerDocumentId: resolved.readerDocumentId,
      });
      return {
        readerDocumentId: resolved.readerDocumentId,
        workspaceSlug: resolved.workspace?.readerStandalone
          ? null
          : resolved.workspace?.slug || null,
        deleted: storageStatus.deleted,
        storage: storageStatus,
        metadata: safeReaderMetadataSummary(resolved.metadata),
        access: ReaderDocumentStorageProvider.canonicalDescriptor({
          workspace: resolved.workspace,
          readerDocumentId: resolved.readerDocumentId,
        }),
        postprocess: postprocessSummary(
          resolved.workspace,
          resolved.readerDocumentId
        ),
      };
    }
    case "reader.postprocess.status":
    case "reader.preview.status":
    case "reader.thumbnail.status":
    case "reader.classification.status": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: true,
      });
      if (command === "reader.preview.status") {
        return redactDeveloperObject({
          engine: reader.readerPreviewEngineStatus(),
          preview: previewSummary(
            resolved.workspace,
            resolved.readerDocumentId,
            resolved.metadata
          ),
        });
      }
      return postprocessSummary(resolved.workspace, resolved.readerDocumentId);
    }
    case "reader.preview.retry": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
      });
      const status = await reader.enqueueReaderPostprocessJob({
        workspace: resolved.workspace,
        readerDocumentId: resolved.readerDocumentId,
        tasks: ["preview"],
        categories: [],
        force: true,
        userId: context.userId || null,
        intent: "manual",
      });
      return redactDeveloperObject({
        queued: true,
        engine: reader.readerPreviewEngineStatus(),
        preview: previewSummary(
          resolved.workspace,
          resolved.readerDocumentId,
          resolved.metadata
        ),
        postprocess: status,
      });
    }
    case "reader.preview.rebuildMissing": {
      const { globalDocuments, workspaceDocuments, workspace } =
        await listAllReaderDocuments({
          request,
          response,
          workspaceSlug: scope.workspaceSlug || null,
        });
      const enqueueMissing = async (documents, targetWorkspace) =>
        Promise.all(
          documents
            .filter((document) => {
              const metadata = document.metadata || {};
              return (
                reader.metadataNeedsPdfPreview(metadata) &&
                !reader.metadataWithOriginalUrl(
                  targetWorkspace,
                  document.readerDocumentId,
                  metadata
                ).previewPdfUrl
              );
            })
            .map(async (document) => ({
              readerDocumentId: document.readerDocumentId,
              postprocess: await reader.enqueueReaderPostprocessJob({
                workspace: targetWorkspace,
                readerDocumentId: document.readerDocumentId,
                tasks: ["preview"],
                categories: [],
                force: true,
                userId: context.userId || null,
                intent: "manual",
              }),
            }))
        );
      const globalQueued = await enqueueMissing(
        globalDocuments,
        reader.STANDALONE_READER_SCOPE
      );
      const workspaceQueued = workspace
        ? await enqueueMissing(workspaceDocuments, workspace)
        : [];
      return redactDeveloperObject({
        queuedCount: globalQueued.length + workspaceQueued.length,
        engine: reader.readerPreviewEngineStatus(),
        queued: {
          global: globalQueued,
          workspace: workspaceQueued,
        },
      });
    }
    case "reader.postprocess.retry":
    case "reader.postprocess.restart": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
      });
      const status = await reader.enqueueReaderPostprocessJob({
        workspace: resolved.workspace,
        readerDocumentId: resolved.readerDocumentId,
        tasks: params.tasks,
        categories: params.categories,
        force: true,
        userId: context.userId || null,
        intent: "manual",
      });
      return {
        queued: true,
        postprocess: redactDeveloperObject(status),
      };
    }
    case "reader.postprocess.cancel": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: true,
      });
      return {
        cancelled: true,
        postprocess: redactDeveloperObject(
          reader.cancelReaderPostprocessJob({
            workspace: resolved.workspace,
            readerDocumentId: resolved.readerDocumentId,
          })
        ),
      };
    }
    case "reader.thumbnail.regenerate": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
      });
      return {
        queued: true,
        postprocess: redactDeveloperObject(
          await reader.enqueueReaderPostprocessJob({
            workspace: resolved.workspace,
            readerDocumentId: resolved.readerDocumentId,
            tasks: ["thumbnail"],
            force: true,
            userId: context.userId || null,
            intent: "manual",
          })
        ),
      };
    }
    case "reader.classification.retry":
    case "reader.classification.force": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
      });
      return {
        queued: true,
        postprocess: redactDeveloperObject(
          await reader.enqueueReaderPostprocessJob({
            workspace: resolved.workspace,
            readerDocumentId: resolved.readerDocumentId,
            tasks: ["classification"],
            categories: params.categories,
            force: true,
            userId: context.userId || null,
            intent: "manual",
          })
        ),
      };
    }
    case "reader.document.markDeleted": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: true,
      });
      const marker = reader.markReaderDocumentDeleted({
        workspace: resolved.workspace,
        readerDocumentId: resolved.readerDocumentId,
        metadata: resolved.metadata,
        request,
      });
      return redactDeveloperObject({ markedDeleted: true, marker });
    }
    case "reader.document.deleteStatus": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: true,
      });
      return {
        deleted: reader.readerDocumentIsDeleted(
          resolved.documentRoot,
          resolved.metadata
        ),
        metadata: safeReaderMetadataSummary(resolved.metadata),
      };
    }
    case "reader.document.restoreVisibility": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: true,
      });
      const metadata = reader.restoreReaderDocumentVisibility({
        workspace: resolved.workspace,
        readerDocumentId: resolved.readerDocumentId,
      });
      return {
        restored: true,
        metadata: safeReaderMetadataSummary(metadata),
      };
    }
    case "reader.library.reconcile":
    case "reader.library.refresh":
    case "reader.library.normalizeLinks":
    case "reader.library.hideMissing": {
      const { globalDocuments, workspaceDocuments } =
        await listAllReaderDocuments({
          request,
          response,
          workspaceSlug: scope.workspaceSlug || null,
        });
      publishBroadcastEvent(
        {
          namespace: "reader",
          type: "document.added",
          eventPriority: "normal",
          visibility: "reader",
          scope: {
            ...(context.userId ? { userId: Number(context.userId) } : {}),
            ...(scope.workspaceSlug
              ? { workspaceSlug: scope.workspaceSlug }
              : {}),
          },
          payload: {
            workspaceSlug: scope.workspaceSlug || null,
            reason: command,
            globalCount: globalDocuments.length,
            workspaceCount: workspaceDocuments.length,
          },
        },
        { coalesce: false }
      );
      return {
        reconciled: true,
        globalCount: globalDocuments.length,
        workspaceCount: workspaceDocuments.length,
        documents: {
          global: summarizeDocuments(globalDocuments),
          workspace: summarizeDocuments(workspaceDocuments),
        },
        ...(command === "reader.library.hideMissing"
          ? {
              uiCommand: publishUiCommand({
                context,
                command,
                params,
                scope,
              }),
            }
          : {}),
      };
    }
    case "reader.library.db.snapshot": {
      return redactDeveloperObject({
        authority: await DataAccessCenter.readerLibrary.snapshot({
          userId: currentUserId(response),
        }),
        library: await DataAccessCenter.readerLibrary.listLibrary({
          userId: currentUserId(response),
          includeHidden: true,
          includeDeleted: true,
        }),
      });
    }
    case "reader.library.db.reconcile": {
      if (params.apply === true) {
        return {
          uiCommand: true,
          ...publishUiCommand({ context, command, params, scope }),
        };
      }
      return redactDeveloperObject({
        dryRun: true,
        authority: await DataAccessCenter.readerLibrary.snapshot({
          userId: currentUserId(response),
        }),
      });
    }
    case "reader.library.db.bootstrap":
    case "reader.library.db.patchItem":
    case "reader.library.db.deleteItem":
    case "reader.library.db.patchCategory":
    case "reader.library.db.deleteCategory": {
      return {
        uiCommand: true,
        ...publishUiCommand({ context, command, params, scope }),
      };
    }
    case "reader.memory.get": {
      const states = await DataAccessCenter.userState.where({
        userId: currentUserId(response),
        namespaces: ["reader.library"],
      });
      return redactDeveloperObject({
        states: states.map((state) => ({
          namespace: state.namespace,
          scope: state.scope,
          updatedAt: state.updatedAt,
          hasValue: !!state.value,
          bookshelfCount: Array.isArray(state.value?.bookshelf)
            ? state.value.bookshelf.length
            : null,
          historyCount: Array.isArray(state.value?.history)
            ? state.value.history.length
            : null,
          bookMemoryCount: state.value?.bookMemory
            ? Object.keys(state.value.bookMemory).length
            : null,
        })),
      });
    }
    case "reader.memory.setPage":
    case "reader.memory.clear":
    case "reader.scope.cancelTasks":
    case "reader.scope.markStale":
    case "reader.cache.invalidate": {
      return {
        uiCommand: true,
        ...publishUiCommand({ context, command, params, scope }),
      };
    }
    case "reader.debug.trace":
    case "reader.logs.query": {
      appendLog({
        level: "info",
        source: "reader",
        message: "Reader debug trace requested.",
        commandId: context.commandId,
        requestId: context.requestId,
        sessionId: context.sessionId,
        clientId: context.clientId,
        scope,
        metadata: { params },
      });
      return {
        trace: true,
        scope: normalizeScope(scope),
      };
    }
    case "reader.debug.grantAccess": {
      const { workspace, readerDocumentId } = await resolveReaderDocument({
        request,
        response,
        scope,
      });
      const endpoints = normalizeReaderDebugAccessEndpoints(params.endpoints);
      const grant = issueReaderDebugAccessGrant({
        request,
        userId: currentUserId(response),
        clientId: context.clientId,
        workspaceSlug: workspaceSlugForDebugGrant(workspace),
        readerDocumentId,
        endpoints,
        ttlMs: params.ttlMs,
        requestId: context.requestId,
        commandId: context.commandId,
      });
      appendLog({
        level: "info",
        source: "reader",
        message: "Reader debug access grant issued.",
        commandId: context.commandId,
        requestId: context.requestId,
        sessionId: context.sessionId,
        clientId: context.clientId,
        scope,
        metadata: {
          readerDocumentId,
          workspaceSlug: workspaceSlugForDebugGrant(workspace),
          endpoints,
          expiresAt: grant.expiresAt,
        },
      });
      return {
        debugGrantId: grant.debugGrantId,
        headerName: grant.headerName,
        expiresAt: grant.expiresAt,
        ttlMs: grant.ttlMs,
        endpoints: grant.endpoints,
        readerDocumentId: grant.readerDocumentId,
        workspaceSlug: grant.workspaceSlug,
      };
    }
    case "reader.debug.revokeAccess": {
      const debugGrantId =
        params.debugGrantId || params.readerDebugGrantId || params.grantId;
      const revoked = revokeReaderDebugAccessGrant({
        debugGrantId,
        userId: currentUserId(response),
        clientId: context.clientId,
      });
      appendLog({
        level: revoked ? "info" : "warn",
        source: "reader",
        message: revoked
          ? "Reader debug access grant revoked."
          : "Reader debug access grant revoke missed.",
        commandId: context.commandId,
        requestId: context.requestId,
        sessionId: context.sessionId,
        clientId: context.clientId,
        scope,
        metadata: { revoked },
      });
      return { revoked };
    }
    case "reader.debug.accessStatus": {
      return redactDeveloperObject({
        grants: readerDebugAccessGrantSnapshot({
          userId: currentUserId(response),
          clientId: context.clientId,
          readerDocumentId: scope.readerDocumentId || null,
          workspaceSlug:
            scope.workspaceSlug === undefined ? undefined : scope.workspaceSlug,
        }),
      });
    }
    default: {
      if (command.startsWith("reader.ui.")) {
        return {
          uiCommand: true,
          ...publishUiCommand({ context, command, params, scope }),
        };
      }
      const error = new Error("Reader command is not implemented.");
      error.code = "reader_command_not_implemented";
      error.status = 404;
      throw error;
    }
  }
}

function registerReaderCommands(registry) {
  [
    "reader.snapshot",
    "reader.document.status",
    "reader.document.metadata",
    "reader.debug.trace",
    "reader.debug.grantAccess",
    "reader.debug.revokeAccess",
    "reader.debug.accessStatus",
    "reader.logs.query",
    "reader.library.reconcile",
    "reader.library.refresh",
    "reader.library.normalizeLinks",
    "reader.library.hideMissing",
    "reader.library.db.snapshot",
    "reader.library.db.reconcile",
    "reader.library.db.bootstrap",
    "reader.library.db.patchItem",
    "reader.library.db.deleteItem",
    "reader.library.db.patchCategory",
    "reader.library.db.deleteCategory",
    "reader.document.prepareOpen",
    "reader.document.resolveAccess",
    "reader.memory.get",
    "reader.memory.setPage",
    "reader.memory.clear",
    "reader.postprocess.status",
    "reader.preview.status",
    "reader.preview.retry",
    "reader.preview.rebuildMissing",
    "reader.postprocess.retry",
    "reader.postprocess.restart",
    "reader.postprocess.cancel",
    "reader.thumbnail.status",
    "reader.thumbnail.regenerate",
    "reader.classification.status",
    "reader.classification.retry",
    "reader.classification.force",
    "reader.document.markDeleted",
    "reader.document.deleteStatus",
    "reader.document.restoreVisibility",
    "reader.scope.cancelTasks",
    "reader.scope.markStale",
    "reader.cache.invalidate",
    "reader.ui.openDrawer",
    "reader.ui.openDocument",
    "reader.ui.jumpToPage",
    "reader.ui.refreshLibrary",
    "reader.ui.snapshot",
  ].forEach((command) =>
    registry.register(command, (context) => readerCommand(command, context))
  );
}

module.exports = {
  registerReaderCommands,
};
