const { jsonrepair } = require("jsonrepair");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { getTaskConnector } = require("../llmTasks");

const WorkspaceCognition = lazyDataAccessFacade("workspaceCognition");
const WorkspaceChats = lazyDataAccessFacade("workspaceChat");
const WorkspaceChatCompaction = lazyDataAccessFacade("workspaceChatCompaction");
const Workspace = lazyDataAccessFacade("workspace");
const WorkspaceThread = lazyDataAccessFacade("workspaceThread");

const activeChatJobs = new Set();

function cleanText(value = "", maxLength = 12_000) {
  return String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseJsonObject(value = "") {
  const text = String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {}
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    return null;
  }
}

function responsePayload(chat = {}) {
  if (typeof chat.response === "object") return chat.response || {};
  return parseJsonObject(chat.response) || {};
}

function cognitivePrompt({ text, origin, sources = [] } = {}) {
  const speaker = origin === "user" ? "用户" : "AI 助手";
  return [
    {
      role: "system",
      content: `你是 Workspace Cognitive Candidate Extractor。只输出严格 JSON。
本次只分析${speaker}文本。目标是提取可长期保留的独立命题，不要摘要整段对话，不要补充常识。

必须遵守：
1. 只提取给定文本中明确出现的内容。
2. 本次每个 item 的 origin 必须是 ${origin}。
3. 只有可由给定 sources 支撑的陈述才可标为 document_fact，并给出 sourceIndexes。
4. 每个 item 只含一个命题；同一用户的多个观点必须拆开。
5. 用户观点一律 confirmed=false。
6. 不确定是否长期有价值时不要提取。

assertionType 只能为 document_fact/conclusion/decision/hypothesis/open_question/risk/constraint。
stance 只能为 supports/opposes/conditional/uncertain/undecided；非用户观点可为 null。

输出：{"items":[{"assertionType":"...","statement":"...","origin":"user|assistant","stance":"supports|null","rationale":"","conditions":{},"confidence":0.0,"sourceIndexes":[]}]}`,
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          speaker: origin,
          text: cleanText(text),
          sources: sources.slice(0, 12).map((source, index) => ({
            index,
            docId: source?.docId || source?.metadata?.docId || null,
            chunkId:
              source?.chunkId ||
              source?.vectorId ||
              source?.id ||
              source?.metadata?.chunkId ||
              source?.metadata?.vectorId ||
              source?.metadata?.id ||
              null,
            title:
              source?.title ||
              source?.documentName ||
              source?.metadata?.title ||
              source?.metadata?.documentName ||
              source?.metadata?.chunkSource ||
              null,
            excerpt: cleanText(
              source?.text || source?.metadata?.text || source?.excerpt || "",
              1_200
            ),
          })),
        },
        null,
        2
      ),
    },
  ];
}

function normalizeItems(payload = {}, forcedOrigin = null) {
  if (!Array.isArray(payload?.items)) return [];
  return payload.items
    .map((item) => ({
      assertionType: String(item?.assertionType || "").trim(),
      statement: cleanText(item?.statement, 8_000),
      origin:
        forcedOrigin === "user" || forcedOrigin === "assistant"
          ? forcedOrigin
          : item?.origin === "user"
            ? "user"
            : "assistant",
      stance: item?.stance || null,
      rationale: cleanText(item?.rationale, 4_000) || null,
      conditions:
        item?.conditions && typeof item.conditions === "object"
          ? item.conditions
          : {},
      confidence: Number(item?.confidence || 0),
      sourceIndexes: Array.isArray(item?.sourceIndexes)
        ? item.sourceIndexes.map(Number).filter(Number.isInteger)
        : [],
    }))
    .filter((item) => item.statement && item.assertionType)
    .slice(0, 20);
}

function deterministicFallback(userText = "") {
  void userText;
  return [];
}

function sourceDetails(source = {}) {
  const metadata = source?.metadata || {};
  const docId = source?.docId || metadata.docId || null;
  const chunkId =
    source?.chunkId ||
    source?.vectorId ||
    source?.id ||
    metadata.chunkId ||
    metadata.vectorId ||
    metadata.id ||
    null;
  const graphEdgeId = source?.graphEdgeId || metadata.graphEdgeId || null;
  return {
    docId: docId ? String(docId) : null,
    chunkId: chunkId ? String(chunkId) : null,
    graphEdgeId: graphEdgeId ? String(graphEdgeId) : null,
    excerpt: cleanText(
      source?.text || metadata.text || source?.excerpt || "",
      4_000
    ),
    metadata,
  };
}

