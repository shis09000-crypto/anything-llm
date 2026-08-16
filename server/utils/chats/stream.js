const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const WorkspaceChats = lazyDataAccessFacade("workspaceChat");
const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const WorkspaceParsedFiles = lazyDataAccessFacade("workspaceParsedFile");
const UserMemory = lazyDataAccessFacade("userMemory");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { enrichOperationContext } = require("../observability/operationContext");
const { grepAgents } = require("./agents");
const {
  shouldBypassAutomaticAgentRouting,
} = require("./automaticAgentRouting");
const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  sourceIdentifier,
  cacheStableHistoryStrategyFor,
} = require("./index");
const {
  contextTextsWithCompaction,
  maybeAutoCompact,
  recentChatHistoryWithCompaction,
} = require("./threadCompaction");
const { publishWorkspaceSyncEvent } = require("./workspaceSyncEvents");
const {
  resolveGraphContext,
} = require("../knowledgeGraph/graphContextResolver");
const {
  prepareImageAnalysisContext,
  shouldUseVisionTool,
} = require("../vision/viewTool");
const { appendCurrentDateTimeToPrompt } = require("./currentDateTimeContext");
const {
  appendUserPersonalizationToSystemPrompt,
} = require("./personalizationContext");
const {
  appendUserLongTermMemoryToSystemPromptWithState,
} = require("./longTermMemoryContext");
const {
  SAVE_MEMORY_TOOL_NAME,
  SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION,
  approvalPayloadForMemory,
  executeSaveMemoryTool,
  normalizeSaveMemoryArgs,
  saveMemoryToolCallFrom,
  saveMemoryToolsForMessage,
  toolCallEventFrom,
} = require("./saveMemoryTool");
const { requestChatToolApproval } = require("./toolApproval");
const { promptForHistory } = require("./displayPrompt");
const { hydrateIncomingAttachments } = require("../contentObjects/chatPayload");
const { beginModelExecution } = require("../aiGovernance");
const {
  finalizedTurnPersister,
  hotTurnBuffer,
  scopeKey: hotTurnScopeKey,
} = require("./hotTurnBuffer");

const VALID_CHAT_MODE = ["automatic", "chat", "query"];

function logRecoverableChatError(stage, error, context = {}) {
  console.warn("[ChatResilience] recoverable failure", {
    stage,
    message: error?.message || String(error),
    ...context,
  });
}

function emptyVectorSearchResult(message = null) {
  return {
    contextTexts: [],
    sources: [],
    message,
  };
}

function promptCacheDiagnosticsFor(
  llm,
  messages = [],
  historyWindow = null,
  compaction = null
) {
  if (!llm?.cacheStableHistory) return {};
  if (typeof llm.promptCacheDiagnostics !== "function") return {};
  return {
    promptCacheDiagnostics: llm.promptCacheDiagnostics(messages, {
      historyWindow,
      compaction,
    }),
  };
}

function withPromptCacheDiagnostics(metrics = {}, diagnostics = {}) {
  if (!diagnostics?.promptCacheDiagnostics) return metrics || {};
  return {
    ...(metrics || {}),
    ...diagnostics,
  };
}

function shouldExposeSaveMemoryTool({ llm = null, message = "", user = null }) {
  if (!user?.id) return false;
  if (llm?.className !== "DeepSeekLLM") return false;
  return saveMemoryToolsForMessage(message).length > 0;
}

async function handleSaveMemoryToolCall({
  response,
  uuid,
  user,
  userMessage,
  toolCall,
}) {
  const args = normalizeSaveMemoryArgs(toolCall?.function?.arguments || {});
  const memoryOwnerId = UserMemory.memoryOwnerIdFromSessionUser(user);
  writeResponseChunk(response, toolCallEventFrom(toolCall, args));
  const approval = await requestChatToolApproval({
    response,
    userId: user?.id,
    skillName: SAVE_MEMORY_TOOL_NAME,
    payload: approvalPayloadForMemory(args),
    description: `保存长期记忆：${args.title}`,
    allowAlwaysAllow: false,
  });

  writeResponseChunk(response, {
    type: "timeline_event",
    event: {
      type: "approval_result",
      requestId: approval.requestId,
      skillName: SAVE_MEMORY_TOOL_NAME,
      approved: Boolean(approval.approved),
      reason: approval.reason || null,
    },
  });

  if (!approval.approved) {
    const textResponse = "已取消保存记忆。";
    writeResponseChunk(response, {
      uuid,
      type: "toolCallResult",
      toolName: SAVE_MEMORY_TOOL_NAME,
      arguments: approvalPayloadForMemory(args),
      result: { success: false, cancelled: true },
      content: textResponse,
    });
    return { textResponse, memory: null };
  }

  const result = await executeSaveMemoryTool({
    memoryOwnerId,
    userMessage,
    args,
  });
  const textResponse = `已记住：${result.title}`;
  writeResponseChunk(response, {
    uuid,
    type: "toolCallResult",
    toolName: SAVE_MEMORY_TOOL_NAME,
    arguments: approvalPayloadForMemory(args),
    result,
    content: textResponse,
  });
  return { textResponse, memory: result };
}

