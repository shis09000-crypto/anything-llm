const { safeJsonParse } = require("../../utils/http");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const {
  lazyDataAccessFacade,
  lazyDataAccessProperty,
} = require("../dataAccess/lazyFacade");
const { sourceIdentifier } = require("../chats");

const STATEMENT_TYPES = new Set([
  "fact",
  "user_position",
  "conclusion",
  "inference",
  "dispute",
  "open_question",
  "commitment",
]);
const Document = lazyDataAccessFacade("document");
const NodeSupplement = lazyDataAccessProperty("nodeSupplement", "model");

function literalReplace(text, search, replacement) {
  if (!search) return text;
  return String(text)
    .split(String(search))
    .join(String(replacement || "[REDACTED]"));
}

function applyRedactions(value = "", rules = []) {
  let text = String(value || "");
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type === "email") {
      text = text.replace(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        rule.replacement || "[EMAIL]"
      );
    } else if (rule?.type === "phone") {
      text = text.replace(
        /(?:\+?\d[\d\s-]{7,}\d)/g,
        rule.replacement || "[PHONE]"
      );
    } else if (rule?.match) {
      text = literalReplace(text, rule.match, rule.replacement);
    }
  }
  return text;
}

function snapshotForPacket(packet = {}) {
  const snapshot = packet?.selection?.snapshot;
  if (!snapshot || typeof snapshot !== "object")
    throw new Error("frozen_packet_snapshot_missing");
  return snapshot;
}

function redactSnapshot(snapshot, rules = []) {
  const redactItem = (item, disclosureField = "disclosureLevel") => {
    const disclosure = item?.[disclosureField];
    if (disclosure === "blocked" || disclosure === "workspace_only")
      return null;
    if (disclosure !== "meeting_redacted") return item;
    const clone = { ...item };
    for (const field of ["statement", "rationale", "excerpt"]) {
      if (clone[field]) clone[field] = applyRedactions(clone[field], rules);
    }
    return clone;
  };
  return {
    ...snapshot,
    assertions: (snapshot.assertions || [])
      .map((item) => redactItem(item))
      .filter(Boolean),
    positions: (snapshot.positions || [])
      .map((item) => redactItem(item, "meetingDisclosure"))
      .filter(Boolean),
    evidence: (snapshot.evidence || [])
      .map((item) => redactItem(item))
      .filter(Boolean),
  };
}

function buildMeetingMessages({
  packet,
  prompt,
  liveSources = [],
  commitment = null,
}) {
  const snapshot = redactSnapshot(
    snapshotForPacket(packet),
    packet.redactionRules || []
  );
  const compactContext = {
    meeting: {
      title: packet.title,
      objective: packet.objective,
      delegateUserId: packet.delegateUserId,
      packetHash: packet.contentHash,
    },
    confirmedAssertions: snapshot.assertions.map((item) => ({
      id: item.id,
      type: item.assertionType,
      statement: item.statement,
      status: item.verificationStatus,
    })),
    delegatePositions: snapshot.positions.map((item) => ({
      id: item.id,
      assertionId: item.assertionId,
      owner: item.subjectUserId,
      stance: item.stance,
      rationale: item.rationale,
      conditions: safeJsonParse(item.conditionsJson, {}),
    })),
    evidence: snapshot.evidence.map((item) => ({
      ref: `evidence:${item.id}`,
      assertionId: item.assertionId,
      kind: item.evidenceKind,
      sourceType: item.sourceType,
      excerpt: item.excerpt,
    })),
    relations: snapshot.relations,
    liveSources: liveSources.map((item, index) => ({
      ref: `live:${index + 1}`,
      title: item.title || item.documentName || item.chunkSource || "source",
      docId: item.docId || null,
      excerpt: item.text || item.excerpt || "",
    })),
    commitment,
  };
  return [
    {
      role: "system",
      content: `你是一个受 Frozen Meeting Packet 约束的 Workspace Delegate。
只能使用给定快照和本次获准的 liveSources。不能使用账号长期记忆、工作区其他资料或模型常识补足事实。
只有 delegatePositions 中已确认的观点可以称为“我方观点”。模型自己的推断必须标为 inference，并在正文中明确写“推论：”。
资料不足时直接说“当前授权资料不足”。不得声称执行了外部系统动作。
只输出严格 JSON：
{"text":"会议发言","metadata":{"statementType":"fact|user_position|conclusion|inference|dispute|open_question|commitment","positionOwner":null,"confidence":0.0,"evidenceRefs":[],"disclosureDecision":"allowed|redacted|insufficient","commitmentAuthorizationId":null}}
fact/conclusion 必须引用 evidenceRefs；user_position 的 positionOwner 必须等于委托人；commitment 只有在 commitment.allowed=true 时可用。`,
    },
    {
      role: "user",
      content: `${JSON.stringify(compactContext, null, 2)}\n\n会议输入：${String(prompt || "").slice(0, 20_000)}`,
    },
  ];
}

