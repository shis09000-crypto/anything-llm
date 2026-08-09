const { lazyDataAccessFacade } = require("../../../dataAccess/lazyFacade");
const Workspace = lazyDataAccessFacade("workspace");
const WorkspaceThread = lazyDataAccessFacade("workspaceThread");
const WorkspaceChats = lazyDataAccessFacade("workspaceChat");
const {
  maybeEnqueueTitleGenerationAfterChat,
} = require("../../../chats/threadTitleGeneration");
const {
  publishWorkspaceSyncEvent,
} = require("../../../chats/workspaceSyncEvents");
const { compactAgentEvents } = require("../../toolResultStore.js");
const { promptForHistory } = require("../../../chats/displayPrompt");
const {
  finalizeAgentChatTurn,
  remoteAgentChatPersistenceEnabled,
  reserveAgentChatTurn,
} = require("../../agentChatPersistenceClient");
const { executionMetadata } = require("../../../chats/executionMetadata");

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
        // If the agent is aborted (e.g. user sent /reset mid-response), skip
        // the pending save so a completing in-flight response doesn't reappear.
        aibitat.onAbort(() => {
          aibitat._aborted = true;
        });

        let pendingTrackedChatIdPromise = null;
        const ensureTrackedChatId = async (message) => {
          if (message.from !== "USER") return;
          if (aibitat.trackedChatId) return;
          if (pendingTrackedChatIdPromise) return pendingTrackedChatIdPromise;

          pendingTrackedChatIdPromise = (async () => {
            if (aibitat.trackedChatId) return;

            /**
             * If we don't have a tracked chat ID, we need to create a new one so we can upsert the response later.
             * Normally, if this was a totally fresh chat from the user, we can assume that the message from the socket is
             * the message we want to store for the prompt. However, if this is a regeneration of a previous message and that message
             * called tools the history could include intermediate messages so need to search backwards to find the most recent user message
             * as that is actually the prompt.
             */
            let userMessage = message.content;
            if (userMessage.startsWith("@agent:")) {
              const lastUserMsgIndex = aibitat._chats.findLastIndex(
                (c) => c.from === "USER" && !c.content.startsWith("@agent:")
              );

              // When regenerating a message, we need to use the last user message as the prompt.
              // Also prune the chats array to only include the messages before target prompt to re-run
              // or else tool call results from the previous run will be included in the history and the model will not re-call tools
              // that previously worked for the to-be-regenerated prompt.
              if (lastUserMsgIndex !== -1) {
                userMessage = aibitat._chats[lastUserMsgIndex].content;
                aibitat._chats = aibitat._chats.slice(0, lastUserMsgIndex + 1);
              }
            }

            const input = {
              workspaceId: Number(aibitat.handlerProps.invocation.workspace_id),
              userId: aibitat.handlerProps.invocation.user_id || null,
              threadId: aibitat.handlerProps.invocation.thread_id || null,
              prompt: promptForHistory({
                message: userMessage,
                displayPrompt: aibitat.handlerProps?.displayPrompt,
              }),
              clientTurnId:
                aibitat.handlerProps.invocation.clientTurnId || null,
            };
            const result = remoteAgentChatPersistenceEnabled()
              ? await reserveAgentChatTurn(input)
              : await WorkspaceChats.new({
                  workspaceId: input.workspaceId,
                  user: { id: input.userId },
                  threadId: input.threadId,
                  include: false,
                  prompt: input.prompt,
                  response: {},
                  clientTurnId: input.clientTurnId,
                  sourceChannel: "agent",
                });
            const chat = result?.chat || null;
            if (chat)
              aibitat.registerChatId(
                chat.id,
                chat.publicId || chat.public_id || null
              );
          })().finally(() => {
            pendingTrackedChatIdPromise = null;
          });

          return pendingTrackedChatIdPromise;
        };

        aibitat.ensureTrackedChatId = ensureTrackedChatId;

        // pre-register a workspace chat ID to secure it in the DB
        aibitat.onMessage((message) => {
          ensureTrackedChatId(message).catch(() => {});
        });

        aibitat.onMessage(async () => {
          try {
            if (aibitat._aborted) return;
            const lastResponses = aibitat.chats.slice(-2);
            if (lastResponses.length !== 2) return;
            const [prev, last] = lastResponses;

            // We need a full conversation reply with prev being from
            // the USER and the last being from anyone other than the user.
            if (prev.from !== "USER" || last.from === "USER") return;
            aibitat._terminalTurnPending = true;

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
              await this._storeSpecial(aibitat, {
                prompt,
                response: last.content,
                attachments,
                imageAnalysis,
                options: aibitat._replySpecialAttributes,
              });
              delete aibitat._replySpecialAttributes;
              return;
            }

            await this._store(aibitat, {
              prompt,
              response: last.content,
              attachments,
              imageAnalysis,
            });
          } catch (error) {
            console.warn("[AgentChatHistory] failed to persist agent chat", {
              message: error.message,
              invocationUuid: aibitat.handlerProps?.invocation?.uuid || null,
              workspaceId:
                aibitat.handlerProps?.invocation?.workspace_id || null,
              trackedChatId: aibitat.trackedChatId || null,
            });
            this._cleanup(aibitat);
            aibitat._terminalTurnPending = false;
            aibitat.terminate();
          }
        });
      },
      _store: async function (
        aibitat,
        { prompt, response, attachments = [], imageAnalysis = null } = {}
      ) {
        const metrics = aibitat.provider?.getUsage?.() ?? {};
        const citations = aibitat._pendingCitations ?? [];
        const outputs = aibitat._pendingOutputs ?? [];
        const clarifyingQuestions =
          aibitat._pendingClarifyingQuestionSurveys ?? [];
        const agentEvents = compactAgentEvents(aibitat._agentEvents ?? []);
        const storedResponse = {
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
              aibitat.handlerProps?.invocation?.workspace?.chatProvider ||
              process.env.LLM_PROVIDER ||
              null,
          }),
          ...(imageAnalysis ? { imageAnalysis } : {}),
          ...(outputs.length > 0 ? { outputs } : {}),
          ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
          ...(agentEvents.length > 0 ? { agentEvents } : {}),
        };
        const persistence = this._persistFinal(aibitat, {
          prompt,
          response: storedResponse,
        });
        this._cleanup(aibitat);
        aibitat._terminalTurnPending = false;
        aibitat.terminate?.();
        await persistence;
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
        const metrics = aibitat.provider?.getUsage?.() ?? {};
        const citations = aibitat._pendingCitations ?? [];
        const outputs = aibitat._pendingOutputs ?? [];
        const clarifyingQuestions =
          aibitat._pendingClarifyingQuestionSurveys ?? [];
        const agentEvents = compactAgentEvents(aibitat._agentEvents ?? []);
        const existingSources = options?.sources ?? [];
        const storedResponse = {
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
              aibitat.handlerProps?.invocation?.workspace?.chatProvider ||
              process.env.LLM_PROVIDER ||
              null,
          }),
          ...(imageAnalysis ? { imageAnalysis } : {}),
          ...(outputs.length > 0 ? { outputs } : {}),
          ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
          ...(agentEvents.length > 0 ? { agentEvents } : {}),
        };
        const persistence = this._persistFinal(aibitat, {
          prompt,
          response: storedResponse,
        });
        this._cleanup(aibitat);
        aibitat._terminalTurnPending = false;
        aibitat.terminate?.();
        await persistence;
        options?.postSave();
      },

      _persistFinal: async function (aibitat, { prompt, response } = {}) {
        const invocation = aibitat.handlerProps.invocation;
        if (!aibitat.trackedChatId) {
          await aibitat.ensureTrackedChatId?.({
            from: "USER",
            content: prompt,
          });
        }
        if (!aibitat.trackedChatId)
          throw new Error("agent_chat_reservation_missing");

        if (remoteAgentChatPersistenceEnabled()) {
          const persisted = await finalizeAgentChatTurn({
            chatId: aibitat.trackedChatId,
            reservationId: aibitat.trackedChatId,
            publicChatId: aibitat.trackedPublicChatId || null,
            workspaceId: Number(invocation.workspace_id),
            prompt,
            response,
            userId: invocation?.user_id || null,
            threadId: invocation?.thread_id || null,
            clientTurnId: invocation?.clientTurnId || null,
            renameThread: !aibitat._threadRenamed,
          });
          const savedChat = persisted?.chat || null;
          if (savedChat?.id)
            aibitat.registerChatId(savedChat.id, savedChat.publicId || null);
          aibitat._threadRenamed = true;
          return;
        }

        const persisted = await WorkspaceChats.upsert(aibitat.trackedChatId, {
          workspaceId: Number(invocation.workspace_id),
          prompt,
          response,
          user: { id: invocation?.user_id || null },
          threadId: invocation?.thread_id || null,
          include: true,
          clientTurnId: invocation?.clientTurnId || null,
          sourceChannel: "agent",
        });
        if (persisted?.chat === null)
          throw new Error(persisted.message || "agent_chat_persistence_failed");
        await publishAgentChatFinalized(aibitat, aibitat.trackedChatId);
        if (!aibitat._threadRenamed) {
          aibitat._threadRenamed = await this._autoRenameThread(
            aibitat,
            prompt
          );
        }
      },

      _autoRenameThread: async function (aibitat) {
        const invocation = aibitat.handlerProps.invocation;
        if (!invocation?.thread_id) return true;

        await maybeEnqueueTitleGenerationAfterChat({
          workspaceId: invocation.workspace_id,
          threadId: invocation.thread_id,
          userId: invocation.user_id || null,
          include: true,
          apiSessionId: null,
          onTitle: (updatedThread) => {
            aibitat.socket?.send("rename_thread", {
              slug: updatedThread.slug,
              name: updatedThread.name,
              title: updatedThread.title || updatedThread.name,
              titleVersion: updatedThread.titleVersion,
              animate: true,
            });
          },
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
