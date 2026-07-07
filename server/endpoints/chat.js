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

const User = DataAccessCenter.user;

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
        response.status(500).json({ success: false, error: e.message });
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
        } = reqBody(request);
        const workspace = response.locals.workspace;

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

        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        const clientContext = getClientContext(request, { user });

        if (multiUserMode(response) && !(await User.canSendChat(user))) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
          });
          return;
        }

        publishWorkspaceSyncEvent({
          type: "chat_prompt_submitted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: null,
          threadSlug: null,
          senderClientId: clientContext.clientId,
          clientTurnId,
          message: displayPrompt || message,
        });

        await streamChatWithWorkspace(
          response,
          workspace,
          message,
          workspace?.chatMode,
          user,
          null,
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
              threadId: null,
              threadSlug: null,
              senderClientId: clientContext.clientId,
            },
          }
        );
        await Telemetry.sendTelemetry("sent_chat", {
          multiUserMode: multiUserMode(response),
          LLMSelection: process.env.LLM_PROVIDER || "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          multiModal: Array.isArray(attachments) && attachments?.length !== 0,
          TTSSelection: process.env.TTS_PROVIDER || "native",
          LLMModel: getModelTag(),
        });

        await EventLogs.logEvent(
          "sent_chat",
          {
            workspaceName: workspace?.name,
            chatModel: workspace?.chatModel || "System Default",
          },
          user?.id
        );
        response.end();
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
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        response.end();
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
        } = reqBody(request);
        const workspace = response.locals.workspace;
        const thread = response.locals.thread;

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

        setSseTransportHeaders(response, {
          "Access-Control-Allow-Origin": "*",
        });
        response.flushHeaders();
        const detachTitleUpdates = attachThreadTitleUpdateStream(response, {
          workspace,
          thread,
        });
        const clientContext = getClientContext(request, { user });

        if (multiUserMode(response) && !(await User.canSendChat(user))) {
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `You have met your maximum 24 hour chat quota of ${user.dailyMessageLimit} chats. Try again later.`,
          });
          detachTitleUpdates();
          return;
        }

        publishWorkspaceSyncEvent({
          type: "chat_prompt_submitted",
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          userId: user?.id ?? null,
          threadId: thread.id,
          threadSlug: thread.slug,
          senderClientId: clientContext.clientId,
          clientTurnId,
          message: displayPrompt || message,
        });

        await streamChatWithWorkspace(
          response,
          workspace,
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
              threadId: thread.id,
              threadSlug: thread.slug,
              senderClientId: clientContext.clientId,
            },
          }
        );

        await Telemetry.sendTelemetry("sent_chat", {
          multiUserMode: multiUserMode(response),
          LLMSelection: process.env.LLM_PROVIDER || "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          multiModal: Array.isArray(attachments) && attachments?.length !== 0,
          TTSSelection: process.env.TTS_PROVIDER || "native",
          LLMModel: getModelTag(),
        });

        await EventLogs.logEvent(
          "sent_chat",
          {
            workspaceName: workspace.name,
            thread: thread.name,
            chatModel: workspace?.chatModel || "System Default",
          },
          user?.id
        );
        response.end();
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
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );
}

module.exports = { chatEndpoints };
