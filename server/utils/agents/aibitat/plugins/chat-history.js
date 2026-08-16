const { lazyDataAccessFacade } = require("../../../dataAccess/lazyFacade");
const Workspace = lazyDataAccessFacade("workspace");
const WorkspaceThread = lazyDataAccessFacade("workspaceThread");
const WorkspaceChats = lazyDataAccessFacade("workspaceChat");
const {
  requestThreadTitleGeneration,
} = require("../../../chats/threadTitleGeneration");
const {
  publishWorkspaceSyncEvent,
} = require("../../../chats/workspaceSyncEvents");
const { compactAgentEvents } = require("../../toolResultStore.js");
const { executionMetadata } = require("../../../chats/executionMetadata");
const {
  finalizeAgentChatTurn,
  remoteAgentChatPersistenceEnabled,
  reserveAgentChatTurn,
} = require("../../agentChatPersistenceClient");

async function publishAgentChatFinalized(aibitat, chatId = null) {
  const invocation = aibitat?.handlerProps?.invocation;
  if (!invocation?.workspace_id) return;

  const workspace =
    invocation.workspace ||
    (await Workspace.get({ id: Number(invocation.workspace_id) }).catch(
      () => null
    ));
  if (!workspace?.slug) return;

  const threadClause = invocation.thread_id
    ? {
        id: Number(invocation.thread_id),
        workspace_id: Number(invocation.workspace_id),
        user_id: invocation.user_id ? Number(invocation.user_id) : null,
      }
    : null;
  const thread =
    invocation.thread ||
    (threadClause
      ? await WorkspaceThread.get(threadClause).catch(() => null)
      : null);

  publishWorkspaceSyncEvent({
    type: "chat_finalized",
    workspaceId: Number(invocation.workspace_id),
    workspaceSlug: workspace.slug,
    userId: invocation.user_id || null,
    threadId: invocation.thread_id || null,
    threadSlug: thread?.slug || null,
    chatId,
    publicChatId: aibitat?.trackedPublicChatId || null,
    clientTurnId: invocation.clientTurnId || null,
    mutationKind: "agent_finalized",
  });
}

/**
 * Plugin to save chat history to AnythingLLM DB.
 */
