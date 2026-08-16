const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const WorkspaceChats = lazyDataAccessFacade("workspaceChat");
const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const {
  chatPrompt,
  sourceIdentifier,
  grepAllSlashCommands,
  cacheStableHistoryStrategyFor,
} = require("./index");
const {
  contextTextsWithCompaction,
  maybeAutoCompact,
  recentChatHistoryWithCompaction,
} = require("./threadCompaction");
const {
  EphemeralAgentHandler,
  EphemeralEventListener,
} = require("../agents/ephemeral");
const {
  TelemetryRepository: Telemetry,
} = require("../../repositories/telemetryRepository");
const { CollectorApi } = require("../collectorApi");
const fs = require("fs");
const path = require("path");
const {
  hotdirPath,
  normalizePath,
  isWithin,
  sanitizeFileName,
} = require("../files");
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
  SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION,
  hasExplicitMemoryIntent,
  saveMemoryToolCallFrom,
  saveMemoryToolsForMessage,
} = require("./saveMemoryTool");
const { hydrateIncomingAttachments } = require("../contentObjects/chatPayload");
const { beginModelExecution } = require("../aiGovernance");

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

function shouldExposeSaveMemoryTool({ llm, message, user }) {
  return (
    !!user?.id &&
    llm?.className === "DeepSeekLLM" &&
    hasExplicitMemoryIntent(message)
  );
}
/**
 * @typedef ResponseObject
 * @property {string} id - uuid of response
 * @property {string} type - Type of response
 * @property {string|null} textResponse - full text response
 * @property {object[]} sources
 * @property {boolean} close
 * @property {string|null} error
 * @property {object} metrics
 */

/**
 * Users can pass in documents as attachments to the chat API.
 * The name of the document is the name of the attachment and must include the file extension.
 * the mime type for documents is `application/anythingllm-document` - anything else is assumed to be an image.
 * @param {{name: string, mime: string, contentString: string}[]} attachments
 * @returns {Promise<{parsedDocuments: Object[], imageAttachments: {name: string; mime: string; contentString: string}[]}>}
 */
async function processDocumentAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0)
    return { parsedDocuments: [], imageAttachments: [] };
  const documentAttachments = [];
  const imageAttachments = [];
  for (const attachment of attachments) {
    if (
      attachment &&
      attachment.contentString &&
      attachment.mime &&
      attachment.mime.toLowerCase() === "application/anythingllm-document"
    )
      documentAttachments.push(attachment);
    else imageAttachments.push(attachment);
  }

  if (documentAttachments.length === 0)
    return { parsedDocuments: [], imageAttachments };
  const Collector = new CollectorApi();
  const processingOnline = await Collector.online();
  if (!processingOnline) {
    console.warn(
      "Collector API is not online, skipping document attachment processing"
    );
    return { parsedDocuments: [], imageAttachments };
  }
  if (!fs.existsSync(hotdirPath)) fs.mkdirSync(hotdirPath, { recursive: true });

  const parsedDocuments = [];
  for (const attachment of documentAttachments) {
    try {
      let base64Data = attachment.contentString;
      const dataUriMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
      if (dataUriMatch) base64Data = dataUriMatch[1];

      const buffer = Buffer.from(base64Data, "base64");
      const filename = sanitizeFileName(
        normalizePath(attachment.name || `attachment-${uuidv4()}`)
      );
      const filePath = normalizePath(path.join(hotdirPath, filename));
      if (!isWithin(hotdirPath, filePath))
        throw new Error(`Invalid file path for attachment ${filename}`);
      fs.writeFileSync(filePath, buffer);

      const { success, reason, documents } =
        await Collector.parseDocument(filename);
      if (success && documents?.length > 0) parsedDocuments.push(...documents);
      else console.warn(`Failed to parse attachment ${filename}:`, reason);
    } catch (error) {
      console.error(
        `Error processing attachment ${attachment.name}:`,
        error.message
      );
    }
  }

  return { parsedDocuments, imageAttachments };
}

