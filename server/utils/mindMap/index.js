const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const truncate = require("truncate");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceMindMaps } = require("../../models/workspaceMindMaps");
const { WorkspaceThread } = require("../../models/workspaceThread");
const { Document } = require("../../models/documents");
const { DocumentIndexStatus } = require("../../models/documentIndexStatus");
const { WorkspaceParsedFiles } = require("../../models/workspaceParsedFiles");
const { getLLMProvider, getBaseLLMProviderModel } = require("../helpers");
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
}) {
  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
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
  const { textResponse } = await LLMConnector.getChatCompletion(messages, {
    temperature: 0.2,
    user,
  });
  return textResponse;
}

async function generateMindMap({ workspace, user = null, body = {} }) {
  const layout = VALID_LAYOUTS.includes(body.layout)
    ? body.layout
    : DEFAULT_LAYOUT;
  const theme = VALID_THEMES.includes(body.theme) ? body.theme : DEFAULT_THEME;
  const force = body.force === true;
  const thread = await resolveThread(workspace, body.threadSlug, user);
  const source = await resolveSource({ workspace, user, body });
  const suitability = mindMapSuitability(source.sourceText);
  const generationModel = generationModelForWorkspace(workspace);

  if (suitability.status === "not_recommended" && !force) {
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
    return {
      mindMap: cached,
      cached: true,
      suitability,
      documentStatusWarning: source.documentStatusWarning,
    };
  }

  const rawSchema = await generateSchemaWithLLM({
    workspace,
    user,
    sourceText: source.sourceText,
    layout,
    theme,
    sourceTitle: source.sourceTitle,
  });
  const schema = normalizeMindMapSchema(rawSchema, {
    layout,
    theme,
    title: source.sourceTitle,
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