async function extractWithModel({
  workspace,
  userText,
  assistantText,
  sources,
}) {
  try {
    const { connector } = getTaskConnector("workspace_cognitive_extract", {
      workspace,
    });
    const extractOrigin = async (text, origin) => {
      if (!cleanText(text)) return [];
      const result = await connector.getChatCompletion(
        cognitivePrompt({ text, origin, sources }),
        { temperature: 0, responseFormat: { type: "json_object" } }
      );
      return normalizeItems(
        parseJsonObject(result?.textResponse || ""),
        origin
      );
    };
    const userItems = await extractOrigin(userText, "user");
    const assistantItems = await extractOrigin(assistantText, "assistant");
    return [...userItems, ...assistantItems].slice(0, 20);
  } catch (error) {
    console.warn("[WorkspaceCognition] extractor failed", error.message);
    throw error;
  }
}

async function persistExtractedItems({
  workspace,
  chat,
  subjectUserId,
  items = [],
  sources = [],
  capsule = null,
} = {}) {
  let createdCount = 0;
  const createdAssertionIds = [];
  for (const item of items) {
    try {
      const result = await WorkspaceCognition.createAssertion({
        workspaceId: workspace.id,
        assertionType: item.assertionType,
        statement: item.statement,
        verificationStatus: "candidate",
        confidence: item.confidence,
        createdByType: item.origin === "user" ? "user" : "assistant",
        createdByUserId: item.origin === "user" ? subjectUserId : null,
      });
      const assertion = result.assertion;
      if (result.created) createdCount += 1;
      createdAssertionIds.push(assertion.id);

      await WorkspaceCognition.addEvidence({
        workspaceId: workspace.id,
        assertionId: assertion.id,
        evidenceKind: "context",
        sourceType: "chat_turn",
        sourceRef: `chat:${chat.id}:${item.origin}`,
        chatId: chat.id,
        threadId: chat.thread_id,
        excerpt:
          item.origin === "user" ? chat.prompt : responsePayload(chat).text,
        confidence: item.confidence,
      });

      if (item.origin === "user" && subjectUserId) {
        await WorkspaceCognition.createPosition({
          workspaceId: workspace.id,
          assertionId: assertion.id,
          subjectUserId,
          proposedByUserId: subjectUserId,
          stance: item.stance || "supports",
          rationale: item.rationale,
          conditions: item.conditions,
          status: "candidate",
          sourceChatId: chat.id,
        });
      }

      for (const sourceIndex of item.sourceIndexes) {
        const source = sourceDetails(sources[sourceIndex]);
        if (source.docId && source.chunkId) {
          await WorkspaceCognition.addEvidence({
            workspaceId: workspace.id,
            assertionId: assertion.id,
            evidenceKind: "supports",
            sourceType: "document_chunk",
            sourceRef: `document:${source.docId}:chunk:${source.chunkId}`,
            documentId: source.docId,
            chunkId: source.chunkId,
            excerpt: source.excerpt,
            confidence: item.confidence,
            metadata: source.metadata,
          });
        }
        if (source.graphEdgeId) {
          await WorkspaceCognition.addEvidence({
            workspaceId: workspace.id,
            assertionId: assertion.id,
            evidenceKind: "supports",
            sourceType: "knowledge_graph_edge",
            sourceRef: `graph-edge:${source.graphEdgeId}`,
            graphEdgeId: source.graphEdgeId,
            documentId: source.docId,
            chunkId: source.chunkId,
            excerpt: source.excerpt,
            confidence: item.confidence,
            metadata: source.metadata,
          });
        }
      }

      if (capsule?.id) {
        await WorkspaceCognition.addEvidence({
          workspaceId: workspace.id,
          assertionId: assertion.id,
          evidenceKind: "context",
          sourceType: "thread_capsule_origin",
          sourceRef: `capsule:${capsule.id}`,
          threadId: chat.thread_id,
          excerpt:
            "Conversation State Capsule was used only as a backfill locator.",
          confidence: 0,
          metadata: { coveredToChatId: capsule.covered_to_chat_id || null },
        });
      }
    } catch (error) {
      console.warn("[WorkspaceCognition] skipped extracted item", {
        message: error.message,
        chatId: chat?.id,
      });
    }
  }
  return { createdCount, assertionIds: [...new Set(createdAssertionIds)] };
}

