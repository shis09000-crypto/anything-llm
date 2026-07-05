const fs = require("fs");
const { getAuthorizedWorkspace } = require("../authz/resourceAccess");
const { publishBroadcastEvent } = require("../broadcast");
const {
  _private: reader,
} = require("../../endpoints/workspaceReaderDocuments");
const { UserStatePreference } = require("../../models/userStatePreference");
const { broadcastCenter } = require("../broadcast");
const {
  redactDeveloperObject,
  safeReaderMetadataSummary,
} = require("./redactor");
const { appendLog } = require("./logCollector");

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

function apiNamespace(workspace) {
  return workspace?.readerStandalone
    ? "standalone"
    : `workspace:${workspace?.slug || "unknown"}`;
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

function accessDescriptorSummary(workspace, readerDocumentId, metadata = {}) {
  const canonical = reader.metadataWithOriginalUrl(
    workspace,
    readerDocumentId,
    metadata
  );
  return {
    readerDocumentId,
    workspaceSlug: workspace?.readerStandalone ? null : workspace?.slug || null,
    apiNamespace: apiNamespace(workspace),
    ownerScope: workspace?.readerStandalone
      ? "standalone:reader"
      : `workspace:${workspace?.slug}:reader`,
    hasOriginalUrl: !!canonical.originalUrl,
    hasThumbnailUrl: !!canonical.thumbnailUrl,
    hasPagePreviewUrl: !!canonical.pagePreviewUrl,
    hasPreviewPdfUrl: !!canonical.previewPdfUrl,
    streamType: canonical.stream?.type || null,
    streamUrlPresent: !!canonical.stream?.url,
    sensitiveSessionRequired: true,
  };
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
      return {
        readerDocumentId: resolved.readerDocumentId,
        workspaceSlug: resolved.workspace?.readerStandalone
          ? null
          : resolved.workspace?.slug || null,
        deleted: reader.readerDocumentIsDeleted(
          resolved.documentRoot,
          resolved.metadata
        ),
        metadata: safeReaderMetadataSummary(resolved.metadata),
        access: accessDescriptorSummary(
          resolved.workspace,
          resolved.readerDocumentId,
          resolved.metadata
        ),
        postprocess: postprocessSummary(
          resolved.workspace,
          resolved.readerDocumentId
        ),
      };
    }
    case "reader.postprocess.status":
    case "reader.thumbnail.status":
    case "reader.classification.status": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
        allowDeleted: true,
      });
      return postprocessSummary(resolved.workspace, resolved.readerDocumentId);
    }
    case "reader.postprocess.retry":
    case "reader.postprocess.restart": {
      const resolved = await resolveReaderDocument({
        request,
        response,
        scope,
      });
      const status = reader.enqueueReaderPostprocessJob({
        workspace: resolved.workspace,
        readerDocumentId: resolved.readerDocumentId,
        tasks: params.tasks,
        categories: params.categories,
        force: true,
        userId: context.userId || null,
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
          reader.enqueueReaderPostprocessJob({
            workspace: resolved.workspace,
            readerDocumentId: resolved.readerDocumentId,
            tasks: ["thumbnail"],
            force: true,
            userId: context.userId || null,
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
          reader.enqueueReaderPostprocessJob({
            workspace: resolved.workspace,
            readerDocumentId: resolved.readerDocumentId,
            tasks: ["classification"],
            categories: params.categories,
            force: true,
            userId: context.userId || null,
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
    case "reader.memory.get": {
      const states = await UserStatePreference.where({
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
    "reader.logs.query",
    "reader.library.reconcile",
    "reader.library.refresh",
    "reader.library.normalizeLinks",
    "reader.library.hideMissing",
    "reader.document.prepareOpen",
    "reader.document.resolveAccess",
    "reader.memory.get",
    "reader.memory.setPage",
    "reader.memory.clear",
    "reader.postprocess.status",
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
