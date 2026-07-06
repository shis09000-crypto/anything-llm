const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const KnowledgeGraphData = lazyDataAccessFacade("knowledgeGraph");
const knowledgeGraphDb = KnowledgeGraphData.db;
const { fileData } = require("../files");
const WorkspaceSupplement = lazyDataAccessProperty(
  "knowledgeGraph",
  "workspaceSupplement"
);
const {
  WORKSPACE_SUPPLEMENT_KIND_LABELS,
  normalizeSupplementKind,
  supplementKindWeight,
} = require("./supplementConstants");

const TOOL_NAME = "get_workspace_supplement";
const STANDARD_TOOL_KINDS = [
  "structure_json",
  "reading_guide",
  "chapter_overview",
  "timeline",
  "person_map",
  "concept_index",
  "summary_standard",
];
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 3;
const CONTENT_PREVIEW_CHARS = 160;
const CUSTOM_TITLE_PREVIEW_MIN = 12;
const CUSTOM_TITLE_PREVIEW_MAX = 20;
const MAX_ITEM_CONTENT_CHARS = 4_000;
const MAX_TOTAL_CONTENT_CHARS = 8_000;
const TOOL_LIMIT_MESSAGE =
  "The workspace supplement tool can only be called once per turn. Use the supplement content and existing context already available to answer; do not request this tool again.";