async function extractChat({
  workspace,
  chat,
  subjectUserId = null,
  capsule = null,
}) {
  if (!workspace?.id || !chat?.id || chat.include === false)
    return { createdCount: 0, assertionIds: [] };
  const response = responsePayload(chat);
  const sources = Array.isArray(response.sources) ? response.sources : [];
  const items = await extractWithModel({
    workspace,
    userText: chat.prompt,
    assistantText: response.text || "",
    sources,
  });
  return await persistExtractedItems({
    workspace,
    chat,
    subjectUserId: subjectUserId || chat.user_id || null,
    items,
    sources,
    capsule,
  });
}

function scheduleIncrementalExtraction({
  workspace = null,
  workspaceId = null,
  chat,
  userId = null,
} = {}) {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.WORKSPACE_COGNITION_AUTO_EXTRACT === "0") return;
  const resolvedWorkspaceId = Number(workspace?.id || workspaceId);
  if (!resolvedWorkspaceId || !chat?.id || chat.include === false) return;
  const key = `${resolvedWorkspaceId}:${chat.id}`;
  if (activeChatJobs.has(key)) return;
  activeChatJobs.add(key);
  setTimeout(async () => {
    try {
      if (!workspace) {
        workspace = await Workspace.get({ id: resolvedWorkspaceId });
      }
      if (!workspace) return;
      if (chat.thread_id) {
        const thread = await WorkspaceThread.get({
          id: Number(chat.thread_id),
          workspace_id: resolvedWorkspaceId,
        });
        if (thread?.thread_type === "meeting") return;
      }
      await extractChat({
        workspace,
        chat,
        subjectUserId: userId || chat.user_id,
      });
    } catch (error) {
      console.warn(
        "[WorkspaceCognition] incremental extraction failed",
        error.message
      );
    } finally {
      activeChatJobs.delete(key);
    }
  }, 0);
}

async function extractThread({
  workspace,
  threadId,
  userId = null,
  fromChatId = null,
}) {
  const job = await WorkspaceCognition.createExtractionJob({
    workspaceId: workspace.id,
    threadId: threadId ? Number(threadId) : null,
    requestedById: userId ? Number(userId) : null,
    mode: "backfill",
    status: "running",
    fromChatId: fromChatId ? Number(fromChatId) : null,
    startedAt: new Date(),
  });
  try {
    const chats = await WorkspaceChats.where(
      {
        workspaceId: workspace.id,
        thread_id: threadId ? Number(threadId) : null,
        api_session_id: null,
        include: true,
        ...(userId ? { user_id: Number(userId) } : {}),
        ...(fromChatId ? { id: { gte: Number(fromChatId) } } : {}),
      },
      null,
      { id: "asc" }
    );
    const capsule = await WorkspaceChatCompaction.latest({
      workspace_id: workspace.id,
      user_id: userId || null,
      thread_id: threadId || null,
      api_session_id: null,
    }).catch(() => null);
    let extractedCount = 0;
    let lastScannedChatId = null;
    for (const chat of chats) {
      const result = await extractChat({
        workspace,
        chat,
        subjectUserId: userId || chat.user_id,
        capsule,
      });
      extractedCount += result.createdCount;
      lastScannedChatId = chat.id;
      await WorkspaceCognition.updateExtractionJob(job.id, {
        extractedCount,
        lastScannedChatId,
      });
    }
    return await WorkspaceCognition.updateExtractionJob(job.id, {
      status: "completed",
      extractedCount,
      lastScannedChatId,
      toChatId: lastScannedChatId,
      completedAt: new Date(),
    });
  } catch (error) {
    await WorkspaceCognition.updateExtractionJob(job.id, {
      status: "failed",
      error: String(error.message || error).slice(0, 2_000),
      completedAt: new Date(),
    });
    throw error;
  }
}

module.exports = {
  extractChat,
  extractThread,
  scheduleIncrementalExtraction,
  deterministicFallback,
  normalizeItems,
};
