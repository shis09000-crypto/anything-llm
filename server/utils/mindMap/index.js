const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const truncate = require("truncate");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceMindMaps } = require("../../models/workspaceMindMaps");
const { WorkspaceThread } = require("../../models/workspaceThread");
const {
  DocumentRepository: Document,
} = require("../../repositories/documentRepository");
const {
  DocumentIndexStatusRepository: DocumentIndexStatus,
} = require("../../repositories/documentIndexStatusRepository");
const {
  WorkspaceParsedFileRepository: WorkspaceParsedFiles,
} = require("../../repositories/workspaceParsedFileRepository");
const { getBaseLLMProviderModel } = require("../helpers");
const { getTaskConnector } = require("../llmTasks");
const { safeJsonParse } = require("../http");
const { documentsPath, directUploadsPath } = require("../files");
const { mindMapSuitability } = require("./suitability");
const {
  MIND_MAP_SCHEMA_VERSION,
  MIND_MAP_PROMPT_VERSION,
  DEFAULT_LAYOUT,
  DEFAULT_THEME,
  VALID_LAYOUTS,
  VALID_THEMES,
  normalizeMindMapSchema,
  mindMapToMarkdown,
} = require("./schema");

const MIND_MAP_LLM_RETRY_DELAYS_MS = [800, 1600];
const TRANSIENT_LLM_ERROR_PATTERNS = [
  /Premature close/i,
  /Invalid response body/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /\bterminated\b/i,
  /network timeout/i,
  /\b429\b/i,
  /\b5\d{2}\b/i,
];

function isMindMapDebugEnabled() {
  return process.env.MIND_MAP_DEBUG === "1";
}

function mindMapDebugLog(requestId, event, metadata = {}) {
  if (!isMindMapDebugEnabled()) return;
  console.log(
    `[MindMapDebug] ${JSON.stringify({
      requestId,
      event,
      ...metadata,
    })}`
  );
}

