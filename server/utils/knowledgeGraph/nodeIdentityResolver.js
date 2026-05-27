const prisma = require("../prisma");
const { safeJsonParse } = require("../http");
const { KnowledgeGraph } = require("../../models/knowledgeGraph");
const {
  buildNodeKey,
  isStableNodeKey,
  nodeKeyCandidates,
  normalizeCanonicalKey,
} = require("./nodeIdentity");

function parseAliases(value = "[]") {
  const parsed = safeJsonParse(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .flatMap((alias) => {
      if (alias && typeof alias === "object") {
        return [alias.zh, alias.en, alias.name, alias.label].filter(Boolean);
      }
      return [alias].filter(Boolean);
    })
    .map((alias) => String(alias || "").trim())
    .filter(Boolean);
}

function toIdentity(row = null, identitySource = "nodeId", confidence = 1) {
  if (!row) return null;
  const nodeType = row.entityType || "concept";
  const nodeKey = buildNodeKey({
    entityType: nodeType,
    canonicalKey: row.canonicalKey,
  });
  return {
    nodeId: Number(row.id),
    nodeKey,
    canonicalKey: row.canonicalKey,
    nodeLabel:
      row.displayNameZh || row.displayNameEn || row.canonicalName || nodeKey,
    nodeType,
    confidence,
    identitySource,
    canonicalName: row.canonicalName,
    displayNameZh: row.displayNameZh || null,
    displayNameEn: row.displayNameEn || null,
  };
}

function identityCandidates(rows = [], identitySource = "label_fuzzy") {
  return rows
    .slice(0, 8)
    .map((row) => toIdentity(row, identitySource, row._score));
}

function scoreLabelMatch(row = {}, label = "") {
  const labelKey = KnowledgeGraph.canonicalKey(label);
  if (!labelKey) return 0;
  const names = [
    row.displayNameZh,
    row.displayNameEn,
    row.canonicalName,
    ...parseAliases(row.aliases),
  ].filter(Boolean);
  const keys = names.map((name) => KnowledgeGraph.canonicalKey(name));
  if (keys.some((key) => key === labelKey)) return 1;
  if (keys.some((key) => key.includes(labelKey) || labelKey.includes(key)))
    return 0.9;
  const bestOverlap = keys.reduce((best, key) => {
    if (!key || !labelKey) return best;
    const shorter = key.length < labelKey.length ? key : labelKey;
    const longer = key.length < labelKey.length ? labelKey : key;
    let prefix = 0;
    while (prefix < shorter.length && shorter[prefix] === longer[prefix])
      prefix += 1;
    return Math.max(best, prefix / Math.max(1, longer.length));
  }, 0);
  return bestOverlap >= 0.72 ? bestOverlap : 0;
}

async function workspaceNodes(workspaceId) {
  if (!workspaceId) return [];
  return await prisma.$queryRawUnsafe(
    `SELECT "id", "workspaceId", "canonicalName", "canonicalKey", "aliases",
      "entityType", "displayNameZh", "displayNameEn"
    FROM "KnowledgeNode"
    WHERE "workspaceId" = ?`,
    Number(workspaceId)
  );
}

async function resolveNodeIdentity({
  workspaceId,
  nodeId = null,
  nodeKey = null,
  canonicalKey = null,
  label = null,
  allowFuzzy = true,
  minConfidence = 0.88,
} = {}) {
  if (!workspaceId) return { success: false, reason: "workspace_required" };
  const id = Number(nodeId || 0);
  if (id > 0) {
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT "id", "workspaceId", "canonicalName", "canonicalKey", "aliases",
          "entityType", "displayNameZh", "displayNameEn"
        FROM "KnowledgeNode"
        WHERE "workspaceId" = ? AND "id" = ?
        LIMIT 1`,
        Number(workspaceId),
        id
      )
    )?.[0];
    if (row) return { success: true, node: toIdentity(row, "nodeId", 1) };
  }

  const keyText = String(nodeKey || "").trim();
  if (keyText && isStableNodeKey(keyText)) {
    const candidates = new Set(nodeKeyCandidates(keyText));
    const rows = await workspaceNodes(workspaceId);
    const row = rows.find((item) =>
      candidates.has(
        buildNodeKey({
          entityType: item.entityType,
          canonicalKey: item.canonicalKey,
        })
      )
    );
    if (row) return { success: true, node: toIdentity(row, "nodeKey", 1) };
  }

  const canonical = normalizeCanonicalKey(canonicalKey);
  if (canonical) {
    const row = (
      await prisma.$queryRawUnsafe(
        `SELECT "id", "workspaceId", "canonicalName", "canonicalKey", "aliases",
          "entityType", "displayNameZh", "displayNameEn"
        FROM "KnowledgeNode"
        WHERE "workspaceId" = ? AND "canonicalKey" = ?
        LIMIT 1`,
        Number(workspaceId),
        canonical
      )
    )?.[0];
    if (row) return { success: true, node: toIdentity(row, "canonicalKey", 1) };
  }

  const labelText = String(label || "").trim();
  if (!labelText)
    return {
      success: false,
      reason: "node_identity_not_found",
      candidates: [],
    };

  const rows = await workspaceNodes(workspaceId);
  const labelKey = KnowledgeGraph.canonicalKey(labelText);
  const exactRows = rows.filter((row) => {
    const labels = [row.displayNameZh, row.displayNameEn, row.canonicalName]
      .filter(Boolean)
      .map((name) => KnowledgeGraph.canonicalKey(name));
    return labels.includes(labelKey);
  });
  if (exactRows.length === 1)
    return {
      success: true,
      node: toIdentity(exactRows[0], "label_exact", 0.98),
    };
  if (exactRows.length > 1)
    return {
      success: false,
      reason: "ambiguous_node_identity",
      candidates: identityCandidates(
        exactRows.map((row) => ({ ...row, _score: 0.98 })),
        "label_exact"
      ),
    };

  const aliasRows = rows.filter((row) =>
    parseAliases(row.aliases)
      .map((alias) => KnowledgeGraph.canonicalKey(alias))
      .includes(labelKey)
  );
  if (aliasRows.length === 1)
    return { success: true, node: toIdentity(aliasRows[0], "alias", 0.94) };
  if (aliasRows.length > 1)
    return {
      success: false,
      reason: "ambiguous_node_identity",
      candidates: identityCandidates(
        aliasRows.map((row) => ({ ...row, _score: 0.94 })),
        "alias"
      ),
    };

  if (!allowFuzzy)
    return {
      success: false,
      reason: "node_identity_not_found",
      candidates: [],
    };

  const scored = rows
    .map((row) => ({ ...row, _score: scoreLabelMatch(row, labelText) }))
    .filter((row) => row._score > 0)
    .sort((a, b) => b._score - a._score);
  if (!scored.length)
    return {
      success: false,
      reason: "node_identity_not_found",
      candidates: [],
    };
  const [top, second] = scored;
  if (
    top._score >= minConfidence &&
    (!second || top._score - second._score >= 0.08)
  ) {
    return {
      success: true,
      node: toIdentity(top, "label_fuzzy", Number(top._score.toFixed(3))),
    };
  }
  return {
    success: false,
    reason:
      top._score >= minConfidence
        ? "ambiguous_node_identity"
        : "low_confidence_node_identity",
    candidates: identityCandidates(scored, "label_fuzzy"),
  };
}

module.exports = {
  resolveNodeIdentity,
  toIdentity,
};
