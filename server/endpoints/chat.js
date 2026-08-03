const { v4: uuidv4 } = require("uuid");
const { reqBody, userFromSession, multiUserMode } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  TelemetryRepository: Telemetry,
} = require("../repositories/telemetryRepository");
const { streamChatWithWorkspace } = require("../utils/chats/stream");
const {
  subscribeToThreadTitleUpdates,
} = require("../utils/chats/threadTitleEvents");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const {
  EventLogRepository: EventLogs,
} = require("../repositories/eventLogRepository");
const {
  validWorkspaceAndThreadSlug,
  validWorkspaceSlug,
} = require("../utils/middleware/validWorkspace");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const { DataAccessCenter } = require("../utils/dataAccess");
const { getModelTag } = require("./utils");
const { respondToChatToolApproval } = require("../utils/chats/toolApproval");
const {
  getClientContext,
  recordClientTrustCheckpoint,
} = require("../utils/clientIdentity");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");
const {
  publishWorkspaceSyncEvent,
} = require("../utils/chats/workspaceSyncEvents");
const {
  workspaceWithThreadChatModel,
} = require("../utils/chats/threadChatModel");
const {
  publishCommittedChatDeletion,
} = require("../utils/chats/chatTurnMutations");
const { chatStreamRunManager } = require("../utils/chats/chatStreamRuns");

const User = DataAccessCenter.user;
const WorkspaceChats = DataAccessCenter.workspaceChat;

function nativeEditContext(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Invalid native chat edit context.");
    error.code = "edit_invalid_context";
    throw error;
  }
  const startingChatId = Number(value.startingChatId);
  const sourceActionId = String(value.sourceActionId || "")
    .trim()
    .slice(0, 160);
  if (!Number.isInteger(startingChatId) || startingChatId <= 0) {
    const error = new Error("Invalid starting chat for native chat edit.");
    error.code = "edit_invalid_starting_chat";
    throw error;
  }
  if (!sourceActionId) {
    const error = new Error("Missing source action for native chat edit.");
    error.code = "edit_missing_source_action";
    throw error;
  }
  return { startingChatId, sourceActionId };
}

function nativeRegenerateContext(value = null) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Invalid native regenerate context.");
    error.code = "regenerate_invalid_context";
    throw error;
  }
  const targetChatId = Number(value.targetChatId);
  const sourceActionId = String(value.sourceActionId || "")
    .trim()
    .slice(0, 160);
  if (!Number.isInteger(targetChatId) || targetChatId <= 0) {
    const error = new Error("Invalid target chat for regeneration.");
    error.code = "regenerate_invalid_target_chat";
    throw error;
  }
  if (!sourceActionId) {
    const error = new Error("Missing source action for regeneration.");
    error.code = "regenerate_missing_source_action";
    throw error;
  }
  return { targetChatId, sourceActionId };
}

function chatResponseText(chat = null) {
  if (!chat?.response) return "";
  if (typeof chat.response === "object")
    return String(chat.response.text || "");
  try {
    return String(JSON.parse(chat.response)?.text || "");
  } catch {
    return "";
  }
}

async function replayFinalizedClientTurn({
  response,
  workspace,
  thread = null,
  user = null,
  clientTurnId = null,
} = {}) {
  const normalizedTurnId = String(clientTurnId || "").trim();
  if (!normalizedTurnId) return false;
  const chat = await WorkspaceChats.get({
    clientTurnId: normalizedTurnId,
    workspaceId: Number(workspace.id),
    thread_id: thread?.id || null,
    user_id: user?.id || null,
    api_session_id: null,
  });
  if (!chat) return false;

  const id = uuidv4();
  const text = chatResponseText(chat);
  if (text) {
    writeResponseChunk(response, {
      id,
      type: "fullTextResponse",
      textResponse: text,
      close: false,
      replayed: true,
    });
  }
  writeResponseChunk(response, {
    id,
    type: "finalizeResponseStream",
    chatId: chat.id,
    publicChatId: chat.public_id || null,
    clientTurnId: normalizedTurnId,
    close: true,
    replayed: true,
  });
  return true;
}

