const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { grepAgents } = require("./agents");
const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  sourceIdentifier,
} = require("./index");
const {
  injectCompactionIntoSystemPrompt,
  maybeAutoCompact,
  recentChatHistoryWithCompaction,
} = require("./threadCompaction");
const {
  resolveGraphContext,
} = require("../knowledgeGraph/graphContextResolver");
const {
  prepareImageAnalysisContext,
  shouldUseVisionTool,
} = require("../vision/viewTool");

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
  const uuid = uuidv4();
  let updatedMessage = await grepCommand(message, user);

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
    displayPrompt: updatedMessage,
    visionAnalysisContext: imageAnalysisText,
    fileAccess: options.fileAccess || {},
  });
  if (isAgentChat) return;

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
  const VectorDb = getVectorDbClass();

  const messageLimit = workspace?.openAiHistory || 20;
  let hasVectorizedSpace = false;
  let embeddingsCount = 0;
  try {
    hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
    embeddingsCount = await VectorDb.namespaceCount(workspace.slug);
  } catch (error) {
    logRecoverableChatError("vector.namespace_status", error, {
      workspaceSlug: workspace.slug,
    });
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
      close: true,
      error: null,
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
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
  try {
    const history = await recentChatHistoryWithCompaction({
      user,
      workspace,
      thread,
      messageLimit,
    });
    rawHistory = history.rawHistory || [];
    chatHistory = history.chatHistory || [];
    compaction = history.compaction || null;
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

  // Inject any parsed files for this workspace/thread/user
  const parsedFiles = await WorkspaceParsedFiles.getContextFiles(
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
      prompt: message,
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
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  const systemPrompt = await chatPrompt(workspace, user);
  const autoCompaction = await maybeAutoCompact({
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
    }).catch((error) => {
      logRecoverableChatError("post_compaction_history_refresh", error, {
        workspaceSlug: workspace.slug,
      });
      return { rawHistory, chatHistory, compaction };
    });
    rawHistory = nextHistory.rawHistory;
    chatHistory = nextHistory.chatHistory;
    compaction = nextHistory.compaction;
  }

  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt: injectCompactionIntoSystemPrompt(systemPrompt, compaction),
      userPrompt: updatedMessage,
      contextTexts,
      chatHistory,
      attachments: llmAttachments,
    },
    rawHistory
  );

  // If streaming is not explicitly enabled for connector
  // we do regular waiting of a response and send a single chunk.
  if (LLMConnector.streamingEnabled() !== true) {
    console.log(
      `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
    );
    const { textResponse, metrics: performanceMetrics } =
      await LLMConnector.getChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        user: user,
      });

    completeText = textResponse;
    metrics = performanceMetrics;
    writeResponseChunk(response, {
      uuid,
      sources,
      type: "textResponseChunk",
      textResponse: completeText,
      close: true,
      error: false,
      metrics,
    });
  } else {
    const stream = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      user: user,
    });
    completeText = await LLMConnector.handleStream(response, stream, {
      uuid,
      sources,
    });
    metrics = stream.metrics;
  }

  if (completeText?.length > 0) {
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: completeText,
        sources,
        type: chatMode,
        attachments: historyAttachments,
        metrics,
        ...(imageAnalysisText ? { imageAnalysis: imageAnalysisText } : {}),
      },
      threadId: thread?.id || null,
      user,
    }).catch((error) => {
      logRecoverableChatError("chat_history_save", error, {
        workspaceSlug: workspace.slug,
        threadId: thread?.id || null,
      });
      return { chat: null };
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
      metrics,
    });
    return;
  }

  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    close: true,
    error: false,
    metrics,
  });
  return;
}

module.exports = {
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
