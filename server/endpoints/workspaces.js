const path = require("path");
const fs = require("fs");
const {
  reqBody,
  multiUserMode,
  userFromSession,
  safeJsonParse,
  queryParams,
} = require("../utils/http");
const { normalizePath, isWithin } = require("../utils/files");
const { DataAccessCenter } = require("../utils/dataAccess");
const { getVectorDbClass } = require("../utils/helpers");
const { handleFileUpload, handlePfpUpload } = require("../utils/files/multer");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const {
  flexUserRoleValid,
  ROLES,
} = require("../utils/middleware/multiUserProtected");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const {
  WorkspaceSuggestedMessages,
} = require("../models/workspacesSuggestedMessages");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { convertToChatHistory } = require("../utils/helpers/chat/responses");
const { CollectorApi } = require("../utils/collectorApi");
const {
  determineWorkspacePfpFilepath,
  fetchPfp,
} = require("../utils/files/pfp");
const { getTTSProvider } = require("../utils/TextToSpeech");
const {
  chatIdentifierPayload,
  chatIdentifiersWhere,
  chatIdentityFromRequest,
} = require("../utils/chats/chatIdentifiers");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");

const truncate = require("truncate");
const { purgeWorkspaceDocument } = require("../utils/files/purgeDocument");
const { getModelTag } = require("./utils");
const { searchWorkspaceAndThreads } = require("../utils/helpers/search");
const { workspaceParsedFilesEndpoints } = require("./workspacesParsedFiles");
const {
  workspaceReaderDocumentsEndpoints,
} = require("./workspaceReaderDocuments");
const { safeFileMove } = require("../utils/safety");
const { storagePath: environmentStoragePath } = require("../utils/environment");
const {
  redactSensitiveText,
  redactUrl,
} = require("../utils/security/redaction");
const {
  getClientContext,
  recordClientTrustCheckpoint,
} = require("../utils/clientIdentity");
const {
  publishWorkspaceSyncEvent,
} = require("../utils/chats/workspaceSyncEvents");

const DEFAULT_UPLOAD_FOLDER = "custom-documents";
const documentsPath = environmentStoragePath("documents");
const Workspace = DataAccessCenter.workspace;
const Document = DataAccessCenter.document;
const DocumentVectors = DataAccessCenter.documentVector;
const WorkspaceChats = DataAccessCenter.workspaceChat;
const WorkspaceThread = DataAccessCenter.workspaceThread;
const {
  DocumentVectorConsistencyService,
} = require("../services/documentVectorConsistencyService");

function parseHistoryQuery(request) {
  const query = queryParams(request);
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const beforeChatId = Number(query.beforeChatId) || null;
  const afterChatId = Number(query.afterChatId) || null;
  const anchorChatId = Number(query.anchorChatId) || null;
  const priorityWindow = Math.min(
    Math.max(Number(query.priorityWindow) || 0, 0),
    limit
  );
  return {
    enabled:
      query.limit !== undefined ||
      query.beforeChatId !== undefined ||
      query.afterChatId !== undefined ||
      query.anchorChatId !== undefined ||
      query.detail !== undefined ||
      query.priorityWindow !== undefined,
    limit,
    beforeChatId,
    afterChatId,
    anchorChatId,
    detail: query.detail === "light" ? "light" : "full",
    priorityWindow,
  };
}

const DUAL_THREAD_FORK_MODE = "dual_thread_fork_mode";

function resolveUploadTargetFolder(folderName = DEFAULT_UPLOAD_FOLDER) {
  const rawFolderName =
    typeof folderName === "string" ? folderName.trim() : folderName;
  if (rawFolderName && typeof rawFolderName !== "string") {
    return {
      error: "Invalid folderName. Expected a folder name string.",
    };
  }

  if (
    rawFolderName &&
    (path.isAbsolute(rawFolderName) ||
      rawFolderName.split(/[\\/]+/).includes(".."))
  ) {
    return {
      error: "Invalid folderName. Target folder must be inside documents.",
    };
  }

  let folder;
  try {
    folder = normalizePath(rawFolderName || DEFAULT_UPLOAD_FOLDER);
  } catch {
    return {
      error: "Invalid folderName. Target folder must be inside documents.",
    };
  }
  const targetFolderPath = path.resolve(documentsPath, folder);
  const rootDocumentsPath = path.resolve(documentsPath);

  if (!isWithin(rootDocumentsPath, targetFolderPath)) {
    return {
      error: "Invalid folderName. Target folder must be inside documents.",
    };
  }

  fs.mkdirSync(targetFolderPath, { recursive: true });
  return { folder, targetFolderPath };
}

function uniqueDestinationPath(destinationPath) {
  if (!fs.existsSync(destinationPath)) return destinationPath;
  const ext = path.extname(destinationPath);
  const base = destinationPath.slice(0, destinationPath.length - ext.length);
  for (let index = 1; index < 1_000; index++) {
    const candidate = `${base}-${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Unable to resolve a unique destination for uploaded file.");
}

function moveProcessedDocumentsToFolder(documents = [], target = {}) {
  if (!Array.isArray(documents) || !target?.folder || !target?.targetFolderPath)
    return [];

  const rootDocumentsPath = path.resolve(documentsPath);

  for (const doc of documents) {
    if (!doc?.location) continue;
    const currentFolder = path.dirname(doc.location);
    if (currentFolder === target.folder) continue;

    const sourcePath = path.resolve(documentsPath, normalizePath(doc.location));
    const destinationPath = uniqueDestinationPath(
      path.resolve(target.targetFolderPath, path.basename(doc.location))
    );

    if (
      !isWithin(rootDocumentsPath, sourcePath) ||
      !isWithin(rootDocumentsPath, destinationPath)
    ) {
      throw new Error("Invalid processed document location.");
    }

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Processed document was not found at ${doc.location}.`);
    }

    safeFileMove(sourcePath, destinationPath, { overwrite: false });
    const movedLocation = normalizePath(
      path.join(target.folder, path.basename(destinationPath))
    );
    doc.location = movedLocation;
    doc.name = path.basename(movedLocation);
    if (doc.docpath) doc.docpath = movedLocation;
  }

  return documents;
}