function normalizeSourceText(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function compactHash(value = "") {
  return sha256(value).slice(0, 12);
}

function isTransientLLMError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 429 || (status >= 500 && status < 600)) return true;

  const message = [
    error?.message,
    error?.code,
    error?.type,
    error?.cause?.message,
  ]
    .filter(Boolean)
    .join(" ");
  return TRANSIENT_LLM_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function llmRetryDelays() {
  return process.env.NODE_ENV === "test"
    ? [0, 0]
    : MIND_MAP_LLM_RETRY_DELAYS_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generationModelForWorkspace(workspace) {
  const provider =
    workspace?.chatProvider || process.env.LLM_PROVIDER || "openai";
  return (
    workspace?.chatModel ||
    getBaseLLMProviderModel({ provider }) ||
    process.env.OPEN_MODEL_PREF ||
    "system-default"
  );
}

function sourceHash({ sourceText, layout, theme, model }) {
  return sha256(
    [
      normalizeSourceText(sourceText),
      layout || DEFAULT_LAYOUT,
      theme || DEFAULT_THEME,
      model || "system-default",
      MIND_MAP_PROMPT_VERSION,
    ].join("\n---mind-map-cache-key---\n")
  );
}

async function resolveThread(workspace, threadSlug = null, user = null) {
  if (!threadSlug) return null;
  return await WorkspaceThread.get({
    slug: String(threadSlug),
    workspace_id: workspace.id,
    ...(user ? { user_id: user.id } : {}),
  });
}

async function resolveSource({ workspace, user = null, body = {} }) {
  const sourceType = String(body.sourceType || "text");
  const selectedText = normalizeSourceText(body.selectedText);
  if (selectedText) {
    return {
      sourceType: "selected_text",
      sourceId: body.chatId ? String(body.chatId) : null,
      sourceTitle: "Selected text",
      sourceText: selectedText,
      documentStatusWarning: null,
    };
  }

  if (sourceType === "chat" || sourceType === "assistant_response") {
    const chatId = body.chatId ? Number(body.chatId) : null;
    const chat = chatId
      ? await WorkspaceChats.get({
          id: chatId,
          workspaceId: workspace.id,
          ...(user ? { user_id: user.id } : {}),
        })
      : await WorkspaceChats.get(
          {
            workspaceId: workspace.id,
            ...(user ? { user_id: user.id } : {}),
            include: true,
          },
          null,
          { id: "desc" }
        );
    if (!chat) throw new Error("mind_map_source_chat_not_found");
    const response = safeJsonParse(chat.response, {});
    return {
      sourceType: "chat",
      sourceId: String(chat.id),
      sourceTitle: truncate(chat.prompt || "Assistant response", 80),
      sourceText: normalizeSourceText(response.text || chat.response),
      documentStatusWarning: null,
    };
  }

  if (sourceType === "document") {
    if (!body.docId && !body.docPath)
      throw new Error("mind_map_source_document_required");
    const document = await Document.get({
      ...(body.docId ? { docId: String(body.docId) } : {}),
      ...(body.docPath ? { docpath: String(body.docPath) } : {}),
      workspaceId: workspace.id,
    });
    if (!document) throw new Error("mind_map_source_document_not_found");

    const statuses = await DocumentIndexStatus.where({
      workspaceId: workspace.id,
      docId: document.docId,
      filePath: document.docpath,
    });
    const status = statuses[0] || null;
    const documentStatusWarning =
      status &&
      [
        DocumentIndexStatus.statuses.outdated,
        DocumentIndexStatus.statuses.failed,
      ].includes(status.indexStatus)
        ? {
            status: status.indexStatus,
            message:
              status.indexStatus === DocumentIndexStatus.statuses.failed
                ? "该文档索引失败，生成的思维导图可能不完整。"
                : "该文档索引已过期，建议重新生成文档索引后再生成思维导图。",
            errorMessage: status.errorMessage || null,
          }
        : null;
    const content = await Document.content(document.docId);
    return {
      sourceType: "document",
      sourceId: document.docId,
      sourceTitle: content.title || document.filename,
      sourceText: normalizeSourceText(content.content),
      documentStatusWarning,
    };
  }

  if (sourceType === "parsed_file") {
    const file = await WorkspaceParsedFiles.get({
      id: Number(body.parsedFileId),
      workspaceId: workspace.id,
      ...(user ? { userId: user.id } : {}),
    });
    if (!file) throw new Error("mind_map_source_parsed_file_not_found");
    const metadata = safeJsonParse(file.metadata, {});
    const sourceFile = path.join(
      directUploadsPath,
      path.basename(metadata.location || "")
    );
    if (!fs.existsSync(sourceFile))
      throw new Error("mind_map_source_parsed_file_missing");
    const data = safeJsonParse(fs.readFileSync(sourceFile, "utf-8"), {});
    return {
      sourceType: "parsed_file",
      sourceId: String(file.id),
      sourceTitle: metadata.title || metadata.location || file.filename,
      sourceText: normalizeSourceText(data.pageContent),
      documentStatusWarning: null,
    };
  }

  const sourceText = normalizeSourceText(body.text);
  if (!sourceText) throw new Error("mind_map_source_text_empty");
  return {
    sourceType: "text",
    sourceId: null,
    sourceTitle: "Text selection",
    sourceText,
    documentStatusWarning: null,
  };
}

function buildMindMapPrompt({ sourceText, layout, theme, title = "" }) {
  const clipped = sourceText.slice(0, 60_000);
  return `You convert source material into a professional AI mind map.

Return ONLY valid JSON matching this exact MindMapSchema:
{
  "title": "string",
  "layout": "radial | tree | timeline | flow | comparison",
  "recommendedLayout": "radial | tree | timeline | flow | comparison",
  "theme": "napkin | ocean | forest | sunset | mono",
  "summary": "optional short summary",
  "nodes": [
    {
      "id": "stable-kebab-id",
      "label": "short concept label",
      "description": "one sentence explanation",
      "icon": "single emoji or symbol",
      "level": 0,
      "color": "#RRGGBB",
      "parentId": "optional-parent-id"
    }
  ],
  "edges": [
    {
      "id": "stable-edge-id",
      "source": "source-node-id",
      "target": "target-node-id",
      "label": "optional relationship",
      "type": "parent | related | sequence | contrast | cause"
    }
  ]
}

Rules:
- Prefer 8-30 nodes for normal content, fewer for concise content, more only when truly useful.
- Never exceed 500 nodes.
- Use layout "${layout}" unless the content clearly fits another type; if so, set recommendedLayout.
- Use theme "${theme}".
- Use parentId for hierarchy and edges for relationships.
- Make the map presentation-quality: clear grouping, concise labels, practical descriptions.
- Do not include markdown, comments, code fences, or text outside JSON.

Source title: ${title || "Untitled"}

Source:
${clipped}`;
}

async function generateSchemaWithLLM({
  workspace,
  user = null,
  sourceText,
  layout,
  theme,
  sourceTitle,
  requestId,
}) {
  const { connector: LLMConnector } = getTaskConnector("mindmap_generation", {
    workspace,
  });
  const systemPrompt =
    "You are a diagram information architect. You output strict JSON only.";
  const prompt = buildMindMapPrompt({
    sourceText,
    layout,
    theme,
    title: sourceTitle,
  });
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt: prompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const delays = llmRetryDelays();
  const maxAttempts = delays.length + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    mindMapDebugLog(requestId, "llm_attempt_start", {
      attempt,
      maxAttempts,
      messageCount: messages.length,
      sourceLength: sourceText.length,
      sourceHash: compactHash(sourceText),
      promptLength: prompt.length,
    });

    try {
      const { textResponse } = await LLMConnector.getChatCompletion(messages, {
        temperature: 0.2,
        user,
        responseFormat: { type: "json_object" },
      });
      mindMapDebugLog(requestId, "llm_attempt_success", {
        attempt,
        durationMs: Date.now() - startedAt,
        responseLength: String(textResponse || "").length,
      });
      return textResponse;
    } catch (error) {
      lastError = error;
      const transient = isTransientLLMError(error);
      const shouldRetry = transient && attempt < maxAttempts;
      mindMapDebugLog(requestId, "llm_attempt_failed", {
        attempt,
        durationMs: Date.now() - startedAt,
        transient,
        retry: shouldRetry,
        errorName: error?.name || null,
        errorCode: error?.code || null,
        errorStatus: error?.status || error?.statusCode || null,
        errorMessage: error?.message || String(error),
      });

      if (!shouldRetry) break;
      await sleep(delays[attempt - 1]);
    }
  }

  throw lastError;
}