async function streamChatWithWorkspace(
  response,
  workspace,
  message,
  chatMode = "automatic",
  user = null,
  thread = null,
  attachments = [],
  options = {}
) {
  enrichOperationContext({
    clientTurnId: options.clientTurnId || null,
    timeZone: options.timeZone || null,
    workspaceId: workspace?.id || null,
    threadId: thread?.id || null,
    journey: "chat",
  });
  const uuid = uuidv4();
  const syncEvent = options.syncEvent || null;
  let updatedMessage = await grepCommand(message, user);
  const displayMessage = promptForHistory({
    message,
    displayPrompt: options.displayPrompt,
  });
  attachments = await hydrateIncomingAttachments({
    attachments,
    scope: {
      workspaceId: workspace.id,
      userId: user?.id || null,
      threadId: thread?.id || null,
      apiSessionId: null,
    },
  });

  if (Object.keys(VALID_COMMANDS).includes(updatedMessage)) {
    const data = await VALID_COMMANDS[updatedMessage](
      workspace,
      message,
      uuid,
      user,
      thread
    );
    writeResponseChunk(response, data);
    return;
  }

  const historyAttachments = attachments;
  let llmAttachments = attachments;
  let imageAnalysisContext = null;
  let imageAnalysisText = null;
  try {
    const willUseVisionTool = shouldUseVisionTool(attachments);
    if (willUseVisionTool) {
      writeResponseChunk(response, {
        id: uuid,
        type: "statusResponse",
        textResponse: "正在调用视觉模型分析图片，请稍候...",
        sources: [],
        close: false,
        error: null,
        animate: true,
      });
    }
    const imageAnalysis = await prepareImageAnalysisContext({ attachments });
    if (imageAnalysis.used) {
      imageAnalysisContext = imageAnalysis.contextText;
      imageAnalysisText = imageAnalysis.analysisText || imageAnalysisContext;
      llmAttachments = imageAnalysis.llmAttachments;
      writeResponseChunk(response, {
        id: uuid,
        type: "statusResponse",
        textResponse: "视觉模型分析完成，正在继续会话...",
        sources: [],
        close: false,
        error: null,
        animate: true,
      });
    }
  } catch (error) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: error.message,
    });
    return;
  }

  const agentMessage = imageAnalysisContext
    ? `${updatedMessage}\n\n${imageAnalysisContext}`
    : updatedMessage;

  // If is agent enabled chat we will exit this flow early.
  const isAgentChat = await grepAgents({
    uuid,
    response,
    message: agentMessage,
    user,
    workspace,
    thread,
    attachments: llmAttachments,
    displayAttachments: historyAttachments,
    displayPrompt: displayMessage,
    visionAnalysisContext: imageAnalysisText,
    fileAccess: options.fileAccess || {},
    clientTurnId: options.clientTurnId || null,
  });
  if (isAgentChat) return;

  const socialChatFastPath = shouldBypassAutomaticAgentRouting(agentMessage);

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
  const VectorDb = socialChatFastPath ? null : getVectorDbClass();

  const messageLimit = workspace?.openAiHistory || 20;
  const historyStrategy = cacheStableHistoryStrategyFor({
    llm: LLMConnector,
    messageLimit,
  });
  let hasVectorizedSpace = false;
  let embeddingsCount = 0;
  if (!socialChatFastPath) {
    try {
      hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
      embeddingsCount = await VectorDb.namespaceCount(workspace.slug);
    } catch (error) {
      logRecoverableChatError("vector.namespace_status", error, {
        workspaceSlug: workspace.slug,
      });
    }
  }

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      attachments: historyAttachments,
      close: false,
      error: null,
    });
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: displayMessage,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments: historyAttachments,
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      include: false,
      user,
      clientTurnId: options.clientTurnId || null,
    });
    if (syncEvent) {
      publishWorkspaceSyncEvent({
        ...syncEvent,
        type: "chat_finalized",
        chatId: chat?.id || null,
        publicChatId: chat?.public_id || null,
        clientTurnId: options.clientTurnId || null,
      });
    }
    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      chatId: chat?.id || null,
      publicChatId: chat?.public_id || null,
      clientTurnId: options.clientTurnId || null,
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText;
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  let rawHistory = [];
  let chatHistory = [];
  let compaction = null;
  let historyWindow = null;
  try {
    const history = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit,
      historyStrategy,
    });
    rawHistory = history.rawHistory || [];
    chatHistory = history.chatHistory || [];
    compaction = history.compaction || null;
    historyWindow = history.historyWindow || null;

    const persistedTurnIds = rawHistory
      .map((entry) => entry?.clientTurnId)
      .filter(Boolean);
    const hotTurns = hotTurnBuffer.pendingForScope(
      {
        workspaceId: workspace.id,
        threadId: thread?.id || null,
        userId: user?.id || null,
      },
      { persistedClientTurnIds: persistedTurnIds }
    );
    for (const hotTurn of hotTurns) {
      chatHistory.push(
        { role: "user", content: hotTurn.prompt },
        { role: "assistant", content: hotTurn.response }
      );
    }
  } catch (error) {
    logRecoverableChatError("recent_chat_history", error, {
      workspaceSlug: workspace.slug,
      threadId: thread?.id || null,
    });
  }

  // Look for pinned documents and see if the user decided to use this feature. We will also do a vector search
  // as pinning is a supplemental tool but it should be used with caution since it can easily blow up a context window.
  // However we limit the maximum of appended context to 80% of its overall size, mostly because if it expands beyond this
  // it will undergo prompt compression anyway to make it work. If there is so much pinned that the context here is bigger than
  // what the model can support - it would get compressed anyway and that really is not the point of pinning. It is really best
  // suited for high-context models.
  if (!socialChatFastPath) {
    try {
      await new DocumentManager({
        workspace,
        maxTokens: LLMConnector.promptWindowLimit(),
      })
        .pinnedDocs()
        .then((pinnedDocs) => {
          pinnedDocs.forEach((doc) => {
            const { pageContent, ...metadata } = doc;
            pinnedDocIdentifiers.push(sourceIdentifier(doc));
            contextTexts.push(doc.pageContent);
            sources.push({
              text:
                pageContent.slice(0, 1_000) +
                "...continued on in source document...",
              ...metadata,
            });
          });
        });
    } catch (error) {
      logRecoverableChatError("pinned_docs", error, {
        workspaceSlug: workspace.slug,
      });
    }
  }

  // Inject any parsed files for this workspace/thread/user
  const parsedFiles = socialChatFastPath
    ? []
    : await WorkspaceParsedFiles.getContextFiles(
        workspace,
        thread || null,
        user || null
      ).catch((error) => {
        logRecoverableChatError("parsed_files", error, {
          workspaceSlug: workspace.slug,
          threadId: thread?.id || null,
        });
        return [];
      });
  parsedFiles.forEach((doc) => {
    const { pageContent, ...metadata } = doc;
    contextTexts.push(doc.pageContent);
    sources.push({
      text:
        pageContent.slice(0, 1_000) + "...continued on in source document...",
      ...metadata,
    });
  });

  if (options.nodeContext?.nodeKey || options.nodeContext?.nodeId) {
    try {
      const graphContext = await resolveGraphContext({
        workspace,
        user,
        nodeKey: options.nodeContext?.nodeKey,
        nodeId: options.nodeContext?.nodeId,
        intent: "explain",
        query: updatedMessage,
        budget: {
          supplementChunks: Math.min(4, workspace?.topN || 4),
          originalChunks: Math.min(4, workspace?.topN || 4),
          vectorChunks: 0,
          contextChars: 8_000,
        },
      });
      if (graphContext.contextText)
        contextTexts.unshift(graphContext.contextText);
      sources = [...(graphContext.sourceRefs || []), ...sources];
    } catch (error) {
      logRecoverableChatError("graph_context", error, {
        workspaceSlug: workspace.slug,
        nodeKey: options.nodeContext?.nodeKey || null,
        nodeId: options.nodeContext?.nodeId || null,
      });
    }
  }

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: updatedMessage,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        }).catch((error) => {
          logRecoverableChatError("vector_similarity_search", error, {
            workspaceSlug: workspace.slug,
            chatMode,
          });
          return emptyVectorSearchResult(
            "Failed to connect to vector database provider."
          );
        })
      : emptyVectorSearchResult();

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message && chatMode === "query") {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
    });
    return;
  } else if (!!vectorSearchResults.message) {
    logRecoverableChatError("vector_similarity_search_degraded", {
      message: vectorSearchResults.message,
    });
  }

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [...contextTexts, ...filledSources.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];

  if (imageAnalysisContext) contextTexts.unshift(imageAnalysisContext);

  // If in query mode and no context chunks are found from search, backfill, or pins -  do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && contextTexts.length === 0) {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
    });

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: displayMessage,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments: historyAttachments,
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      include: false,
      user,
      clientTurnId: options.clientTurnId || null,
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  let systemPrompt = await appendUserPersonalizationToSystemPrompt(
    await chatPrompt(workspace, user),
    user
  );
  const longTermMemoryContext =
    await appendUserLongTermMemoryToSystemPromptWithState(systemPrompt, user);
  systemPrompt = longTermMemoryContext.systemPrompt;
  const deepSeekThinkingMode = longTermMemoryContext.injected
    ? "enabled"
    : "disabled";
  const exposeSaveMemoryTool = shouldExposeSaveMemoryTool({
    llm: LLMConnector,
    message: updatedMessage,
    user,
  });
  if (exposeSaveMemoryTool) {
    systemPrompt = `${systemPrompt}\n\n${SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION}`;
  }
  const autoCompaction = socialChatFastPath
    ? null
    : await maybeAutoCompact({
        workspace,
        user,
        thread,
        llm: LLMConnector,
        systemPrompt,
        chatHistory,
        userPrompt: updatedMessage,
        contextTexts,
        attachments: llmAttachments,
        compaction,
      });
  if (autoCompaction?.compactionId) {
    const nextHistory = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit,
      historyStrategy,
    }).catch((error) => {
      logRecoverableChatError("post_compaction_history_refresh", error, {
        workspaceSlug: workspace.slug,
      });
      return { rawHistory, chatHistory, compaction };
    });
    rawHistory = nextHistory.rawHistory;
    chatHistory = nextHistory.chatHistory;
    compaction = nextHistory.compaction;
    historyWindow = nextHistory.historyWindow || null;
  }

  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt: appendCurrentDateTimeToPrompt(updatedMessage, {
        timeZone: options.timeZone,
      }),
      contextTexts: contextTextsWithCompaction(contextTexts, compaction),
      chatHistory,
      attachments: llmAttachments,
    },
    rawHistory
  );
  const promptCacheDiagnostics = promptCacheDiagnosticsFor(
    LLMConnector,
    messages,
    historyWindow,
    compaction
  );
  const lockedExecution = {
    model: workspace?.chatModel || LLMConnector?.model || null,
    provider: workspace?.chatProvider || process.env.LLM_PROVIDER || null,
  };
  const modelExecution = await beginModelExecution(
    {
      ownerType: "workspace",
      ownerId: String(workspace.id),
      userId: user?.id || null,
      workspaceId: workspace.id,
      taskType: "workspace_chat",
      provider: workspace?.chatProvider,
      model: workspace?.chatModel,
    },
    { messages, toolCalls: exposeSaveMemoryTool ? 1 : 0 }
  );

  // If streaming is not explicitly enabled for connector
  // we do regular waiting of a response and send a single chunk.
  try {
    if (LLMConnector.streamingEnabled() !== true) {
      console.log(
        `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
      );
      const { textResponse, metrics: performanceMetrics } =
        await LLMConnector.getChatCompletion(messages, {
          temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
          user: user,
          thinking: deepSeekThinkingMode,
          runtimeContext: {
            workspaceId: workspace.id,
            threadId: thread?.id || null,
            userId: user?.id || null,
            chatRunId: options.clientTurnId || uuid,
            clientTurnId: options.clientTurnId || null,
            taskPriority: "P0",
            taskIntent: "foreground_chat",
          },
        });

      completeText = textResponse;
      metrics = withPromptCacheDiagnostics(
        performanceMetrics,
        promptCacheDiagnostics
      );
      writeResponseChunk(response, {
        uuid,
        sources,
        type: "textResponseChunk",
        textResponse: completeText,
        close: false,
        error: false,
        metrics,
      });
    } else {
      const stream = await LLMConnector.streamGetChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user: user,
        thinking: deepSeekThinkingMode,
        runtimeContext: {
          workspaceId: workspace.id,
          threadId: thread?.id || null,
          userId: user?.id || null,
          chatRunId: options.clientTurnId || uuid,
          clientTurnId: options.clientTurnId || null,
          taskPriority: "P0",
          taskIntent: "foreground_chat",
        },
        ...(exposeSaveMemoryTool
          ? {
              tools: saveMemoryToolsForMessage(updatedMessage),
              toolChoice: "auto",
            }
          : {}),
      });
      completeText = await LLMConnector.handleStream(response, stream, {
        uuid,
        sources,
      });
      metrics = withPromptCacheDiagnostics(
        stream.metrics,
        promptCacheDiagnostics
      );
      stream.metrics = metrics;

      const saveMemoryToolCall = saveMemoryToolCallFrom(stream.toolCalls);
      if (saveMemoryToolCall) {
        try {
          const toolResult = await handleSaveMemoryToolCall({
            response,
            uuid,
            user,
            userMessage: updatedMessage,
            toolCall: saveMemoryToolCall,
          });
          completeText = toolResult.textResponse;
        } catch (error) {
          completeText = `记忆保存失败：${error.message}`;
          writeResponseChunk(response, {
            uuid,
            type: "toolCallResult",
            toolName: SAVE_MEMORY_TOOL_NAME,
            arguments: {},
            result: { success: false, error: error.message },
            content: completeText,
          });
        }
      }
    }
  } catch (error) {
    await modelExecution.fail(error);
    throw error;
  }
  const settleModelExecution = () =>
    modelExecution
      .settle(metrics, {
        transport: "web-stream",
        chatMode,
      })
      .catch((error) =>
        logRecoverableChatError("model_execution_settle", error, {
          workspaceSlug: workspace.slug,
          threadId: thread?.id || null,
        })
      );

  if (completeText?.length > 0) {
    const clientTurnId = String(options.clientTurnId || "").trim() || null;
    const responsePayload = {
      text: completeText,
      sources,
      type: chatMode,
      attachments: historyAttachments,
      metrics,
      execution: require("./executionMetadata").executionMetadata({
        metrics,
        ...lockedExecution,
      }),
      ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
    };
    const persistenceInput = {
      workspaceId: workspace.id,
      prompt: displayMessage,
      response: responsePayload,
      threadId: thread?.id || null,
      user,
      clientTurnId,
    };
    const hotStage = hotTurnBuffer.stage({
      workspaceId: workspace.id,
      threadId: thread?.id || null,
      userId: user?.id || null,
      clientTurnId,
      prompt: displayMessage,
      response: completeText,
      metadata: { chatMode },
    });

    if (hotStage.accepted) {
      writeResponseChunk(response, {
        uuid,
        type: "finalizeResponseStream",
        // The terminal frame doubles as an authoritative snapshot. This
        // closes the race where completion arrives before the browser paints
        // its last throttled delta batch.
        textResponse: completeText,
        close: false,
        error: false,
        clientTurnId,
        persistenceStatus: "pending",
        metrics,
      });

      const persistenceKey = hotTurnScopeKey({
        workspaceId: workspace.id,
        threadId: thread?.id || null,
        userId: user?.id || null,
      });
      const persist = async () => {
        hotTurnBuffer.updateStatus(clientTurnId, "persisting");
        let lastError = null;
        for (const delayMs of [0, 250, 1_000, 4_000]) {
          if (delayMs)
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          try {
            const result = await WorkspaceChats.new(persistenceInput);
            if (!result?.chat) throw new Error("chat_history_save_empty");
            return result.chat;
          } catch (error) {
            lastError = error;
            hotTurnBuffer.updateStatus(clientTurnId, "retrying");
            logRecoverableChatError("chat_history_save_retry", error, {
              workspaceSlug: workspace.slug,
              threadId: thread?.id || null,
            });
          }
        }
        throw lastError || new Error("chat_history_save_failed");
      };

      try {
        const chat = await finalizedTurnPersister.enqueue(
          persistenceKey,
          persist
        );
        hotTurnBuffer.delete(clientTurnId);
        void settleModelExecution();
        if (syncEvent) {
          publishWorkspaceSyncEvent({
            ...syncEvent,
            type: "chat_finalized",
            chatId: chat.id,
            publicChatId: chat.public_id || null,
            clientTurnId,
          });
        }
        writeResponseChunk(response, {
          uuid,
          type: "chatPersistence",
          close: true,
          clientTurnId,
          status: "saved",
          chatId: chat.id,
          publicChatId: chat.public_id || null,
          metrics,
        });
        maybeAutoCompact({
          workspace,
          user,
          thread,
          llm: LLMConnector,
          systemPrompt,
          chatHistory: [
            ...chatHistory,
            { role: "user", content: updatedMessage },
            { role: "assistant", content: completeText },
          ],
          userPrompt: "",
          contextTexts,
          attachments: llmAttachments,
          compaction,
          historyPressureLimit: historyWindow?.historyPressureLimit || null,
          phase: "turn_end",
        }).catch((error) =>
          console.warn(
            "[ThreadCompaction] turn-end auto compact failed",
            error.message
          )
        );
      } catch (error) {
        hotTurnBuffer.updateStatus(clientTurnId, "failed");
        logRecoverableChatError("chat_history_save_failed", error, {
          workspaceSlug: workspace.slug,
          threadId: thread?.id || null,
        });
        void settleModelExecution();
        writeResponseChunk(response, {
          uuid,
          type: "chatPersistence",
          close: true,
          clientTurnId,
          status: "failed",
          errorCode: "chat_persistence_failed",
          metrics,
        });
        void (async () => {
          for (const delayMs of [15_000, 30_000, 60_000, 120_000, 240_000]) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (!hotTurnBuffer.entries.has(clientTurnId)) return;
            try {
              const chat = await finalizedTurnPersister.enqueue(
                persistenceKey,
                async () => {
                  const result = await WorkspaceChats.new(persistenceInput);
                  if (!result?.chat) throw new Error("chat_history_save_empty");
                  return result.chat;
                }
              );
              hotTurnBuffer.delete(clientTurnId);
              if (syncEvent) {
                publishWorkspaceSyncEvent({
                  ...syncEvent,
                  type: "chat_finalized",
                  chatId: chat.id,
                  publicChatId: chat.public_id || null,
                  clientTurnId,
                });
              }
              return;
            } catch (retryError) {
              hotTurnBuffer.updateStatus(clientTurnId, "retrying");
              logRecoverableChatError(
                "chat_history_background_retry",
                retryError,
                {
                  workspaceSlug: workspace.slug,
                  threadId: thread?.id || null,
                }
              );
            }
          }
        })();
      }
      return;
    }

    await settleModelExecution();
    const { chat } = await WorkspaceChats.new(persistenceInput).catch(
      (error) => {
        logRecoverableChatError("chat_history_save", error, {
          workspaceSlug: workspace.slug,
          threadId: thread?.id || null,
        });
        return { chat: null };
      }
    );
    if (syncEvent) {
      publishWorkspaceSyncEvent({
        ...syncEvent,
        type: "chat_finalized",
        chatId: chat?.id || null,
        publicChatId: chat?.public_id || null,
        clientTurnId,
      });
    }

    maybeAutoCompact({
      workspace,
      user,
      thread,
      llm: LLMConnector,
      systemPrompt,
      chatHistory: [
        ...chatHistory,
        { role: "user", content: updatedMessage },
        { role: "assistant", content: completeText },
      ],
      userPrompt: "",
      contextTexts,
      attachments: llmAttachments,
      compaction,
      historyPressureLimit: historyWindow?.historyPressureLimit || null,
      phase: "turn_end",
    }).catch((error) =>
      console.warn(
        "[ThreadCompaction] turn-end auto compact failed",
        error.message
      )
    );

    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      chatId: chat?.id || null,
      publicChatId: chat?.public_id || null,
      clientTurnId,
      metrics,
    });
    return;
  }

  await settleModelExecution();

  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
    clientTurnId: options.clientTurnId || null,
    metrics,
  });
  return;
}

module.exports = {
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