function branchBaseName(sourceThread = null) {
  const sourceName = sourceThread?.name || "Default";
  return String(sourceName)
    .replace(/^分支(?:\s+\d+)?\s*·\s*/u, "")
    .replace(/\s*·\s*分支(?:\s+\d+)?$/u, "")
    .trim();
}

function displayBranchThreadName(name = "") {
  const sourceName = String(name);
  if (/^分支(?:\s+\d+)?\s*·\s*/u.test(sourceName)) return sourceName;
  const suffixMatch = sourceName.match(/\s*·\s*分支(?:\s+(\d+))?$/u);
  if (!suffixMatch) return sourceName;

  const suffix = suffixMatch[1] ? ` ${suffixMatch[1]}` : "";
  const baseName = sourceName.replace(/\s*·\s*分支(?:\s+\d+)?$/u, "").trim();
  return `分支${suffix} · ${baseName}`;
}

async function uniqueBranchThreadName({ workspace, user, sourceThread }) {
  const baseName = branchBaseName(sourceThread);
  const branchName = `分支 · ${baseName}`;
  const threads = await WorkspaceThread.where({
    workspace_id: workspace.id,
    user_id: user?.id || null,
  });
  const existingNames = new Set(
    threads.flatMap((thread) => [
      thread.name,
      displayBranchThreadName(thread.name),
    ])
  );
  if (!existingNames.has(branchName)) return branchName;

  let suffix = 2;
  while (existingNames.has(`${branchName} ${suffix}`)) suffix += 1;
  return `${branchName} ${suffix}`;
}

function lightChatIdsForHistory(history = [], options = {}) {
  if (!options.enabled || options.detail !== "light") return new Set();
  const fullStart = Math.max(history.length - options.priorityWindow, 0);
  return new Set(
    history
      .filter((record, index) => index < fullStart)
      .map((record) => record.id)
  );
}

async function historyPageMeta(baseClause = {}, history = [], options = {}) {
  const oldestId = history[0]?.id || null;
  const newestId = history[history.length - 1]?.id || null;
  const hasMore =
    !!oldestId &&
    (history.length >= options.limit
      ? (await WorkspaceChats.count({
          ...baseClause,
          id: { lt: oldestId },
        })) > 0
      : false);
  const hasNewer =
    !!newestId &&
    !!options.afterChatId &&
    history.length >= options.limit &&
    (await WorkspaceChats.count({
      ...baseClause,
      id: { gt: newestId },
    })) > 0;
  return {
    limit: options.limit,
    beforeChatId: options.beforeChatId,
    afterChatId: options.afterChatId,
    anchorChatId: options.anchorChatId,
    nextBeforeChatId: oldestId,
    olderBeforeChatId: oldestId,
    nextAfterChatId: newestId,
    newerAfterChatId: newestId,
    totalReturned: history.length,
    hasMore,
    hasOlder: hasMore,
    hasNewer,
  };
}

function anchorWindowLimits(limit = 20) {
  const remaining = Math.max(limit - 1, 0);
  const beforeLimit = Math.floor(remaining / 2);
  return {
    beforeLimit,
    afterLimit: remaining - beforeLimit,
  };
}

async function anchoredChatHistory(baseClause = {}, options = {}) {
  const anchorChatId = options.anchorChatId;
  const [anchor] = await WorkspaceChats.where(
    { ...baseClause, id: anchorChatId },
    1,
    { id: "asc" }
  );
  if (!anchor) {
    return {
      history: [],
      page: {
        limit: options.limit,
        beforeChatId: null,
        afterChatId: null,
        anchorChatId,
        anchorFound: false,
        nextBeforeChatId: null,
        olderBeforeChatId: null,
        nextAfterChatId: null,
        newerAfterChatId: null,
        totalReturned: 0,
        hasMore: false,
        hasOlder: false,
        hasNewer: false,
      },
    };
  }

  const { beforeLimit, afterLimit } = anchorWindowLimits(options.limit);
  const olderDesc = beforeLimit
    ? await WorkspaceChats.where(
        { ...baseClause, id: { lt: anchorChatId } },
        beforeLimit,
        { id: "desc" }
      )
    : [];
  const newerAsc = afterLimit
    ? await WorkspaceChats.where(
        { ...baseClause, id: { gt: anchorChatId } },
        afterLimit,
        { id: "asc" }
      )
    : [];
  const history = [...olderDesc].reverse().concat(anchor, newerAsc);
  const oldestId = history[0]?.id || null;
  const newestId = history[history.length - 1]?.id || null;
  const hasOlder =
    !!oldestId &&
    (await WorkspaceChats.count({
      ...baseClause,
      id: { lt: oldestId },
    })) > 0;
  const hasNewer =
    !!newestId &&
    (await WorkspaceChats.count({
      ...baseClause,
      id: { gt: newestId },
    })) > 0;

  return {
    history,
    page: {
      limit: options.limit,
      beforeChatId: null,
      afterChatId: null,
      anchorChatId,
      anchorFound: true,
      nextBeforeChatId: oldestId,
      olderBeforeChatId: oldestId,
      nextAfterChatId: newestId,
      newerAfterChatId: newestId,
      totalReturned: history.length,
      hasMore: hasOlder,
      hasOlder,
      hasNewer,
    },
  };
}