async function prepareNativeTurnMutationStream({
  response,
  workspace,
  thread = null,
  user = null,
  clientContext,
  editContext,
  regenerateContext,
  clientTurnId = null,
} = {}) {
  if (!editContext && !regenerateContext) return null;
  const isEdit = !!editContext;
  const context = editContext || regenerateContext;
  writeResponseChunk(response, {
    id: uuidv4(),
    type: isEdit ? "editSessionReady" : "regenerateSessionReady",
    sourceActionId: context.sourceActionId,
    ...(isEdit
      ? { startingChatId: context.startingChatId }
      : { targetChatId: context.targetChatId }),
    close: false,
  });

  const result = isEdit
    ? await WorkspaceChats.truncateForNativeEdit({
        workspaceId: workspace.id,
        threadId: thread?.id || null,
        userId: user?.id || null,
        startingChatId: context.startingChatId,
        sourceActionId: context.sourceActionId,
      })
    : await WorkspaceChats.regenerateLastTurn({
        workspaceId: workspace.id,
        threadId: thread?.id || null,
        userId: user?.id || null,
        targetChatId: context.targetChatId,
        sourceActionId: context.sourceActionId,
      });
  if (!result.replayed) {
    await publishCommittedChatDeletion({
      workspace,
      thread,
      user,
      clientContext,
      sourceActionId: context.sourceActionId,
      clientTurnId,
      mutationKind: isEdit ? "edit-truncate" : "regenerate-replace",
      ...(isEdit
        ? { startingChatId: context.startingChatId }
        : { targetChatId: context.targetChatId }),
    });
  }

  writeResponseChunk(response, {
    id: uuidv4(),
    type: isEdit ? "editHistoryTruncated" : "regenerateTurnDeleted",
    sourceActionId: context.sourceActionId,
    ...(isEdit
      ? { startingChatId: context.startingChatId }
      : { targetChatId: context.targetChatId }),
    replayed: result.replayed,
    deletedCount: result.deletedCount,
    close: false,
  });
  return result;
}

function attachThreadTitleUpdateStream(response, { workspace, thread } = {}) {
  if (!workspace?.id || !thread?.id) return () => {};

  const unsubscribe = subscribeToThreadTitleUpdates((titleUpdate) => {
    if (Number(titleUpdate.workspaceId) !== Number(workspace.id)) return;
    if (Number(titleUpdate.threadId) !== Number(thread.id)) return;
    if (response.destroyed || response.writableEnded) return;

    writeResponseChunk(response, {
      id: uuidv4(),
      action: "rename_thread",
      thread: {
        slug: titleUpdate.slug,
        name: titleUpdate.name,
        title: titleUpdate.title || titleUpdate.name,
        titleVersion: titleUpdate.titleVersion,
        animate: true,
      },
    });
  });
  const detach = () => unsubscribe();

  response.once("close", detach);
  return () => {
    response.off("close", detach);
    detach();
  };
}

function chatStreamScope({
  workspace,
  thread = null,
  user = null,
  clientTurnId,
}) {
  return {
    clientTurnId: String(clientTurnId || "").trim(),
    workspaceId: Number(workspace.id),
    threadId: thread?.id || null,
    userId: user?.id || null,
  };
}