async function generateMindMap({ workspace, user = null, body = {} }) {
  const requestId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : compactHash(`${Date.now()}-${Math.random()}`);
  const layout = VALID_LAYOUTS.includes(body.layout)
    ? body.layout
    : DEFAULT_LAYOUT;
  const theme = VALID_THEMES.includes(body.theme) ? body.theme : DEFAULT_THEME;
  const force = body.force === true;
  const thread = await resolveThread(workspace, body.threadSlug, user);
  const source = await resolveSource({ workspace, user, body });
  const suitability = mindMapSuitability(source.sourceText);
  const generationModel = generationModelForWorkspace(workspace);
  mindMapDebugLog(requestId, "generate_start", {
    workspaceId: workspace?.id || null,
    workspaceSlug: workspace?.slug || null,
    provider: workspace?.chatProvider || process.env.LLM_PROVIDER || "openai",
    model: generationModel,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceLength: source.sourceText.length,
    sourceHash: compactHash(source.sourceText),
    layout,
    theme,
    force,
    suitabilityStatus: suitability.status,
  });

  if (suitability.status === "not_recommended" && !force) {
    mindMapDebugLog(requestId, "not_recommended", {
      suitabilityStatus: suitability.status,
    });
    return {
      mindMap: null,
      cached: false,
      suitability,
      documentStatusWarning: source.documentStatusWarning,
    };
  }

  const hash = sourceHash({
    sourceText: source.sourceText,
    layout,
    theme,
    model: generationModel,
  });
  const cached = await WorkspaceMindMaps.findCached({
    workspaceId: workspace.id,
    user,
    sourceHash: hash,
  });
  if (cached) {
    mindMapDebugLog(requestId, "cache_hit", {
      sourceHash: compactHash(hash),
      mindMapId: cached.id || null,
    });
    return {
      mindMap: cached,
      cached: true,
      suitability,
      documentStatusWarning: source.documentStatusWarning,
    };
  }
  mindMapDebugLog(requestId, "cache_miss", { sourceHash: compactHash(hash) });

  const rawSchema = await generateSchemaWithLLM({
    workspace,
    user,
    sourceText: source.sourceText,
    layout,
    theme,
    sourceTitle: source.sourceTitle,
    requestId,
  });
  mindMapDebugLog(requestId, "schema_normalize_start", {
    rawSchemaLength: String(rawSchema || "").length,
  });
  const schema = normalizeMindMapSchema(rawSchema, {
    layout,
    theme,
    title: source.sourceTitle,
  });
  mindMapDebugLog(requestId, "schema_normalize_success", {
    nodeCount: schema.nodes.length,
    edgeCount: schema.edges.length,
    layout: schema.layout,
    theme: schema.theme,
  });
  const markdown = mindMapToMarkdown(schema);
  const { mindMap, error } = await WorkspaceMindMaps.create({
    workspaceId: workspace.id,
    user,
    threadId: thread?.id || null,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceTitle: source.sourceTitle,
    sourceHash: hash,
    title: schema.title,
    layout: schema.layout,
    theme: schema.theme,
    schema,
    markdown,
    promptVersion: MIND_MAP_PROMPT_VERSION,
    schemaVersion: MIND_MAP_SCHEMA_VERSION,
    generationModel,
    suitability,
  });
  if (error) throw new Error(error);
  mindMapDebugLog(requestId, "mind_map_create_success", {
    mindMapId: mindMap?.id || null,
    markdownLength: markdown.length,
  });

  return {
    mindMap,
    cached: false,
    suitability,
    documentStatusWarning: source.documentStatusWarning,
  };
}

async function listMindMaps({ workspace, user = null, threadSlug = null }) {
  const thread = await resolveThread(workspace, threadSlug, user);
  return await WorkspaceMindMaps.where({
    workspaceId: workspace.id,
    cacheUserKey: WorkspaceMindMaps.cacheUserKey(user),
    ...(thread ? { thread_id: thread.id } : {}),
  });
}

module.exports = {
  MIND_MAP_SCHEMA_VERSION,
  MIND_MAP_PROMPT_VERSION,
  normalizeSourceText,
  sourceHash,
  mindMapSuitability,
  generateMindMap,
  listMindMaps,
  normalizeMindMapSchema,
  mindMapToMarkdown,
  documentsPath,
};