async function pagedChatHistory(
  baseClause = {},
  whereClause = {},
  options = {}
) {
  const orderBy = options.afterChatId
    ? { id: "asc" }
    : options.enabled
      ? { id: "desc" }
      : { id: "asc" };
  if (
    options.enabled &&
    options.detail === "light" &&
    options.priorityWindow < options.limit
  ) {
    const history = await WorkspaceChats.whereMetadata(
      whereClause,
      options.limit,
      orderBy
    );
    const orderedHistory = options.afterChatId
      ? history
      : [...history].reverse();
    const lightChatIds = lightChatIdsForHistory(orderedHistory, options);
    const fullChatIds = orderedHistory
      .filter((chat) => !lightChatIds.has(chat.id))
      .map((chat) => chat.id);

    const fullHistory = fullChatIds.length
      ? await WorkspaceChats.where(
          { ...baseClause, id: { in: fullChatIds } },
          null,
          { id: "asc" }
        )
      : [];
    const fullHistoryById = new Map(fullHistory.map((chat) => [chat.id, chat]));
    return orderedHistory.map((chat) => fullHistoryById.get(chat.id) || chat);
  }

  const history = await WorkspaceChats.where(
    whereClause,
    options.enabled ? options.limit : null,
    orderBy
  );
  return options.enabled && !options.afterChatId
    ? [...history].reverse()
    : history;
}