async function executeDetachedChatRun({
  response,
  workspace,
  effectiveWorkspace = workspace,
  thread = null,
  user,
  clientContext,
  message,
  displayPrompt = null,
  attachments = [],
  fileAccess = {},
  nodeContext = null,
  clientTurnId,
  editContext = null,
  regenerateContext = null,
  isMultiUser = false,
}) {
  const detachTitleUpdates = thread
    ? attachThreadTitleUpdateStream(response, { workspace, thread })
    : () => {};
  try {
    if (isMultiUser && !(await User.canSendChat(user))) {
      writeResponseChunk(response, {
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
        errorCode: "chat_quota_exceeded",
      });
      return;
    }

    await prepareNativeTurnMutationStream({
      response,
      workspace,
      thread,
      user,
      clientContext,
      editContext,
      regenerateContext,
      clientTurnId,
    });
    if (
      await replayFinalizedClientTurn({
        response,
        workspace,
        thread,
        user,
        clientTurnId,
      })
    )
      return;

    publishWorkspaceSyncEvent({
      type: "chat_prompt_submitted",
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      userId: user?.id ?? null,
      threadId: thread?.id || null,
      threadSlug: thread?.slug || null,
      senderClientId: clientContext.clientId,
      clientTurnId,
      message: displayPrompt || message,
    });

    await streamChatWithWorkspace(
      response,
      effectiveWorkspace,
      message,
      workspace?.chatMode,
      user,
      thread,
      attachments,
      {
        fileAccess,
        nodeContext,
        clientTurnId,
        displayPrompt,
        syncEvent: {
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: thread?.id || null,
          threadSlug: thread?.slug || null,
          senderClientId: clientContext.clientId,
        },
      }
    );

    await Telemetry.sendTelemetry("sent_chat", {
      multiUserMode: isMultiUser,
      LLMSelection: process.env.LLM_PROVIDER || "openai",
      Embedder: process.env.EMBEDDING_ENGINE || "inherit",
      VectorDbSelection: process.env.VECTOR_DB || "lancedb",
      multiModal: Array.isArray(attachments) && attachments.length !== 0,
      TTSSelection: process.env.TTS_PROVIDER || "native",
      LLMModel: getModelTag(),
    });
    await EventLogs.logEvent(
      "sent_chat",
      {
        workspaceName: workspace?.name,
        ...(thread ? { thread: thread.name } : {}),
        chatModel: effectiveWorkspace.chatModel || "System Default",
      },
      user?.id
    );
  } catch (error) {
    publishWorkspaceSyncEvent({
      type: "chat_failed",
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      userId: user?.id ?? null,
      threadId: thread?.id || null,
      threadSlug: thread?.slug || null,
      senderClientId: clientContext.clientId,
      clientTurnId,
      error: error.message,
    });
    throw error;
  } finally {
    detachTitleUpdates();
  }
}