function normalizeMeetingOutput(
  value = {},
  { packet, allowedEvidenceRefs = [], commitment = null } = {}
) {
  const metadata =
    value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
  let statementType = STATEMENT_TYPES.has(metadata.statementType)
    ? metadata.statementType
    : "inference";
  let text = String(value?.text || "当前授权资料不足")
    .trim()
    .slice(0, 30_000);
  const allowedRefs = new Set(allowedEvidenceRefs);
  const evidenceRefs = (
    Array.isArray(metadata.evidenceRefs) ? metadata.evidenceRefs : []
  )
    .map(String)
    .filter((ref) => allowedRefs.has(ref));
  let positionOwner = metadata.positionOwner
    ? Number(metadata.positionOwner)
    : null;
  let disclosureDecision = ["allowed", "redacted", "insufficient"].includes(
    metadata.disclosureDecision
  )
    ? metadata.disclosureDecision
    : "allowed";
  let commitmentAuthorizationId = metadata.commitmentAuthorizationId
    ? Number(metadata.commitmentAuthorizationId)
    : null;

  if (["fact", "conclusion"].includes(statementType) && !evidenceRefs.length) {
    statementType = "inference";
  }
  if (
    statementType === "user_position" &&
    positionOwner !== Number(packet.delegateUserId)
  ) {
    statementType = "inference";
    positionOwner = null;
  }
  if (statementType === "inference" && !/^推论[：:]/.test(text))
    text = `推论：${text}`;
  if (statementType === "commitment") {
    if (!commitment?.allowed) {
      statementType = "open_question";
      commitmentAuthorizationId = null;
      disclosureDecision = "insufficient";
      text = "当前授权范围不足，无法作出该承诺。";
    } else {
      commitmentAuthorizationId = commitment.authorizationId;
    }
  }
  return {
    text,
    metadata: {
      statementType,
      positionOwner,
      confidence: Math.min(1, Math.max(0, Number(metadata.confidence) || 0)),
      evidenceRefs,
      disclosureDecision,
      commitmentAuthorizationId,
    },
  };
}

function sourceDocId(source = {}) {
  return source?.docId || source?.metadata?.docId || null;
}

async function resolveWhitelistedDocumentIds({
  workspace,
  packet,
  documents = null,
} = {}) {
  const whitelist = packet?.sourceWhitelist || {};
  documents = documents || (await Document.forWorkspace(workspace.id));
  const approvedIds = new Set(
    (whitelist.documentIds || []).map(String).filter(Boolean)
  );
  const pathPrefixes = (whitelist.documentPathPrefixes || [])
    .map(String)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const document of documents) {
    if (
      pathPrefixes.some((prefix) =>
        String(document.docpath || "").startsWith(prefix)
      )
    ) {
      approvedIds.add(String(document.docId));
    }
  }
  const nodeKeys = (whitelist.knowledgeNodeKeys || [])
    .map(String)
    .filter(Boolean);
  if (nodeKeys.length) {
    const supplements = await NodeSupplement.summariesByNodeKeys({
      workspaceId: workspace.id,
      nodeKeys,
    });
    for (const rows of supplements.values()) {
      for (const row of rows) approvedIds.add(String(row.documentId));
    }
  }
  return approvedIds;
}

async function controlledRetrieve({
  workspace,
  packet,
  query,
  oneTimeDocumentIds = [],
}) {
  const whitelist = packet.sourceWhitelist || {};
  const documents = await Document.forWorkspace(workspace.id);
  const approvedIds = await resolveWhitelistedDocumentIds({
    workspace,
    packet,
    documents,
  });
  for (const documentId of oneTimeDocumentIds)
    approvedIds.add(String(documentId));
  if (!approvedIds.size) return { sources: [], insufficient: true };
  const approvedDocuments = documents.filter((doc) =>
    approvedIds.has(String(doc.docId))
  );
  if (!approvedDocuments.length) return { sources: [], insufficient: true };
  const excludedIdentifiers = documents
    .filter((doc) => !approvedIds.has(String(doc.docId)))
    .map((doc) => {
      const metadata = safeJsonParse(doc.metadata, {});
      return sourceIdentifier({
        ...metadata,
        docId: doc.docId,
        title: metadata.title || doc.filename,
      });
    });
  const LLMConnector = getLLMProvider({
    provider: workspace.chatProvider,
    model: workspace.chatModel,
  });
  const VectorDb = getVectorDbClass();
  const result = await VectorDb.performSimilaritySearch({
    namespace: workspace.slug,
    input: String(query || "").slice(0, 8_000),
    LLMConnector,
    similarityThreshold: workspace.similarityThreshold,
    topN: Math.min(
      Math.max(Number(whitelist.topN) || workspace.topN || 4, 1),
      20
    ),
    filterIdentifiers: excludedIdentifiers,
    rerank: workspace.vectorSearchMode === "rerank",
  });
  const sources = (result.sources || [])
    .filter((source) => approvedIds.has(String(sourceDocId(source))))
    .map((source) => ({
      ...source,
      text: applyRedactions(
        source.text || source.metadata?.text || "",
        packet.redactionRules
      ),
    }));
  return {
    sources,
    insufficient: sources.length === 0,
    message: result.message || null,
  };
}

module.exports = {
  applyRedactions,
  buildMeetingMessages,
  controlledRetrieve,
  normalizeMeetingOutput,
  resolveWhitelistedDocumentIds,
  snapshotForPacket,
};