function workspaceEndpoints(app) {
  if (!app) return;
  const responseCache = new Map();

  app.post(
    "/workspace/new",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { name = null } = reqBody(request);
        const { workspace, message } = await Workspace.new(name, user?.id);
        const defaultThreads = workspace
          ? await WorkspaceThread.ensureDefaultThreads(workspace, user?.id)
          : null;
        await Telemetry.sendTelemetry(
          "workspace_created",
          {
            multiUserMode: multiUserMode(response),
            LLMSelection: process.env.LLM_PROVIDER || "openai",
            Embedder: process.env.EMBEDDING_ENGINE || "inherit",
            VectorDbSelection: process.env.VECTOR_DB || "lancedb",
            TTSSelection: process.env.TTS_PROVIDER || "native",
            LLMModel: getModelTag(),
          },
          user?.id
        );

        await EventLogs.logEvent(
          "workspace_created",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          user?.id
        );
        if (workspace) {
          const clientContext = getClientContext(request, { user });
          publishWorkspaceSyncEvent({
            type: "workspace_created",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            senderClientId: clientContext.clientId,
          });
        }
        response.status(200).json({ workspace, message, defaultThreads });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/update",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slug = null } = request.params;
        const data = reqBody(request);
        const currWorkspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        await Workspace.trackChange(currWorkspace, data, user);
        const { workspace, message } = await Workspace.update(
          currWorkspace.id,
          data
        );
        if (workspace) {
          const clientContext = getClientContext(request, { user });
          publishWorkspaceSyncEvent({
            type: "workspace_updated",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            senderClientId: clientContext.clientId,
          });
        }
        response.status(200).json({ workspace, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/upload",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async function (request, response) {
      try {
        const Collector = new CollectorApi();
        const { originalname } = request.file;
        const uploadTarget = resolveUploadTargetFolder(
          request.body?.folderName
        );
        if (uploadTarget.error) {
          if (request.file?.path && fs.existsSync(request.file.path))
            fs.rmSync(request.file.path);
          return response
            .status(400)
            .json({ success: false, error: uploadTarget.error })
            .end();
        }

        const processingOnline = await Collector.online();

        if (!processingOnline) {
          response
            .status(500)
            .json({
              success: false,
              error: `Document processing API is not online. Document ${originalname} will not be processed automatically.`,
            })
            .end();
          return;
        }

        const { success, reason, documents } =
          await Collector.processDocument(originalname);
        if (!success) {
          response
            .status(500)
            .json({ success: false, error: reason, documents })
            .end();
          return;
        }
        const movedDocuments = moveProcessedDocumentsToFolder(
          documents,
          uploadTarget
        );

        Collector.log(
          `Document ${originalname} uploaded processed and successfully. It is now available in ${uploadTarget.folder}.`
        );
        await Telemetry.sendTelemetry("document_uploaded");
        await EventLogs.logEvent(
          "document_uploaded",
          {
            documentName: originalname,
            folder: uploadTarget.folder,
          },
          response.locals?.user?.id
        );
        response
          .status(200)
          .json({ success: true, error: null, documents: movedDocuments });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/upload-link",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      let link = "";
      try {
        const Collector = new CollectorApi();
        const body = reqBody(request);
        link = body?.link || "";
        const { folderName = DEFAULT_UPLOAD_FOLDER } = body || {};
        const redactedLink = redactUrl(link);
        const uploadTarget = resolveUploadTargetFolder(folderName);
        if (uploadTarget.error) {
          return response
            .status(400)
            .json({ success: false, error: uploadTarget.error })
            .end();
        }

        const processingOnline = await Collector.online();

        if (!processingOnline) {
          response
            .status(500)
            .json({
              success: false,
              error:
                "Document processing API is not online. Link will not be processed automatically.",
            })
            .end();
          return;
        }

        const { success, reason, documents } =
          await Collector.processLink(link);
        if (!success) {
          response
            .status(500)
            .json({
              success: false,
              error: redactSensitiveText(reason || "Link upload failed.", [
                link,
              ]),
              documents,
            })
            .end();
          return;
        }
        const movedDocuments = moveProcessedDocumentsToFolder(
          documents,
          uploadTarget
        );

        Collector.log(
          `Link ${redactedLink} uploaded processed and successfully. It is now available in ${uploadTarget.folder}.`
        );
        await Telemetry.sendTelemetry("link_uploaded");
        await EventLogs.logEvent(
          "link_uploaded",
          { link: redactedLink, folder: uploadTarget.folder },
          response.locals?.user?.id
        );
        response
          .status(200)
          .json({ success: true, error: null, documents: movedDocuments });
      } catch (e) {
        console.error("Link upload failed", {
          message: redactSensitiveText(e.message, [link]),
        });
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/update-embeddings",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slug = null } = request.params;
        const { adds = [], deletes = [] } = reqBody(request);
        const currWorkspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        await Document.removeDocuments(
          currWorkspace,
          deletes,
          response.locals?.user?.id
        );

        const {
          isNativeEmbedder,
          embedFiles,
        } = require("../utils/EmbeddingWorkerManager");
        const { isBatchMode } = require("../utils/DocumentEmbeddingBatch");

        if (!isBatchMode() && isNativeEmbedder() && adds.length > 0) {
          await embedFiles(
            currWorkspace.slug,
            adds,
            currWorkspace.id,
            response.locals?.user?.id ?? null
          );
          const updatedWorkspace = await Workspace.get({
            id: currWorkspace.id,
          });
          response
            .status(200)
            .json({ workspace: updatedWorkspace, message: null });
          return;
        }

        const {
          failedToEmbed = [],
          errors = [],
          batchJob = null,
        } = await Document.addDocuments(
          currWorkspace,
          adds,
          response.locals?.user?.id
        );
        const updatedWorkspace = await Workspace.get({ id: currWorkspace.id });
        response.status(200).json({
          workspace: updatedWorkspace,
          batchJob: batchJob || null,
          message:
            failedToEmbed.length > 0
              ? `${failedToEmbed.length} documents failed to add.\n\n${errors
                  .map((msg) => `${msg}`)
                  .join("\n\n")}`
              : null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/robustness-diagnostics",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slug = null } = request.params;
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });
        if (!workspace)
          return response
            .status(404)
            .json({ success: false, error: "Workspace not found." });

        const diagnostics =
          await DocumentVectorConsistencyService.workspaceRobustnessDiagnostics(
            workspace
          );
        return response.status(200).json({
          ...diagnostics,
          repairPlan:
            DocumentVectorConsistencyService.buildRepairPlan(diagnostics),
        });
      } catch (error) {
        console.error("[RobustnessDiagnostics]", error.message, error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.delete(
    "/workspace/:slug",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { slug = "" } = request.params;
        const user = await userFromSession(request, response);
        const VectorDb = getVectorDbClass();
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        void recordClientTrustCheckpoint(request, {
          action: "workspace_delete",
          resourceType: "workspace",
          resourceId: workspace.id,
          outcome: "received",
        });
        await WorkspaceChats.delete({ workspaceId: Number(workspace.id) });
        await DocumentVectors.deleteForWorkspace(workspace.id);
        await Document.delete({ workspaceId: Number(workspace.id) });
        await Workspace.delete({ id: Number(workspace.id) });

        await EventLogs.logEvent(
          "workspace_deleted",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          response.locals?.user?.id
        );

        try {
          await VectorDb["delete-namespace"]({ namespace: slug });
        } catch (e) {
          console.error(e.message);
        }
        const clientContext = getClientContext(request, { user });
        publishWorkspaceSyncEvent({
          type: "workspace_deleted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          senderClientId: clientContext.clientId,
        });
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/reset-vector-db",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { slug = "" } = request.params;
        const user = await userFromSession(request, response);
        const VectorDb = getVectorDbClass();
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        await DocumentVectors.deleteForWorkspace(workspace.id);
        await Document.delete({ workspaceId: Number(workspace.id) });

        await EventLogs.logEvent(
          "workspace_vectors_reset",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          response.locals?.user?.id
        );

        try {
          await VectorDb["delete-namespace"]({ namespace: slug });
        } catch (e) {
          console.error(e.message);
        }
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspaces",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspaces = multiUserMode(response)
          ? await Workspace.whereWithUser(user)
          : await Workspace.where();

        response.status(200).json({ workspaces });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slug } = request.params;
        const user = await userFromSession(request, response);
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        response.status(200).json({ workspace });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/chats",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slug } = request.params;
        const user = await userFromSession(request, response);
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const historyOptions = parseHistoryQuery(request);
        const baseClause = {
          workspaceId: workspace.id,
          thread_id: null,
          api_session_id: null,
          include: true,
          ...(multiUserMode(response) ? { user_id: user.id } : {}),
        };
        const whereClause = {
          ...baseClause,
          ...(historyOptions.beforeChatId
            ? { id: { lt: historyOptions.beforeChatId } }
            : {}),
          ...(historyOptions.afterChatId
            ? { id: { gt: historyOptions.afterChatId } }
            : {}),
        };
        const anchoredHistory =
          historyOptions.enabled && historyOptions.anchorChatId
            ? await anchoredChatHistory(baseClause, historyOptions)
            : null;
        const orderedHistory = historyOptions.enabled
          ? anchoredHistory
            ? anchoredHistory.history
            : await pagedChatHistory(baseClause, whereClause, historyOptions)
          : multiUserMode(response)
            ? await WorkspaceChats.forWorkspaceByUser(workspace.id, user.id)
            : await WorkspaceChats.forWorkspace(workspace.id);
        const lightChatIds = lightChatIdsForHistory(
          orderedHistory,
          historyOptions
        );
        const page = historyOptions.enabled
          ? anchoredHistory?.page ||
            (await historyPageMeta(baseClause, orderedHistory, historyOptions))
          : null;
        response.status(200).json({
          history: convertToChatHistory(orderedHistory, { lightChatIds }),
          ...(page
            ? { page: { ...page, lightChatIds: [...lightChatIds] } }
            : {}),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/bootstrap",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slug } = request.params;
        const user = await userFromSession(request, response);
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const historyOptions = {
          ...parseHistoryQuery(request),
          enabled: true,
        };
        const baseClause = {
          workspaceId: workspace.id,
          thread_id: null,
          api_session_id: null,
          include: true,
          ...(multiUserMode(response) ? { user_id: user.id } : {}),
        };
        const whereClause = {
          ...baseClause,
          ...(historyOptions.beforeChatId
            ? { id: { lt: historyOptions.beforeChatId } }
            : {}),
          ...(historyOptions.afterChatId
            ? { id: { gt: historyOptions.afterChatId } }
            : {}),
        };
        const anchoredHistory = historyOptions.anchorChatId
          ? await anchoredChatHistory(baseClause, historyOptions)
          : null;
        const orderedHistory = anchoredHistory
          ? anchoredHistory.history
          : await pagedChatHistory(baseClause, whereClause, historyOptions);
        const lightChatIds = lightChatIdsForHistory(
          orderedHistory,
          historyOptions
        );
        const page =
          anchoredHistory?.page ||
          (await historyPageMeta(baseClause, orderedHistory, historyOptions));

        response.status(200).json({
          success: true,
          workspace: {
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
          },
          thread: null,
          history: convertToChatHistory(orderedHistory, { lightChatIds }),
          page: { ...page, lightChatIds: [...lightChatIds] },
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/chats/hydrate",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { slug } = request.params;
        const { chatIds = [], publicChatIds = [] } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!workspace || !Array.isArray(chatIds)) {
          response.sendStatus(400).end();
          return;
        }

        const identifierWhere = chatIdentifiersWhere(
          chatIdentifierPayload({ chatIds, publicChatIds })
        );
        if (!identifierWhere) {
          response.status(200).json({
            history: [],
            hydratedChatIds: [],
            hydratedPublicChatIds: [],
          });
          return;
        }

        const history = await WorkspaceChats.where(
          {
            workspaceId: workspace.id,
            thread_id: null,
            api_session_id: null,
            include: true,
            ...identifierWhere,
            ...(multiUserMode(response) ? { user_id: user.id } : {}),
          },
          null,
          { id: "asc" }
        );
        response.status(200).json({
          history: convertToChatHistory(history),
          hydratedChatIds: history.map((chat) => chat.id),
          hydratedPublicChatIds: history
            .map((chat) => chat.public_id)
            .filter(Boolean),
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/delete-chats",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { chatIds = [], publicChatIds = [] } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;

        if (!workspace || !Array.isArray(chatIds)) {
          response.sendStatus(400).end();
          return;
        }

        // This works for both workspace and threads.
        // we simplify this by just looking at workspace<>user overlap
        // since they are all on the same table.
        const identifierWhere = chatIdentifiersWhere(
          chatIdentifierPayload({ chatIds, publicChatIds })
        );
        if (!identifierWhere) {
          response.status(200).end();
          return;
        }

        await WorkspaceChats.delete({
          ...identifierWhere,
          user_id: user?.id ?? null,
          workspaceId: workspace.id,
        });

        const clientContext = getClientContext(request, { user });
        publishWorkspaceSyncEvent({
          type: "chat_deleted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: null,
          threadSlug: null,
          senderClientId: clientContext.clientId,
        });

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/delete-edited-chats",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { startingId } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;

        await WorkspaceChats.delete({
          workspaceId: workspace.id,
          thread_id: null,
          user_id: user?.id,
          id: { gte: Number(startingId) },
        });

        const clientContext = getClientContext(request, { user });
        publishWorkspaceSyncEvent({
          type: "chat_deleted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: null,
          threadSlug: null,
          senderClientId: clientContext.clientId,
        });

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/update-chat",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const {
          chatId,
          publicChatId = null,
          newText = null,
          role = "assistant",
        } = reqBody(request);
        if (!newText || !String(newText).trim())
          throw new Error("Cannot save empty edit");

        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const identifierWhere = chatIdentityFromRequest({
          chatId,
          publicChatId,
        });
        if (!identifierWhere) throw new Error("Invalid chat.");
        const existingChat = await WorkspaceChats.get({
          workspaceId: workspace.id,
          thread_id: null,
          user_id: user?.id,
          ...identifierWhere,
        });
        if (!existingChat) throw new Error("Invalid chat.");

        if (role === "user") {
          await WorkspaceChats._update(existingChat.id, {
            prompt: String(newText),
          });
        } else {
          const chatResponse = safeJsonParse(existingChat.response, null);
          if (!chatResponse) throw new Error("Failed to parse chat response");
          await WorkspaceChats._update(existingChat.id, {
            response: JSON.stringify({
              ...chatResponse,
              text: String(newText),
            }),
          });
        }

        const clientContext = getClientContext(request, { user });
        publishWorkspaceSyncEvent({
          type: "chat_updated",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: null,
          threadSlug: null,
          chatId: existingChat.id,
          publicChatId: existingChat.public_id || null,
          senderClientId: clientContext.clientId,
        });

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/chat-feedback/:chatId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { chatId } = request.params;
        const { feedback = null } = reqBody(request);
        const user = await userFromSession(request, response);
        const identifierWhere = chatIdentityFromRequest({ chatId });
        if (!identifierWhere)
          return response.status(404).json({ success: false });
        const existingChat = await WorkspaceChats.get({
          ...identifierWhere,
          workspaceId: response.locals.workspace.id,
          user_id: user?.id,
        });

        if (!existingChat) return response.status(404).json({ success: false });
        await WorkspaceChats.updateFeedbackScore(existingChat.id, feedback);
        return response.status(200).json({ success: true });
      } catch (error) {
        console.error("Error updating chat feedback:", error);
        response.status(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/suggested-messages",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async function (request, response) {
      try {
        const { slug } = request.params;
        const suggestedMessages =
          await WorkspaceSuggestedMessages.getMessages(slug);
        response.status(200).json({ success: true, suggestedMessages });
      } catch (error) {
        console.error("Error fetching suggested messages:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/workspace/:slug/suggested-messages",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { messages = [] } = reqBody(request);
        const { slug } = request.params;
        if (!Array.isArray(messages)) {
          return response.status(400).json({
            success: false,
            message: "Invalid message format. Expected an array of messages.",
          });
        }

        await WorkspaceSuggestedMessages.saveAll(messages, slug);
        return response.status(200).json({
          success: true,
          message: "Suggested messages saved successfully.",
        });
      } catch (error) {
        console.error("Error processing the suggested messages:", error);
        response.status(500).json({
          success: true,
          message: "Error saving the suggested messages.",
        });
      }
    }
  );

  app.post(
    "/workspace/:slug/update-pin",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { docPath, pinStatus = false } = reqBody(request);
        const workspace = response.locals.workspace;

        const document = await Document.get({
          workspaceId: workspace.id,
          docpath: docPath,
        });
        if (!document) return response.sendStatus(404).end();

        await Document.update(document.id, { pinned: pinStatus });
        return response.status(200).end();
      } catch (error) {
        console.error("Error processing the pin status update:", error);
        return response.status(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/tts/:chatId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async function (request, response) {
      try {
        const { chatId } = request.params;
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const cacheKey = `${workspace.slug}:${chatId}`;
        const identifierWhere = chatIdentityFromRequest({ chatId });
        if (!identifierWhere) return response.sendStatus(404);
        const wsChat = await WorkspaceChats.get({
          ...identifierWhere,
          workspaceId: workspace.id,
          user_id: user?.id,
        });

        if (!wsChat) return response.sendStatus(404);
        const cachedResponse = responseCache.get(cacheKey);
        if (cachedResponse) {
          response.writeHead(200, {
            "Content-Type": cachedResponse.mime || "audio/mpeg",
          });
          response.end(cachedResponse.buffer);
          return;
        }

        const text = safeJsonParse(wsChat.response, null)?.text;
        if (!text) return response.sendStatus(204).end();

        const TTSProvider = getTTSProvider();
        const buffer = await TTSProvider.ttsBuffer(text);
        if (buffer === null) return response.sendStatus(204).end();

        responseCache.set(cacheKey, { buffer, mime: "audio/mpeg" });
        response.writeHead(200, {
          "Content-Type": "audio/mpeg",
        });
        response.end(buffer);
        return;
      } catch (error) {
        console.error("Error processing the TTS request:", error);
        response.status(500).json({ message: "TTS could not be completed" });
      }
    }
  );

  app.get(
    "/workspace/:slug/pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async function (request, response) {
      try {
        const { slug } = request.params;
        const cachedResponse = responseCache.get(slug);

        if (cachedResponse) {
          response.writeHead(200, {
            "Content-Type": cachedResponse.mime || "image/png",
          });
          response.end(cachedResponse.buffer);
          return;
        }

        const pfpPath = await determineWorkspacePfpFilepath(slug);

        if (!pfpPath) {
          response.sendStatus(204).end();
          return;
        }

        const { found, buffer, mime } = fetchPfp(pfpPath);
        if (!found) {
          response.sendStatus(204).end();
          return;
        }

        responseCache.set(slug, { buffer, mime });

        response.writeHead(200, {
          "Content-Type": mime || "image/png",
        });
        response.end(buffer);
        return;
      } catch (error) {
        console.error("Error processing the logo request:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/workspace/:slug/upload-pfp",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handlePfpUpload,
    ],
    async function (request, response) {
      try {
        const { slug } = request.params;
        const uploadedFileName = request.randomFileName;
        if (!uploadedFileName) {
          return response.status(400).json({ message: "File upload failed." });
        }

        const workspaceRecord = await Workspace.get({
          slug,
        });

        const oldPfpFilename = workspaceRecord.pfpFilename;
        if (oldPfpFilename) {
          const storagePath = environmentStoragePath("assets", "pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(workspaceRecord.pfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { workspace, message } = await Workspace._update(
          workspaceRecord.id,
          {
            pfpFilename: uploadedFileName,
          }
        );

        return response.status(workspace ? 200 : 500).json({
          message: workspace
            ? "Profile picture uploaded successfully."
            : message,
        });
      } catch (error) {
        console.error("Error processing the profile picture upload:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.delete(
    "/workspace/:slug/remove-pfp",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async function (request, response) {
      try {
        const { slug } = request.params;
        const workspaceRecord = await Workspace.get({
          slug,
        });
        const oldPfpFilename = workspaceRecord.pfpFilename;

        if (oldPfpFilename) {
          const storagePath = environmentStoragePath("assets", "pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(oldPfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { workspace, message } = await Workspace._update(
          workspaceRecord.id,
          {
            pfpFilename: null,
          }
        );

        // Clear the cache
        responseCache.delete(slug);

        return response.status(workspace ? 200 : 500).json({
          message: workspace
            ? "Profile picture removed successfully."
            : message,
        });
      } catch (error) {
        console.error("Error processing the profile picture removal:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/fork",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const {
          chatId,
          publicChatId = null,
          threadSlug,
          openMode = null,
          createdFrom = "thread_fork",
        } = reqBody(request);
        const isDualThreadFork = openMode === DUAL_THREAD_FORK_MODE;

        // Get threadId we are branching from if that request body is sent
        // and is a valid thread slug.
        const sourceThread = !!threadSlug
          ? await WorkspaceThread.get({
              slug: String(threadSlug),
              workspace_id: workspace.id,
            })
          : null;
        const threadId = sourceThread?.id ?? null;
        const baseChatClause = {
          workspaceId: workspace.id,
          user_id: user?.id,
          include: true,
          thread_id: threadId,
          api_session_id: null,
        };
        const identifierWhere = chatIdentityFromRequest({
          chatId,
          publicChatId,
        });
        const forkedAtMessageId = isDualThreadFork
          ? (await WorkspaceChats.get(baseChatClause, null, { id: "desc" }))?.id
          : identifierWhere
            ? (
                await WorkspaceChats.get({
                  ...baseChatClause,
                  ...identifierWhere,
                })
              )?.id
            : null;

        if (!forkedAtMessageId)
          return response.status(400).json({
            message: isDualThreadFork
              ? "当前线程暂无可分支的消息"
              : "chatId is required",
          });

        const forkWhereClause = {
          ...baseChatClause,
          id: { lte: Number(forkedAtMessageId) },
        };
        const chatsToFork = await WorkspaceChats.where(forkWhereClause, null, {
          id: "asc",
        });

        if (isDualThreadFork && chatsToFork.length === 0)
          return response
            .status(400)
            .json({ message: "当前线程暂无可分支的消息" });

        const branchName = isDualThreadFork
          ? await uniqueBranchThreadName({ workspace, user, sourceThread })
          : undefined;
        const { thread: newThread, message: threadError } =
          await WorkspaceThread.new(workspace, user?.id, {
            ...(branchName ? { name: branchName } : {}),
            ...(isDualThreadFork
              ? {
                  parent_thread_id: threadId,
                  thread_type: "branch",
                  created_from: DUAL_THREAD_FORK_MODE,
                  forked_at_message_id: Number(forkedAtMessageId),
                  forked_at: new Date(),
                }
              : {}),
          });
        if (threadError)
          return response.status(500).json({ error: threadError });

        let lastMessageText = "";
        const chatsData = chatsToFork.map((chat) => {
          const chatResponse = safeJsonParse(chat.response, {});
          if (chatResponse?.text) lastMessageText = chatResponse.text;

          return {
            workspaceId: workspace.id,
            prompt: chat.prompt,
            response: JSON.stringify(chatResponse),
            user_id: user?.id,
            thread_id: newThread.id,
            ...(isDualThreadFork
              ? {
                  original_thread_id: threadId,
                  original_message_id: chat.id,
                  created_from: createdFrom || DUAL_THREAD_FORK_MODE,
                }
              : {}),
          };
        });
        const { chats: copiedChats, message: copyError } =
          await WorkspaceChats.bulkCreate(chatsData);
        if (copyError) return response.status(500).json({ error: copyError });
        const { thread: updatedThread } = isDualThreadFork
          ? { thread: newThread }
          : await WorkspaceThread.update(newThread, {
              name: !!lastMessageText
                ? truncate(lastMessageText, 22)
                : "Forked Thread",
            });

        await EventLogs.logEvent(
          "thread_forked",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
            threadName: updatedThread?.name || newThread.name,
          },
          user?.id
        );
        response.status(200).json({
          newThreadSlug: newThread.slug,
          ...(isDualThreadFork
            ? {
                newThread: updatedThread || newThread,
                sourceThread,
                forkedAtMessageId: Number(forkedAtMessageId),
                copiedChatCount: copiedChats?.length || chatsToFork.length,
              }
            : {}),
        });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.put(
    "/workspace/workspace-chats/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { id } = request.params;
        const user = await userFromSession(request, response);
        const identifierWhere = chatIdentityFromRequest({ id });
        if (!identifierWhere)
          return response
            .status(404)
            .json({ success: false, error: "Chat not found." });
        const validChat = await WorkspaceChats.get({
          ...identifierWhere,
          user_id: user?.id ?? null,
        });
        if (!validChat)
          return response
            .status(404)
            .json({ success: false, error: "Chat not found." });

        await WorkspaceChats._update(validChat.id, { include: false });
        response.json({ success: true, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({ success: false, error: "Server error" });
      }
    }
  );

  /** Handles the uploading and embedding in one-call by uploading via drag-and-drop in chat container. */
  app.post(
    "/workspace/:slug/upload-and-embed",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async function (request, response) {
      try {
        const { slug = null } = request.params;
        const user = await userFromSession(request, response);
        const currWorkspace = multiUserMode(response)
          ? await Workspace.getWithUser(user, { slug })
          : await Workspace.get({ slug });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        const Collector = new CollectorApi();
        const { originalname } = request.file;
        const processingOnline = await Collector.online();

        if (!processingOnline) {
          response
            .status(500)
            .json({
              success: false,
              error: `Document processing API is not online. Document ${originalname} will not be processed automatically.`,
            })
            .end();
          return;
        }

        const { success, reason, documents } =
          await Collector.processDocument(originalname);
        if (!success || documents?.length === 0) {
          response.status(500).json({ success: false, error: reason }).end();
          return;
        }

        Collector.log(
          `Document ${originalname} uploaded processed and successfully. It is now available in documents.`
        );
        await Telemetry.sendTelemetry("document_uploaded");
        await EventLogs.logEvent(
          "document_uploaded",
          {
            documentName: originalname,
          },
          response.locals?.user?.id
        );

        const document = documents[0];
        const {
          failedToEmbed = [],
          errors = [],
          documents: embeddedDocuments = [],
          batchJob = null,
        } = await Document.addDocuments(
          currWorkspace,
          [document.location],
          response.locals?.user?.id
        );

        if (failedToEmbed.length > 0)
          return response
            .status(200)
            .json({ success: false, error: errors?.[0], document: null });

        const embeddedDocument = embeddedDocuments[0] || null;
        if (!embeddedDocument)
          return response.status(200).json({
            success: false,
            error: batchJob
              ? "document_embedding_is_async"
              : "document_embedding_record_not_available",
            document: {
              id: document.id,
              location: document.location,
              embeddingStatus: batchJob ? "pending" : "unknown",
            },
            batchJob: batchJob || null,
          });

        response.status(200).json({
          success: true,
          error: null,
          document: {
            id: document.id,
            location: document.location,
            docId: embeddedDocument.docId,
            filename: embeddedDocument.filename,
            docpath: embeddedDocument.docpath,
          },
          batchJob: null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/remove-and-unembed",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceSlug,
      handleFileUpload,
    ],
    async function (request, response) {
      try {
        const body = reqBody(request);
        const currWorkspace = response.locals.workspace;
        if (!currWorkspace || !body.documentLocation)
          return response.sendStatus(400).end();

        const document = await Document.get({
          workspaceId: currWorkspace.id,
          docpath: body.documentLocation,
        });
        if (!document) return response.sendStatus(404).end();

        void recordClientTrustCheckpoint(request, {
          action: "document_delete",
          resourceType: "document",
          resourceId: `${currWorkspace.id}:${body.documentLocation}`,
          outcome: "received",
        });
        await purgeWorkspaceDocument(currWorkspace, body.documentLocation);
        response.status(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/prompt-history",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_, response) => {
      try {
        response.status(200).json({
          history: await Workspace.promptHistory({
            workspaceId: response.locals.workspace.id,
          }),
        });
      } catch (error) {
        console.error("Error fetching prompt history:", error);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/prompt-history",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_, response) => {
      try {
        response.status(200).json({
          success: await Workspace.deleteAllPromptHistory({
            workspaceId: response.locals.workspace.id,
          }),
        });
      } catch (error) {
        console.error("Error clearing prompt history:", error);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/prompt-history/:id",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const { id } = request.params;
        response.status(200).json({
          success: await Workspace.deletePromptHistory({
            workspaceId: response.locals.workspace.id,
            id: Number(id),
          }),
        });
      } catch (error) {
        console.error("Error deleting prompt history:", error);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Searches for workspaces and threads by thread name or workspace name.
   * Only returns assets owned by the user (if multi-user mode is enabled).
   */
  app.post(
    "/workspace/search",
    [validatedRequest, flexUserRoleValid([ROLES.all])],
    async (request, response) => {
      try {
        const { searchTerm } = reqBody(request);
        const searchResults = await searchWorkspaceAndThreads(
          searchTerm,
          response.locals?.user
        );
        response.status(200).json(searchResults);
      } catch (error) {
        console.error("Error searching for workspaces:", error);
        response.sendStatus(500).end();
      }
    }
  );

  // SSE endpoint for embedding progress
  app.get(
    "/workspace/:slug/embed-progress",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          addSSEConnection,
          removeSSEConnection,
        } = require("../utils/EmbeddingWorkerManager");

        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        addSSEConnection(workspace.slug, response);
        request.on("close", () => {
          removeSSEConnection(workspace.slug, response);
        });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/embed-queue",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { filename } = reqBody(request);
        if (!filename) {
          response
            .status(400)
            .json({ success: false, error: "Missing filename" });
          return;
        }

        const { removeQueuedFile } = require("../utils/EmbeddingWorkerManager");
        const sent = removeQueuedFile(workspace.slug, filename);
        response.status(200).json({ success: sent });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/is-agent-command-available",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (_, response) => {
      try {
        response.status(200).json({
          showAgentCommand: await Workspace.isAgentCommandAvailable(
            response.locals.workspace
          ),
        });
      } catch (error) {
        console.error("Error checking if agent command is available:", error);
        response.status(500).json({ showAgentCommand: true });
      }
    }
  );

  // Parsed Files in separate endpoint just to keep the workspace endpoints clean
  workspaceParsedFilesEndpoints(app);
  workspaceReaderDocumentsEndpoints(app);
}

module.exports = { workspaceEndpoints };