function chatEndpoints(app) {
  if (!app) return;

  app.post(
    "/workspace/:slug/tool-approval",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { requestId, approved } = reqBody(request);
        void recordClientTrustCheckpoint(request, {
          action: "chat_tool_approval",
          resourceType: "workspace",
          resourceId: response.locals.workspace?.id || request.params.slug,
          outcome: approved ? "approved" : "rejected",
          metadata: { hasApprovalRequestId: !!requestId },
        });
        const result = respondToChatToolApproval({
          requestId,
          userId: user?.id,
          approved,
        });
        response.status(result.success ? 200 : 404).json(result);
      } catch (e) {
        console.error(e);
        response
          .status(e.httpStatus || 500)
          .json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/chat-runs/:clientTurnId/state",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const run = await chatStreamRunManager.state(
          chatStreamScope({
            workspace: response.locals.workspace,
            user,
            clientTurnId: request.params.clientTurnId,
          })
        );
        if (!run) {
          return response.status(404).json({
            success: false,
            error: "chat_stream_run_not_found",
          });
        }
        return response.status(200).json({ success: true, run });
      } catch (error) {
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/chat-runs/:clientTurnId/stream",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const scope = chatStreamScope({
          workspace,
          user,
          clientTurnId: request.params.clientTurnId,
        });
        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        await chatStreamRunManager.attach(
          response,
          scope,
          request.query?.afterRevision
        );
      } catch (error) {
        if (!response.writableEnded && !response.destroyed) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            close: true,
            error: error.message,
            errorCode: error.code || "chat_stream_reconnect_failed",
          });
          response.end();
        }
      }
    }
  );

  app.post(
    "/workspace/:slug/chat-runs/:clientTurnId/cancel",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const cancelled = await chatStreamRunManager.cancel(
          chatStreamScope({
            workspace: response.locals.workspace,
            user,
            clientTurnId: request.params.clientTurnId,
          })
        );
        response.status(cancelled ? 200 : 409).json({
          success: cancelled,
          status: cancelled ? "cancelling" : "not_running",
        });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/thread/:threadSlug/chat-runs/:clientTurnId/state",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const run = await chatStreamRunManager.state(
          chatStreamScope({
            workspace: response.locals.workspace,
            thread: response.locals.thread,
            user,
            clientTurnId: request.params.clientTurnId,
          })
        );
        if (!run) {
          return response.status(404).json({
            success: false,
            error: "chat_stream_run_not_found",
          });
        }
        return response.status(200).json({ success: true, run });
      } catch (error) {
        return response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/thread/:threadSlug/chat-runs/:clientTurnId/stream",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const scope = chatStreamScope({
          workspace: response.locals.workspace,
          thread: response.locals.thread,
          user,
          clientTurnId: request.params.clientTurnId,
        });
        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        await chatStreamRunManager.attach(
          response,
          scope,
          request.query?.afterRevision
        );
      } catch (error) {
        if (!response.writableEnded && !response.destroyed) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            close: true,
            error: error.message,
            errorCode: error.code || "chat_stream_reconnect_failed",
          });
          response.end();
        }
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/chat-runs/:clientTurnId/cancel",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const cancelled = await chatStreamRunManager.cancel(
          chatStreamScope({
            workspace: response.locals.workspace,
            thread: response.locals.thread,
            user,
            clientTurnId: request.params.clientTurnId,
          })
        );
        response.status(cancelled ? 200 : 409).json({
          success: cancelled,
          status: cancelled ? "cancelling" : "not_running",
        });
      } catch (error) {
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/stream-chat",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const {
          message,
          displayPrompt = null,
          attachments = [],
          fileAccess = {},
          nodeContext = null,
          clientTurnId = null,
          editContext: rawEditContext = null,
          regenerateContext: rawRegenerateContext = null,
        } = reqBody(request);
        const workspace = response.locals.workspace;
        let editContext = null;
        let regenerateContext = null;

        if (typeof message !== "string" || message.trim().length === 0) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: "Message is empty.",
          });
          return;
        }
        try {
          editContext = nativeEditContext(rawEditContext);
          regenerateContext = nativeRegenerateContext(rawRegenerateContext);
          if (editContext && regenerateContext) {
            const error = new Error(
              "Chat mutation contexts are mutually exclusive."
            );
            error.code = "chat_mutation_context_conflict";
            throw error;
          }
        } catch (error) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            close: true,
            error: error.message,
            errorCode: error.code,
          });
          return;
        }

        const clientContext = getClientContext(request, { user });
        const resolvedClientTurnId =
          String(clientTurnId || "").trim() || uuidv4();
        const scope = chatStreamScope({
          workspace,
          user,
          clientTurnId: resolvedClientTurnId,
        });
        const { run, created } = await chatStreamRunManager.claim(scope);
        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        if (!created) {
          await chatStreamRunManager.attach(
            response,
            scope,
            request.query?.afterRevision
          );
          return;
        }
        const runtime = chatStreamRunManager.start(run, (streamResponse) =>
          executeDetachedChatRun({
            response: streamResponse,
            workspace,
            user,
            clientContext,
            message,
            displayPrompt,
            attachments,
            fileAccess,
            nodeContext,
            clientTurnId: resolvedClientTurnId,
            editContext,
            regenerateContext,
            isMultiUser: multiUserMode(response),
          })
        );
        runtime.sink.__athenaGoldenJourney =
          response.__athenaGoldenJourney || null;
        await runtime.attach(response, request.query?.afterRevision);
      } catch (e) {
        console.error(e);
        const workspace = response.locals.workspace;
        if (workspace?.id) {
          const user = await userFromSession(request, response).catch(
            () => null
          );
          const clientContext = getClientContext(request, { user });
          publishWorkspaceSyncEvent({
            type: "chat_failed",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            threadId: null,
            threadSlug: null,
            senderClientId: clientContext.clientId,
            clientTurnId: reqBody(request)?.clientTurnId || null,
            error: e.message,
          });
        }
        if (
          !response.headersSent &&
          !response.writableEnded &&
          !response.destroyed
        ) {
          response.status(e.httpStatus || 500).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: e.message,
            errorCode: e.code || "chat_stream_failed",
          });
        } else if (!response.writableEnded && !response.destroyed) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: e.message,
            errorCode: e.code || "chat_stream_failed",
          });
          response.end();
        }
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/:threadSlug/stream-chat",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.all]),
      validWorkspaceAndThreadSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const {
          message,
          displayPrompt = null,
          attachments = [],
          fileAccess = {},
          nodeContext = null,
          clientTurnId = null,
          editContext: rawEditContext = null,
          regenerateContext: rawRegenerateContext = null,
        } = reqBody(request);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        let editContext = null;
        let regenerateContext = null;
        const effectiveWorkspace = workspaceWithThreadChatModel(
          workspace,
          thread
        );

        if (typeof message !== "string" || message.trim().length === 0) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: "Message is empty.",
          });
          return;
        }
        try {
          editContext = nativeEditContext(rawEditContext);
          regenerateContext = nativeRegenerateContext(rawRegenerateContext);
          if (editContext && regenerateContext) {
            const error = new Error(
              "Chat mutation contexts are mutually exclusive."
            );
            error.code = "chat_mutation_context_conflict";
            throw error;
          }
        } catch (error) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            close: true,
            error: error.message,
            errorCode: error.code,
          });
          return;
        }

        const clientContext = getClientContext(request, { user });
        const resolvedClientTurnId =
          String(clientTurnId || "").trim() || uuidv4();
        const scope = chatStreamScope({
          workspace,
          thread,
          user,
          clientTurnId: resolvedClientTurnId,
        });
        const { run, created } = await chatStreamRunManager.claim(scope);
        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        if (!created) {
          await chatStreamRunManager.attach(
            response,
            scope,
            request.query?.afterRevision
          );
          return;
        }
        const runtime = chatStreamRunManager.start(run, (streamResponse) =>
          executeDetachedChatRun({
            response: streamResponse,
            workspace,
            effectiveWorkspace,
            thread,
            user,
            clientContext,
            message,
            displayPrompt,
            attachments,
            fileAccess,
            nodeContext,
            clientTurnId: resolvedClientTurnId,
            editContext,
            regenerateContext,
            isMultiUser: multiUserMode(response),
          })
        );
        runtime.sink.__athenaGoldenJourney =
          response.__athenaGoldenJourney || null;
        await runtime.attach(response, request.query?.afterRevision);
      } catch (e) {
        console.error(e);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;
        if (workspace?.id) {
          const user = await userFromSession(request, response).catch(
            () => null
          );
          const clientContext = getClientContext(request, { user });
          publishWorkspaceSyncEvent({
            type: "chat_failed",
            workspaceId: workspace.id,
            workspaceSlug: workspace.slug,
            userId: user?.id ?? null,
            threadId: thread?.id || null,
            threadSlug: thread?.slug || request.params.threadSlug || null,
            senderClientId: clientContext.clientId,
            clientTurnId: reqBody(request)?.clientTurnId || null,
            error: e.message,
          });
        }
        if (
          !response.headersSent &&
          !response.writableEnded &&
          !response.destroyed
        ) {
          response.status(e.httpStatus || 500).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: e.message,
            errorCode: e.code || "chat_stream_failed",
          });
        } else if (!response.writableEnded && !response.destroyed) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: e.message,
            errorCode: e.code || "chat_stream_failed",
          });
          response.end();
        }
      }
    }
  );
}

module.exports = { chatEndpoints };