function compactWhitespace(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeMetadata(value = {}) {
  return value && typeof value === "object" ? value : {};
}

function structureJsonValid(supplement = {}) {
  const metadata = safeMetadata(supplement.metadata);
  if (metadata.structureJsonValidation?.valid === true) return true;
  if (metadata.structureJsonValidation?.valid === false) return false;
  return Boolean(metadata.parsedStructure);
}

function scopeRank(supplement = {}, primaryDocumentId = null) {
  const scopeType = supplement.scopeType || "workspace";
  const primary = supplement.primaryDocumentId || null;
  const requestedPrimary = primaryDocumentId || null;

  if (requestedPrimary) {
    if (scopeType === "book" && primary === requestedPrimary) return 0;
    if (scopeType === "workspace") return 1;
    if (scopeType === "book" && !primary) return 2;
    return 99;
  }

  if (scopeType === "workspace") return 0;
  if (scopeType === "book" && !primary) return 1;
  return 99;
}

function scopeEligible(supplement = {}, primaryDocumentId = null) {
  return scopeRank(supplement, primaryDocumentId) < 99;
}

function sortSupplements(supplements = [], primaryDocumentId = null) {
  return [...supplements].sort((a, b) => {
    const priorityDelta = Number(b.priority || 0) - Number(a.priority || 0);
    if (priorityDelta !== 0) return priorityDelta;

    const scopeDelta =
      scopeRank(a, primaryDocumentId) - scopeRank(b, primaryDocumentId);
    if (scopeDelta !== 0) return scopeDelta;

    const weightDelta =
      supplementKindWeight(b.supplementKind) -
      supplementKindWeight(a.supplementKind);
    if (weightDelta !== 0) return weightDelta;

    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}

function previewText(content = "", maxChars = CONTENT_PREVIEW_CHARS) {
  const text = compactWhitespace(content);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function customDocumentTitle({
  supplement,
  contentPreview = "",
  index = 0,
} = {}) {
  const explicit = compactWhitespace(supplement?.documentName);
  if (explicit) return explicit;

  const preview = compactWhitespace(contentPreview);
  if (preview) {
    const length = Math.max(
      CUSTOM_TITLE_PREVIEW_MIN,
      Math.min(CUSTOM_TITLE_PREVIEW_MAX, preview.length)
    );
    return preview.slice(0, length);
  }

  return `自定义补充文档 ${index + 1}`;
}

function truncateContent(content = "", budget = MAX_ITEM_CONTENT_CHARS) {
  const text = String(content || "");
  const originalLength = text.length;
  if (originalLength <= budget) {
    return {
      content: text,
      originalLength,
      returnedLength: originalLength,
      truncated: false,
    };
  }

  const headBudget = Math.max(0, budget - 160);
  const head = text.slice(0, headBudget);
  const keyInfo = [];
  const headingMatches = text.match(/^#{1,4}\s+.+$/gm) || [];
  if (headingMatches.length) keyInfo.push(...headingMatches.slice(0, 8));
  const listMatches = text.match(/^\s*[-*]\s+.+$/gm) || [];
  if (listMatches.length) keyInfo.push(...listMatches.slice(0, 8));
  const suffix = keyInfo.length
    ? `\n\n[Key lines preserved]\n${keyInfo.join("\n").slice(0, 120)}`
    : "\n\n[Content truncated]";
  const truncatedContent = `${head}${suffix}`.slice(0, budget);
  return {
    content: truncatedContent,
    originalLength,
    returnedLength: truncatedContent.length,
    truncated: true,
  };
}

async function documentsById({ workspaceId, documentIds = [] }) {
  const ids = [...new Set(documentIds.filter(Boolean))];
  if (!workspaceId || !ids.length) return new Map();
  const documents = await knowledgeGraphDb.workspace_documents.findMany({
    where: {
      workspaceId: Number(workspaceId),
      docId: { in: ids },
    },
  });
  return new Map(documents.map((document) => [document.docId, document]));
}

async function hydrateSupplements({
  workspaceId,
  supplements = [],
  includeContent = false,
} = {}) {
  const docById = await documentsById({
    workspaceId,
    documentIds: supplements.map((item) => item.documentId),
  });

  return await Promise.all(
    supplements.map(async (supplement, index) => {
      const document = docById.get(supplement.documentId);
      let content = "";
      if (document?.docpath) {
        const data = await fileData(document.docpath).catch(() => null);
        content = data?.pageContent || "";
      }
      const contentPreview = previewText(content);
      return {
        ...supplement,
        document,
        contentPreview,
        toolTitle:
          supplement.supplementKind === "other"
            ? customDocumentTitle({ supplement, contentPreview, index })
            : supplement.documentName || supplement.documentId,
        ...(includeContent ? { content } : {}),
      };
    })
  );
}

function toolFieldsForSupplement(supplement = {}) {
  const kind = normalizeSupplementKind(supplement.supplementKind);
  const isCustom = kind === "other";
  const metadata = safeMetadata(supplement.metadata);
  const { toolTitle, ...publicSupplement } = supplement;
  delete publicSupplement.document;
  delete publicSupplement.content;
  return {
    ...publicSupplement,
    usageRole: isCustom ? "custom_document" : "standard_kind",
    structureJsonValid:
      kind === "structure_json" ? structureJsonValid(supplement) : null,
    contentPreview: supplement.contentPreview || "",
    toolExposeMode: isCustom ? "document" : "kind",
    toolLabel: isCustom
      ? toolTitle || supplement.documentName || supplement.documentId
      : WORKSPACE_SUPPLEMENT_KIND_LABELS[kind] || kind,
    toolDescription: isCustom
      ? "workspaceSupplement.customDocumentDescription"
      : `workspaceSupplement.kindDescriptions.${kind}`,
    metadata,
  };
}

async function resolveWorkspaceSupplementToolManifest({
  workspaceId,
  scopeType = null,
  primaryDocumentId = null,
} = {}) {
  if (!workspaceId)
    return { standardKinds: [], customDocuments: [], hasSupplements: false };

  const listed = await WorkspaceSupplement.list({
    workspaceId,
    scopeType,
    limit: 500,
  });
  const scoped = sortSupplements(
    listed.filter((supplement) => scopeEligible(supplement, primaryDocumentId)),
    primaryDocumentId
  );
  const hydrated = await hydrateSupplements({
    workspaceId,
    supplements: scoped,
  });

  const byKind = new Map();
  const customDocuments = [];
  hydrated.forEach((supplement) => {
    const kind = normalizeSupplementKind(supplement.supplementKind);
    if (kind === "other") {
      const fields = toolFieldsForSupplement({
        ...supplement,
        toolTitle: customDocumentTitle({
          supplement,
          contentPreview: supplement.contentPreview,
          index: customDocuments.length,
        }),
      });
      customDocuments.push({
        supplementId: fields.id,
        documentId: fields.documentId,
        title: fields.toolLabel,
        contentPreview: fields.contentPreview,
        labelKey: null,
        descriptionKey: "workspaceSupplement.customDocumentDescription",
        scopeType: fields.scopeType,
        primaryDocumentId: fields.primaryDocumentId,
        priority: fields.priority,
      });
      return;
    }
    if (!STANDARD_TOOL_KINDS.includes(kind)) return;
    if (!byKind.has(kind)) {
      byKind.set(kind, {
        kind,
        count: 0,
        labelKey: `workspaceSupplement.kinds.${kind}`,
        descriptionKey: `workspaceSupplement.kindDescriptions.${kind}`,
        structureJsonValid: kind === "structure_json" ? false : null,
      });
    }
    const item = byKind.get(kind);
    item.count += 1;
    if (kind === "structure_json")
      item.structureJsonValid =
        item.structureJsonValid || structureJsonValid(supplement);
  });

  const standardKinds = STANDARD_TOOL_KINDS.filter((kind) =>
    byKind.has(kind)
  ).map((kind) => byKind.get(kind));
  return {
    standardKinds,
    customDocuments,
    hasSupplements: standardKinds.length > 0 || customDocuments.length > 0,
  };
}

async function listWorkspaceSupplementsWithToolFields({
  workspaceId,
  scopeType = null,
  primaryDocumentId = undefined,
} = {}) {
  const supplements = await WorkspaceSupplement.list({
    workspaceId,
    scopeType,
    primaryDocumentId,
  });
  const hydrated = await hydrateSupplements({ workspaceId, supplements });
  return hydrated.map((supplement) => toolFieldsForSupplement(supplement));
}

function clampLimit(limit) {
  const value = Number(limit || DEFAULT_LIMIT);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function toolError(error, message, extra = {}) {
  return JSON.stringify({ ok: false, error, message, ...extra });
}

async function resolveWorkspaceSupplementToolContent({
  workspaceId,
  primaryDocumentId = null,
  mode,
  supplementKind = null,
  supplementId = null,
  documentTitle = null,
  query = "",
  limit = DEFAULT_LIMIT,
} = {}) {
  const manifest = await resolveWorkspaceSupplementToolManifest({
    workspaceId,
    primaryDocumentId,
  });
  if (!manifest.hasSupplements)
    return toolError(
      "no_available_supplements",
      "No workspace supplements are currently available for this workspace and scope."
    );

  const listed = await WorkspaceSupplement.list({ workspaceId, limit: 500 });
  const scoped = sortSupplements(
    listed.filter((supplement) => scopeEligible(supplement, primaryDocumentId)),
    primaryDocumentId
  );

  let selected = [];
  let resolvedKind = null;
  if (mode === "kind") {
    resolvedKind = normalizeSupplementKind(supplementKind);
    if (resolvedKind === "other")
      return toolError(
        "invalid_supplement_kind",
        "The other/custom supplement category is not callable by kind. Use document mode with supplementId."
      );
    const available = manifest.standardKinds.some(
      (item) => item.kind === resolvedKind
    );
    if (!available)
      return toolError(
        "supplement_kind_unavailable",
        `Supplement kind "${supplementKind}" is not available in the current manifest.`
      );
    selected = scoped
      .filter((supplement) => supplement.supplementKind === resolvedKind)
      .slice(0, clampLimit(limit));
  } else if (mode === "document") {
    const customById = manifest.customDocuments.filter((item) =>
      supplementId ? Number(item.supplementId) === Number(supplementId) : false
    );
    let customMatches = customById;
    if (!supplementId && documentTitle) {
      customMatches = manifest.customDocuments.filter(
        (item) => item.title === documentTitle
      );
      if (customMatches.length > 1)
        return toolError(
          "ambiguous_title",
          "Multiple custom supplement documents have this exact title. Call again with supplementId.",
          {
            matches: customMatches.map((item) => ({
              supplementId: item.supplementId,
              title: item.title,
              documentId: item.documentId,
            })),
          }
        );
    }
    if (customMatches.length === 0)
      return toolError(
        "supplement_document_unavailable",
        "The requested custom supplement document is not available in the current manifest."
      );
    const ids = new Set(customMatches.map((item) => Number(item.supplementId)));
    selected = scoped.filter((supplement) => ids.has(Number(supplement.id)));
  } else {
    return toolError(
      "invalid_mode",
      'Mode must be either "kind" or "document".'
    );
  }

  const hydrated = await hydrateSupplements({
    workspaceId,
    supplements: selected,
    includeContent: true,
  });

  let remainingBudget = MAX_TOTAL_CONTENT_CHARS;
  const items = hydrated.map((supplement) => {
    const itemBudget = Math.max(
      0,
      Math.min(MAX_ITEM_CONTENT_CHARS, remainingBudget)
    );
    const contentState = truncateContent(supplement.content || "", itemBudget);
    remainingBudget = Math.max(
      0,
      remainingBudget - contentState.returnedLength
    );
    const metadata = safeMetadata(supplement.metadata);
    const kind = normalizeSupplementKind(supplement.supplementKind);
    return {
      supplementId: supplement.id,
      kind,
      title:
        supplement.toolTitle ||
        supplement.documentName ||
        supplement.documentId,
      content: contentState.content,
      contentPreview:
        supplement.contentPreview || previewText(supplement.content),
      metadata,
      priority: supplement.priority,
      scopeType: supplement.scopeType,
      primaryDocumentId: supplement.primaryDocumentId,
      documentId: supplement.documentId,
      originalLength: contentState.originalLength,
      returnedLength: contentState.returnedLength,
      truncated: contentState.truncated,
      ...(kind === "structure_json"
        ? {
            structureJsonValid: structureJsonValid(supplement),
            parsedStructure: metadata.parsedStructure || null,
          }
        : {}),
    };
  });

  return JSON.stringify({
    ok: true,
    mode,
    supplementKind: resolvedKind,
    query: query || null,
    returnedCount: items.length,
    truncatedCount: items.filter((item) => item.truncated).length,
    items,
  });
}

function manifestDescription(manifest = {}) {
  const standard = (manifest.standardKinds || [])
    .map((item) => `${item.kind} (${item.count})`)
    .join(", ");
  const custom = (manifest.customDocuments || [])
    .map((item) => `${item.title} [supplementId=${item.supplementId}]`)
    .join(", ");
  return [
    "Read curated workspace supplement documents on demand. Use this only when the user asks about book structure, reading order, timelines, person relationships, concept definitions, chapter summaries, or summary requirements.",
    standard ? `Available standard kinds: ${standard}.` : "",
    custom ? `Available custom documents: ${custom}.` : "",
    "Call at most once in this turn. The query parameter is only logged in v1 and does not perform search.",
  ]
    .filter(Boolean)
    .join(" ");
}

module.exports = {
  TOOL_NAME,
  TOOL_LIMIT_MESSAGE,
  STANDARD_TOOL_KINDS,
  MAX_LIMIT,
  CONTENT_PREVIEW_CHARS,
  resolveWorkspaceSupplementToolManifest,
  resolveWorkspaceSupplementToolContent,
  listWorkspaceSupplementsWithToolFields,
  manifestDescription,
};