/**
 * Handle synchronous chats with your workspace via the developer API endpoint
 * @param {{
 *  workspace: import("@prisma/client").workspaces,
 *  message:string,
 *  mode: "automatic"|"chat"|"query",
 *  user: import("@prisma/client").users|null,
 *  thread: import("@prisma/client").workspace_threads|null,
 *  sessionId: string|null,
 *  attachments: { name: string; mime: string; contentString: string }[],
 *  reset: boolean,
 * }} parameters
 * @returns {Promise<ResponseObject>}
 */
async function chatSync({
  workspace,
  message = null,
  mode = null,
  user = null,
  thread = null,
  sessionId = null,
  attachments = [],
  reset = false,
}) {
  const uuid = uuidv4();
  const chatMode = mode ?? workspace?.chatMode ?? "automatic";
  attachments = await hydrateIncomingAttachments({
    attachments,
    scope: {
      workspaceId: workspace.id,
      userId: user?.id || null,
      threadId: thread?.id || null,
      apiSessionId: sessionId,
    },
  });

  // If the user wants to reset the chat history we do so pre-flight
  // and continue execution. If no message is provided then the user intended
  // to reset the chat history only and we can exit early with a confirmation.
  if (reset) {
    await WorkspaceChats.markThreadHistoryInvalidV2({
      workspaceId: workspace.id,
      user_id: user?.id,
      thread_id: thread?.id,
      api_session_id: sessionId,
    });
    if (!message?.length) {
      return {
        id: uuid,
        type: "textResponse",
        textResponse: "Chat history was reset!",
        sources: [],
        close: true,
        error: null,
        metrics: {},
      };
    }
  }

  // Process slash commands
  // Since preset commands are not supported in API calls, we can just process the message here
  const processedMessage = await grepAllSlashCommands(message);
  message = processedMessage;

  const historyAttachments = attachments;
  let imageAnalysisContext = null;
  let imageAnalysisText = null;
  let agentAttachments = attachments;
  try {
    const imageAnalysis = await prepareImageAnalysisContext({ attachments });
    if (imageAnalysis.used) {
      imageAnalysisContext = imageAnalysis.contextText;
      imageAnalysisText = imageAnalysis.analysisText || imageAnalysisContext;
      agentAttachments = imageAnalysis.llmAttachments;
    }
  } catch (error) {
    return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: error.message,
      metrics: {},
    };
  }

  const agentMessage = imageAnalysisContext
    ? `${message}\n\n${imageAnalysisContext}`
    : message;

  if (
    await EphemeralAgentHandler.isAgentInvocation({
      message: agentMessage,
      workspace,
      chatMode,
    })
  ) {
    await Telemetry.sendTelemetry("agent_chat_started");

    // Initialize the EphemeralAgentHandler to handle non-continuous
    // conversations with agents since this is over REST.
    const agentHandler = new EphemeralAgentHandler({
      uuid,
      workspace,
      prompt: agentMessage,
      userId: user?.id || null,
      threadId: thread?.id || null,
      sessionId,
      attachments: agentAttachments,
    });

    // Establish event listener that emulates websocket calls
    // in Aibitat so that we can keep the same interface in Aibitat
    // but use HTTP.
    const eventListener = new EphemeralEventListener();
    await agentHandler.init();
    await agentHandler.createAIbitat({ handler: eventListener });
    agentHandler.startAgentCluster();

    // The cluster has started and now we wait for close event since
    // this is a synchronous call for an agent, so we return everything at once.
    // After this, we conclude the call as we normally do.
    return await eventListener
      .waitForClose()
      .then(async ({ thoughts, textResponse }) => {
        await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: String(message),
          response: {
            text: textResponse,
            sources: [],
            attachments: historyAttachments,
            type: chatMode,
            thoughts,
            ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
          },
          include: false,
          apiSessionId: sessionId,
        });
        return {
          id: uuid,
          type: "textResponse",
          sources: [],
          close: true,
          error: null,
          textResponse,
          thoughts,
        };
      });
  }

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
  if (shouldExposeSaveMemoryTool({ llm: LLMConnector, message, user })) {
    const textResponse = "保存长期记忆需要前端确认，API 请求未写入记忆。";
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: String(message),
      response: {
        text: textResponse,
        sources: [],
        attachments: historyAttachments,
        type: chatMode,
        metrics: {},
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      include: false,
      apiSessionId: sessionId,
      user,
    });

    return {
      id: uuid,
      type: "textResponse",
      sources: [],
      close: true,
      error: null,
      textResponse,
      metrics: {},
    };
  }
  const VectorDb = getVectorDbClass();
  const messageLimit = workspace?.openAiHistory || 20;
  const historyStrategy = cacheStableHistoryStrategyFor({
    llm: LLMConnector,
    messageLimit,
  });
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: String(message),
      response: {
        text: textResponse,
        sources: [],
        attachments: historyAttachments,
        type: chatMode,
        metrics: {},
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      include: false,
      apiSessionId: sessionId,
    });

    return {
      id: uuid,
      type: "textResponse",
      sources: [],
      close: true,
      error: null,
      textResponse,
      metrics: {},
    };
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  let { rawHistory, chatHistory, compaction, historyWindow } =
    await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit,
      apiSessionId: sessionId,
      historyStrategy,
    });

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

  const processedAttachments = await processDocumentAttachments(attachments);
  const parsedAttachments = processedAttachments.parsedDocuments;
  attachments = processedAttachments.imageAttachments;
  let llmAttachments = imageAnalysisContext ? [] : attachments;
  parsedAttachments.forEach((doc) => {
    if (doc.pageContent) {
      contextTexts.push(doc.pageContent);
      const { pageContent, ...metadata } = doc;
      sources.push({
        text:
          pageContent.slice(0, 1_000) + "...continued on in source document...",
        ...metadata,
      });
    }
  });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
      metrics: {},
    };
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

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        attachments: historyAttachments,
        type: chatMode,
        metrics: {},
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      include: false,
      apiSessionId: sessionId,
      user,
    });

    return {
      id: uuid,
      type: "textResponse",
      sources: [],
      close: true,
      error: null,
      textResponse,
      metrics: {},
    };
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
    message,
    user,
  });
  if (exposeSaveMemoryTool)
    systemPrompt = `${systemPrompt}\n\n${SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION}`;
  const autoCompaction = await maybeAutoCompact({
    workspace,
    user,
    thread,
    apiSessionId: sessionId,
    llm: LLMConnector,
    systemPrompt,
    chatHistory,
    userPrompt: message,
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
      apiSessionId: sessionId,
      historyStrategy,
    });
    rawHistory = nextHistory.rawHistory;
    chatHistory = nextHistory.chatHistory;
    compaction = nextHistory.compaction;
    historyWindow = nextHistory.historyWindow || null;
  }

  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt: appendCurrentDateTimeToPrompt(message),
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
    provider: workspace?.chatProvider || "deepseek",
  };

  // Reserve policy budget before provider execution. Observe mode records the
  // same reservation without denying; enforce mode can fail closed here.
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
    { messages }
  );
  let completion;
  try {
    completion = await LLMConnector.getChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user: user,
      thinking: deepSeekThinkingMode,
    });
  } catch (error) {
    await modelExecution.fail(error);
    throw error;
  }
  const { textResponse, metrics: performanceMetrics } = completion;
  const metrics = withPromptCacheDiagnostics(
    performanceMetrics,
    promptCacheDiagnostics
  );
  await modelExecution.settle(metrics, { transport: "api", chatMode });

  if (!textResponse) {
    return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "No text completion could be completed with this input.",
      metrics,
    };
  }

  const { chat } = await WorkspaceChats.new({
    workspaceId: workspace.id,
    prompt: message,
    response: {
      text: textResponse,
      sources,
      attachments: historyAttachments,
      type: chatMode,
      metrics,
      execution: require("./executionMetadata").executionMetadata({
        metrics,
        ...lockedExecution,
      }),
      ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
    },
    threadId: thread?.id || null,
    apiSessionId: sessionId,
    user,
  });
  maybeAutoCompact({
    workspace,
    user,
    thread,
    apiSessionId: sessionId,
    llm: LLMConnector,
    systemPrompt,
    chatHistory: [
      ...chatHistory,
      { role: "user", content: message },
      { role: "assistant", content: textResponse },
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

  return {
    id: uuid,
    type: "textResponse",
    close: true,
    error: null,
    chatId: chat.id,
    publicChatId: chat.public_id || null,
    textResponse,
    sources,
    metrics,
  };
}

/**
 * Handle streamable HTTP chunks for chats with your workspace via the developer API endpoint
 * @param {{
 * response: import("express").Response,
 *  workspace: import("@prisma/client").workspaces,
 *  message:string,
 *  mode: "automatic"|"chat"|"query",
 *  user: import("@prisma/client").users|null,
 *  thread: import("@prisma/client").workspace_threads|null,
 *  sessionId: string|null,
 *  attachments: { name: string; mime: string; contentString: string }[],
 *  reset: boolean,
 * }} parameters
 * @returns {Promise<VoidFunction>}
 */
async function streamChat({
  response,
  workspace,
  message = null,
  mode = null,
  user = null,
  thread = null,
  sessionId = null,
  attachments = [],
  reset = false,
}) {
  const uuid = uuidv4();
  const chatMode = mode ?? workspace?.chatMode ?? "automatic";
  attachments = await hydrateIncomingAttachments({
    attachments,
    scope: {
      workspaceId: workspace.id,
      userId: user?.id || null,
      threadId: thread?.id || null,
      apiSessionId: sessionId,
    },
  });

  // If the user wants to reset the chat history we do so pre-flight
  // and continue execution. If no message is provided then the user intended
  // to reset the chat history only and we can exit early with a confirmation.
  if (reset) {
    await WorkspaceChats.markThreadHistoryInvalidV2({
      workspaceId: workspace.id,
      user_id: user?.id,
      thread_id: thread?.id,
      api_session_id: sessionId,
    });
    if (!message?.length) {
      writeResponseChunk(response, {
        id: uuid,
        type: "textResponse",
        textResponse: "Chat history was reset!",
        sources: [],
        attachments: [],
        close: true,
        error: null,
        metrics: {},
      });
      return;
    }
  }

  // Check for and process slash commands
  // Since preset commands are not supported in API calls, we can just process the message here
  const processedMessage = await grepAllSlashCommands(message);
  message = processedMessage;

  const historyAttachments = attachments;
  let imageAnalysisContext = null;
  let imageAnalysisText = null;
  let agentAttachments = attachments;
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
      agentAttachments = imageAnalysis.llmAttachments;
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
      metrics: {},
    });
    return;
  }

  const agentMessage = imageAnalysisContext
    ? `${message}\n\n${imageAnalysisContext}`
    : message;

  if (
    await EphemeralAgentHandler.isAgentInvocation({
      message: agentMessage,
      workspace,
      chatMode,
    })
  ) {
    await Telemetry.sendTelemetry("agent_chat_started");

    // Initialize the EphemeralAgentHandler to handle non-continuous
    // conversations with agents since this is over REST.
    const agentHandler = new EphemeralAgentHandler({
      uuid,
      workspace,
      prompt: agentMessage,
      userId: user?.id || null,
      threadId: thread?.id || null,
      sessionId,
      attachments: agentAttachments,
    });

    // Establish event listener that emulates websocket calls
    // in Aibitat so that we can keep the same interface in Aibitat
    // but use HTTP.
    const eventListener = new EphemeralEventListener();
    await agentHandler.init();
    await agentHandler.createAIbitat({ handler: eventListener });
    agentHandler.startAgentCluster();

    // The cluster has started and now we wait for close event since
    // and stream back any results we get from agents as they come in.
    return eventListener
      .streamAgentEvents(response, uuid)
      .then(async ({ thoughts, textResponse }) => {
        const { chat } = await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: String(message),
          response: {
            text: textResponse,
            sources: [],
            attachments: historyAttachments,
            type: chatMode,
            thoughts,
            ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
          },
          include: true,
          threadId: thread?.id || null,
          apiSessionId: sessionId,
        });
        writeResponseChunk(response, {
          uuid,
          type: "finalizeResponseStream",
          textResponse,
          thoughts,
          close: true,
          error: false,
          chatId: chat?.id || null,
          publicChatId: chat?.public_id || null,
        });
      });
  }

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });

  const VectorDb = getVectorDbClass();
  const messageLimit = workspace?.openAiHistory || 20;
  const historyStrategy = cacheStableHistoryStrategyFor({
    llm: LLMConnector,
    messageLimit,
  });
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

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
      attachments: [],
      close: true,
      error: null,
      metrics: {},
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        attachments: historyAttachments,
        type: chatMode,
        metrics: {},
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      apiSessionId: sessionId,
      include: false,
      user,
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
  let { rawHistory, chatHistory, compaction, historyWindow } =
    await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit,
      apiSessionId: sessionId,
      historyStrategy,
    });

  // Look for pinned documents and see if the user decided to use this feature. We will also do a vector search
  // as pinning is a supplemental tool but it should be used with caution since it can easily blow up a context window.
  // However we limit the maximum of appended context to 80% of its overall size, mostly because if it expands beyond this
  // it will undergo prompt compression anyway to make it work. If there is so much pinned that the context here is bigger than
  // what the model can support - it would get compressed anyway and that really is not the point of pinning. It is really best
  // suited for high-context models.
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

  const processedAttachments = await processDocumentAttachments(attachments);
  const parsedAttachments = processedAttachments.parsedDocuments;
  attachments = processedAttachments.imageAttachments;
  let llmAttachments = imageAnalysisContext ? [] : attachments;
  parsedAttachments.forEach((doc) => {
    if (doc.pageContent) {
      contextTexts.push(doc.pageContent);
      const { pageContent, ...metadata } = doc;
      sources.push({
        text:
          pageContent.slice(0, 1_000) + "...continued on in source document...",
        ...metadata,
      });
    }
  });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
      metrics: {},
    });
    return;
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
      metrics: {},
    });

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        attachments: historyAttachments,
        type: chatMode,
        metrics: {},
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      apiSessionId: sessionId,
      include: false,
      user,
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
    message,
    user,
  });
  if (exposeSaveMemoryTool)
    systemPrompt = `${systemPrompt}\n\n${SAVE_MEMORY_TOOL_SYSTEM_INSTRUCTION}`;
  const autoCompaction = await maybeAutoCompact({
    workspace,
    user,
    thread,
    apiSessionId: sessionId,
    llm: LLMConnector,
    systemPrompt,
    chatHistory,
    userPrompt: message,
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
      apiSessionId: sessionId,
      historyStrategy,
    });
    rawHistory = nextHistory.rawHistory;
    chatHistory = nextHistory.chatHistory;
    compaction = nextHistory.compaction;
    historyWindow = nextHistory.historyWindow || null;
  }

  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt: appendCurrentDateTimeToPrompt(message),
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
    provider: workspace?.chatProvider || "deepseek",
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
        close: true,
        error: false,
        metrics,
        execution: require("./executionMetadata").executionMetadata({
          metrics,
          ...lockedExecution,
        }),
      });
    } else {
      const stream = await LLMConnector.streamGetChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user: user,
        thinking: deepSeekThinkingMode,
        tools: exposeSaveMemoryTool ? saveMemoryToolsForMessage(message) : [],
        toolChoice: exposeSaveMemoryTool ? "auto" : undefined,
      });
      completeText = await LLMConnector.handleStream(response, stream, {
        uuid,
      });
      if (saveMemoryToolCallFrom(stream.toolCalls)) {
        completeText = "保存长期记忆需要前端确认，API 请求未写入记忆。";
        writeResponseChunk(response, {
          uuid,
          sources,
          type: "textResponseChunk",
          textResponse: completeText,
          close: true,
          error: false,
          metrics: stream.metrics || {},
        });
      }
      metrics = withPromptCacheDiagnostics(
        stream.metrics,
        promptCacheDiagnostics
      );
      stream.metrics = metrics;
    }
  } catch (error) {
    await modelExecution.fail(error);
    throw error;
  }
  await modelExecution.settle(metrics, {
    transport: "api-stream",
    chatMode,
  });

  if (completeText?.length > 0) {
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: completeText,
        sources,
        type: chatMode,
        metrics,
        attachments: historyAttachments,
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      apiSessionId: sessionId,
      user,
    });
    maybeAutoCompact({
      workspace,
      user,
      thread,
      apiSessionId: sessionId,
      llm: LLMConnector,
      systemPrompt,
      chatHistory: [
        ...chatHistory,
        { role: "user", content: message },
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
      chatId: chat.id,
      publicChatId: chat.public_id || null,
      metrics,
      sources,
    });
    return;
  }

  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
  });
  return;
}

module.exports.ApiChatHandler = {
  chatSync,
  streamChat,
};