const chatHistory = {
  name: "chat-history",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup: function (aibitat) {
        const plugin = this;
        // If the agent is aborted (e.g. user sent /reset mid-response), skip
        // the pending save so a completing in-flight response doesn't reappear.
        aibitat.onAbort(() => {
          aibitat._aborted = true;
        });

        let pendingFinalPersistence = null;
        aibitat.persistCompletedTurn = async () => {
          if (aibitat._aborted) return null;
          if (aibitat.trackedChatId) return aibitat.trackedChatId;
          if (pendingFinalPersistence) return pendingFinalPersistence;

          pendingFinalPersistence = (async () => {
            try {
              const lastResponses = aibitat.chats.slice(-2);
              if (lastResponses.length !== 2) return null;
              const [prev, last] = lastResponses;

              // We need a full conversation reply with prev being from
              // the USER and the last being from anyone other than the user.
              if (prev.from !== "USER" || last.from === "USER") return null;

              const isVisionPreAnalyzedTurn = Boolean(
                aibitat.handlerProps?.visionAnalysisContext &&
                  prev.content.includes("[System image pre-analysis]")
              );
              // Keep display/history attachments separate from model attachments.
              // Vision pre-analysis removes image pixels before the agent model sees
              // them, but the user's original image must remain in chat history.
              const attachments = isVisionPreAnalyzedTurn
                ? aibitat.handlerProps?.displayAttachments || []
                : prev.attachments || [];
              const prompt = isVisionPreAnalyzedTurn
                ? aibitat.handlerProps?.displayPrompt || prev.content
                : prev.content;
              const imageAnalysis = isVisionPreAnalyzedTurn
                ? aibitat.handlerProps?.visionAnalysisContext
                : null;

              // If we have a post-reply flow we should save the chat using this special flow
              // so that post save cleanup and other unique properties can be run as opposed to regular chat.
              if (aibitat.hasOwnProperty("_replySpecialAttributes")) {
                await plugin._storeSpecial(aibitat, {
                  prompt,
                  response: last.content,
                  attachments,
                  imageAnalysis,
                  options: aibitat._replySpecialAttributes,
                });
                delete aibitat._replySpecialAttributes;
                return aibitat.trackedChatId;
              }

              await plugin._store(aibitat, {
                prompt,
                response: last.content,
                attachments,
                imageAnalysis,
              });
              return aibitat.trackedChatId;
            } catch (error) {
              console.warn("[AgentChatHistory] failed to persist agent chat", {
                message: error.message,
                invocationUuid: aibitat.handlerProps?.invocation?.uuid || null,
                workspaceId:
                  aibitat.handlerProps?.invocation?.workspace_id || null,
                trackedChatId: aibitat.trackedChatId || null,
              });
              plugin._cleanup(aibitat);
              throw error;
            }
          })().finally(() => {
            pendingFinalPersistence = null;
          });
          return pendingFinalPersistence;
        };

        aibitat.cleanupCompletedTurn = () => plugin._cleanup(aibitat);
      },
      _persistFinal: async function (aibitat, payload = {}) {
        const invocation = aibitat.handlerProps.invocation;
        if (remoteAgentChatPersistenceEnabled()) {
          const scope = {
            workspaceId: Number(invocation.workspace_id),
            userId: invocation?.user_id || null,
            threadId: invocation?.thread_id || null,
            clientTurnId: invocation?.clientTurnId || null,
          };
          const reserved = await reserveAgentChatTurn({
            ...scope,
            prompt: payload.prompt,
          });
          const reservation = reserved?.chat || null;
          const reservationId =
            reservation?.reservationId || reservation?.id || null;
          if (!reservationId)
            throw new Error("agent_chat_reservation_missing");

          const persisted = await finalizeAgentChatTurn({
            ...scope,
            reservationId,
            publicChatId:
              aibitat.handlerProps?.reservedPublicChatId ||
              aibitat.trackedPublicChatId ||
              null,
            prompt: payload.prompt,
            response: payload.response,
            renameThread: !aibitat._threadRenamed,
          });
          const savedChat = persisted?.chat || null;
          if (!Number.isSafeInteger(Number(savedChat?.id)))
            throw new Error(
              persisted?.error || "agent_final_chat_persistence_failed"
            );
          aibitat.registerChatId(
            Number(savedChat.id),
            savedChat.publicId || savedChat.public_id || null
          );
          aibitat._remoteChatFinalized = true;
          aibitat._threadRenamed = true;
          return Number(savedChat.id);
        }
        if (aibitat.trackedChatId) {
          await WorkspaceChats.upsert(aibitat.trackedChatId, payload);
          return aibitat.trackedChatId;
        }

        const { chat, message } = await WorkspaceChats.new({
          ...payload,
          publicChatId: aibitat.handlerProps?.reservedPublicChatId || null,
        });
        if (!chat?.id)
          throw new Error(message || "agent_final_chat_persistence_failed");
        aibitat.registerChatId(chat.id, chat.public_id || null);
        return chat.id;
      },
      _store: async function (
        aibitat,
        { prompt, response, attachments = [], imageAnalysis = null } = {}
      ) {
        const invocation = aibitat.handlerProps.invocation;
        const metrics = aibitat.provider?.getUsage?.() ?? {};
        const citations = aibitat._pendingCitations ?? [];
        const outputs = aibitat._pendingOutputs ?? [];
        const clarifyingQuestions =
          aibitat._pendingClarifyingQuestionSurveys ?? [];
        const agentEvents = compactAgentEvents(aibitat._agentEvents ?? []);
        await this._persistFinal(aibitat, {
          workspaceId: Number(invocation.workspace_id),
          prompt,
          response: {
            text: response,
            sources: citations,
            type: "chat",
            attachments,
            metrics,
            execution: executionMetadata({
              metrics,
              model: metrics?.model || aibitat.provider?.model || null,
              provider:
                metrics?.provider ||
                aibitat.handlerProps?.invocation?.provider ||
                "deepseek",
            }),
            ...(imageAnalysis ? { imageAnalysis } : {}),
            ...(outputs.length > 0 ? { outputs } : {}),
            ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
            ...(agentEvents.length > 0 ? { agentEvents } : {}),
          },
          user: { id: invocation?.user_id || null },
          threadId: invocation?.thread_id || null,
          include: true,
          clientTurnId: invocation?.clientTurnId || null,
          sourceChannel: "agent",
        });
        if (!aibitat._remoteChatFinalized)
          await publishAgentChatFinalized(aibitat, aibitat.trackedChatId);

        if (!aibitat._threadRenamed) {
          aibitat._threadRenamed = await this._autoRenameThread(
            aibitat,
            prompt
          );
        }
      },
      _storeSpecial: async function (
        aibitat,
        {
          prompt,
          response,
          attachments = [],
          imageAnalysis = null,
          options = {},
        } = {}
      ) {
        const invocation = aibitat.handlerProps.invocation;
        const metrics = aibitat.provider?.getUsage?.() ?? {};
        const citations = aibitat._pendingCitations ?? [];
        const outputs = aibitat._pendingOutputs ?? [];
        const clarifyingQuestions =
          aibitat._pendingClarifyingQuestionSurveys ?? [];
        const agentEvents = compactAgentEvents(aibitat._agentEvents ?? []);
        const existingSources = options?.sources ?? [];
        await this._persistFinal(aibitat, {
          workspaceId: Number(invocation.workspace_id),
          prompt,
          response: {
            sources: [...existingSources, ...citations],
            // when we have a _storeSpecial called the options param can include a storedResponse() function
            // that will override the text property to store extra information in, depending on the special type of chat.
            text: options.hasOwnProperty("storedResponse")
              ? options.storedResponse(response)
              : response,
            type: options?.saveAsType ?? "chat",
            attachments,
            metrics,
            execution: executionMetadata({
              metrics,
              model: metrics?.model || aibitat.provider?.model || null,
              provider:
                metrics?.provider ||
                aibitat.handlerProps?.invocation?.provider ||
                "deepseek",
            }),
            ...(imageAnalysis ? { imageAnalysis } : {}),
            ...(outputs.length > 0 ? { outputs } : {}),
            ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
            ...(agentEvents.length > 0 ? { agentEvents } : {}),
          },
          user: { id: invocation?.user_id || null },
          threadId: invocation?.thread_id || null,
          include: true,
          clientTurnId: invocation?.clientTurnId || null,
          sourceChannel: "agent",
        });
        if (!aibitat._remoteChatFinalized)
          await publishAgentChatFinalized(aibitat, aibitat.trackedChatId);

        if (!aibitat._threadRenamed) {
          aibitat._threadRenamed = await this._autoRenameThread(
            aibitat,
            prompt
          );
        }
        options?.postSave();
      },

      _autoRenameThread: async function (aibitat) {
        const invocation = aibitat.handlerProps.invocation;
        if (!invocation?.thread_id) return true;

        await requestThreadTitleGeneration({
          workspaceId: invocation.workspace_id,
          threadId: invocation.thread_id,
          userId: invocation.user_id || null,
          include: true,
          apiSessionId: null,
          clientTurnId: invocation.clientTurnId || null,
        });
        return true;
      },

      _cleanup: function (aibitat) {
        aibitat.clearCitations?.();
        aibitat._pendingOutputs = [];
        aibitat._agentEvents = [];
        aibitat._agentEventIndexByKey = new Map();
        aibitat.clearClarifyingQuestionSurveys?.();
        aibitat.clearTrackedChatId();
      },
    };
  },
};

module.exports = { chatHistory };
