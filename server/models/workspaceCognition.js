const crypto = require("crypto");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const WorkspaceCognitionBatch = require("./workspaceCognitionBatch");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");

async function cognitionSyncReady() {
  return SyncV2.enabled("cognition") && (await SyncV2.schemaReady());
}

async function recordCognitionChange(
  tx,
  { workspaceId, eventType, changedPaths, payloadHint }
) {
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.workspaceDomain(workspaceId, "cognition"),
    content: payloadHint,
    eventType,
    changedPaths,
    payloadHint,
  });
}

const ASSERTION_TYPES = Object.freeze([
  "document_fact",
  "conclusion",
  "decision",
  "hypothesis",
  "open_question",
  "risk",
  "constraint",
]);
const VERIFICATION_STATUSES = Object.freeze([
  "candidate",
  "source_backed",
  "user_confirmed",
  "contested",
  "superseded",
  "rejected",
  "expired",
]);
const CREATED_BY_TYPES = Object.freeze([
  "document",
  "user",
  "assistant",
  "system",
]);
const STANCES = Object.freeze([
  "supports",
  "opposes",
  "conditional",
  "uncertain",
  "undecided",
]);
const POSITION_STATUSES = Object.freeze([
  "candidate",
  "confirmed",
  "withdrawn",
  "superseded",
]);
const DISCLOSURE_LEVELS = Object.freeze([
  "workspace_only",
  "meeting_allowed",
  "meeting_redacted",
  "blocked",
]);
const EVIDENCE_KINDS = Object.freeze(["supports", "refutes", "context"]);
const EVIDENCE_SOURCE_TYPES = Object.freeze([
  "document_chunk",
  "knowledge_graph_edge",
  "chat_turn",
  "manual_note",
  "external_reference",
  "thread_capsule_origin",
]);
const RELATION_TYPES = Object.freeze([
  "supports",
  "refutes",
  "conflicts_with",
  "depends_on",
  "answers",
  "supersedes",
  "derived_from",
]);
const FORMAL_STATUSES = new Set([
  "source_backed",
  "user_confirmed",
  "contested",
]);

function json(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? safeJsonParse(fallback, {}));
  } catch {
    return fallback;
  }
}

function clampConfidence(value = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function assertAllowed(value, values, field) {
  if (!values.includes(value)) {
    const error = new Error(`Invalid ${field}: ${value}`);
    error.code = `invalid_${field}`;
    throw error;
  }
  return value;
}

function normalizeStatement(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8_000);
}

function assertionHash(assertionType, statement) {
  return crypto
    .createHash("sha256")
    .update(
      `${assertionType}\u0000${normalizeStatement(statement).toLowerCase()}`
    )
    .digest("hex");
}

function contentHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function parseAssertion(row = null) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence || 0),
  };
}

function parsePosition(row = null) {
  if (!row) return null;
  return {
    ...row,
    conditions: safeJsonParse(row.conditionsJson, {}),
  };
}

function parseEvidence(row = null) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence || 0),
    metadata: safeJsonParse(row.metadataJson, {}),
  };
}

function parseProfile(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    revision: row.revision,
    contentHash: row.contentHash,
    sourceWatermark: row.sourceWatermark,
    generatedAt: row.generatedAt,
    ...safeJsonParse(row.profileJson, {}),
  };
}

async function createAssertion({
  workspaceId,
  assertionType,
  statement,
  verificationStatus = "candidate",
  confidence = 0,
  validFrom = null,
  validUntil = null,
  createdByType = "user",
  createdByUserId = null,
  disclosureLevel = "workspace_only",
  reviewReason = null,
} = {}) {
  workspaceId = Number(workspaceId);
  statement = normalizeStatement(statement);
  if (!workspaceId || !statement)
    throw new Error("workspace_and_statement_required");
  assertAllowed(assertionType, ASSERTION_TYPES, "assertion_type");
  assertAllowed(
    verificationStatus,
    VERIFICATION_STATUSES,
    "verification_status"
  );
  assertAllowed(createdByType, CREATED_BY_TYPES, "created_by_type");
  assertAllowed(disclosureLevel, DISCLOSURE_LEVELS, "disclosure_level");

  const normalizedHash = assertionHash(assertionType, statement);
  const existing = await prisma.workspace_cognitive_assertions.findUnique({
    where: { workspaceId_normalizedHash: { workspaceId, normalizedHash } },
  });
  if (existing) return { assertion: parseAssertion(existing), created: false };

  const data = {
    workspaceId,
    assertionType,
    statement,
    verificationStatus,
    confidence: clampConfidence(confidence),
    validFrom: validFrom ? new Date(validFrom) : null,
    validUntil: validUntil ? new Date(validUntil) : null,
    createdByType,
    createdByUserId: createdByUserId ? Number(createdByUserId) : null,
    normalizedHash,
    disclosureLevel,
    reviewReason,
  };
  const syncReady = await cognitionSyncReady();
  const assertion = syncReady
    ? await prisma.$transaction(async (tx) => {
        const created = await tx.workspace_cognitive_assertions.create({
          data,
        });
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.assertion_created",
          changedPaths: [`assertions.${created.id}`],
          payloadHint: {
            operation: "append",
            assertionId: created.id,
            assertionType: created.assertionType,
          },
        });
        return created;
      })
    : await prisma.workspace_cognitive_assertions.create({ data });
  return { assertion: parseAssertion(assertion), created: true };
}

async function addEvidence({
  workspaceId,
  assertionId,
  evidenceKind = "supports",
  sourceType,
  sourceRef,
  documentId = null,
  chunkId = null,
  chatId = null,
  threadId = null,
  graphEdgeId = null,
  sourceWorkspaceId = null,
  excerpt = null,
  confidence = 0,
  freshness = "current",
  disclosureLevel = "workspace_only",
  metadata = {},
} = {}) {
  workspaceId = Number(workspaceId);
  assertionId = Number(assertionId);
  sourceWorkspaceId = Number(sourceWorkspaceId || workspaceId);
  if (!workspaceId || !assertionId || !sourceRef)
    throw new Error("invalid_evidence_scope");
  if (sourceWorkspaceId !== workspaceId) {
    const error = new Error("cross_workspace_evidence_forbidden");
    error.code = "cross_workspace_evidence_forbidden";
    throw error;
  }
  assertAllowed(evidenceKind, EVIDENCE_KINDS, "evidence_kind");
  assertAllowed(sourceType, EVIDENCE_SOURCE_TYPES, "evidence_source_type");
  assertAllowed(disclosureLevel, DISCLOSURE_LEVELS, "disclosure_level");
  const assertion = await prisma.workspace_cognitive_assertions.findFirst({
    where: { id: assertionId, workspaceId },
  });
  if (!assertion) throw new Error("assertion_not_found");

  const writeEvidence = async (db) => {
    const evidence = await db.workspace_cognitive_evidence.upsert({
      where: {
        workspaceId_assertionId_sourceType_sourceRef_evidenceKind: {
          workspaceId,
          assertionId,
          sourceType,
          sourceRef: String(sourceRef),
          evidenceKind,
        },
      },
      create: {
        workspaceId,
        assertionId,
        evidenceKind,
        sourceType,
        sourceRef: String(sourceRef),
        documentId: documentId ? String(documentId) : null,
        chunkId: chunkId ? String(chunkId) : null,
        chatId: chatId ? Number(chatId) : null,
        threadId: threadId ? Number(threadId) : null,
        graphEdgeId: graphEdgeId ? String(graphEdgeId) : null,
        sourceWorkspaceId,
        excerpt: excerpt ? String(excerpt).slice(0, 4_000) : null,
        confidence: clampConfidence(confidence),
        freshness,
        disclosureLevel,
        metadataJson: json(metadata),
      },
      update: {
        excerpt: excerpt ? String(excerpt).slice(0, 4_000) : undefined,
        confidence: clampConfidence(confidence),
        freshness,
        disclosureLevel,
        metadataJson: json(metadata),
      },
    });

    if (
      assertion.assertionType === "document_fact" &&
      sourceType === "document_chunk" &&
      documentId &&
      chunkId &&
      assertion.verificationStatus === "candidate"
    ) {
      await db.workspace_cognitive_assertions.update({
        where: { id: assertion.id },
        data: { verificationStatus: "source_backed" },
      });
    }
    return evidence;
  };
  const syncReady = await cognitionSyncReady();
  const evidence = syncReady
    ? await prisma.$transaction(async (tx) => {
        const saved = await writeEvidence(tx);
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.evidence_updated",
          changedPaths: [`evidence.${saved.id}`],
          payloadHint: {
            operation: "upsert",
            evidenceId: saved.id,
            assertionId,
          },
        });
        return saved;
      })
    : await writeEvidence(prisma);
  return parseEvidence(evidence);
}

async function createPosition({
  workspaceId,
  assertionId,
  subjectUserId,
  proposedByUserId = null,
  stance = "supports",
  rationale = null,
  conditions = {},
  status = "candidate",
  meetingDisclosure = "workspace_only",
  sourceChatId = null,
} = {}) {
  workspaceId = Number(workspaceId);
  assertionId = Number(assertionId);
  subjectUserId = Number(subjectUserId);
  if (!workspaceId || !assertionId || !subjectUserId)
    throw new Error("invalid_position_scope");
  assertAllowed(stance, STANCES, "stance");
  assertAllowed(status, POSITION_STATUSES, "position_status");
  assertAllowed(meetingDisclosure, DISCLOSURE_LEVELS, "meeting_disclosure");
  const assertion = await prisma.workspace_cognitive_assertions.findFirst({
    where: { id: assertionId, workspaceId },
  });
  if (!assertion) throw new Error("assertion_not_found");

  const existing = await prisma.workspace_cognitive_positions.findFirst({
    where: {
      workspaceId,
      assertionId,
      subjectUserId,
      sourceChatId: sourceChatId ? Number(sourceChatId) : null,
      status: { in: ["candidate", "confirmed"] },
    },
    orderBy: { id: "desc" },
  });
  if (existing) return { position: parsePosition(existing), created: false };

  const data = {
    workspaceId,
    assertionId,
    subjectUserId,
    proposedByUserId: proposedByUserId ? Number(proposedByUserId) : null,
    stance,
    rationale: rationale ? String(rationale).slice(0, 4_000) : null,
    conditionsJson: json(conditions),
    status,
    meetingDisclosure,
    confirmedAt: status === "confirmed" ? new Date() : null,
    sourceChatId: sourceChatId ? Number(sourceChatId) : null,
  };
  const syncReady = await cognitionSyncReady();
  const position = syncReady
    ? await prisma.$transaction(async (tx) => {
        const created = await tx.workspace_cognitive_positions.create({ data });
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.position_created",
          changedPaths: [`positions.${created.id}`],
          payloadHint: {
            operation: "append",
            positionId: created.id,
            assertionId,
          },
        });
        return created;
      })
    : await prisma.workspace_cognitive_positions.create({ data });
  return { position: parsePosition(position), created: true };
}

async function createRelation({
  workspaceId,
  fromAssertionId,
  toAssertionId,
  relationType,
  confidence = 0,
  createdByType = "system",
} = {}) {
  workspaceId = Number(workspaceId);
  fromAssertionId = Number(fromAssertionId);
  toAssertionId = Number(toAssertionId);
  assertAllowed(relationType, RELATION_TYPES, "relation_type");
  if (!workspaceId || !fromAssertionId || !toAssertionId)
    throw new Error("invalid_relation_scope");
  const count = await prisma.workspace_cognitive_assertions.count({
    where: { workspaceId, id: { in: [fromAssertionId, toAssertionId] } },
  });
  if (count !== new Set([fromAssertionId, toAssertionId]).size)
    throw new Error("relation_assertion_not_found");
  const upsertRelation = (db) =>
    db.workspace_cognitive_relations.upsert({
      where: {
        workspaceId_fromAssertionId_toAssertionId_relationType: {
          workspaceId,
          fromAssertionId,
          toAssertionId,
          relationType,
        },
      },
      create: {
        workspaceId,
        fromAssertionId,
        toAssertionId,
        relationType,
        confidence: clampConfidence(confidence),
        createdByType,
      },
      update: { confidence: clampConfidence(confidence) },
    });
  if (!(await cognitionSyncReady())) return await upsertRelation(prisma);
  return await prisma.$transaction(async (tx) => {
    const relation = await upsertRelation(tx);
    await recordCognitionChange(tx, {
      workspaceId,
      eventType: "cognition.relation_upserted",
      changedPaths: [`relations.${relation.id}`],
      payloadHint: {
        operation: "upsert",
        relationId: relation.id,
        relationType,
      },
    });
    return relation;
  });
}

async function patchAssertion(workspaceId, assertionId, patch = {}) {
  workspaceId = Number(workspaceId);
  assertionId = Number(assertionId);
  const existing = await prisma.workspace_cognitive_assertions.findFirst({
    where: { id: assertionId, workspaceId },
  });
  if (!existing) return null;
  const data = {};
  if (patch.statement !== undefined) {
    data.statement = normalizeStatement(patch.statement);
    data.normalizedHash = assertionHash(existing.assertionType, data.statement);
  }
  if (patch.verificationStatus !== undefined)
    data.verificationStatus = assertAllowed(
      patch.verificationStatus,
      VERIFICATION_STATUSES,
      "verification_status"
    );
  if (patch.confidence !== undefined)
    data.confidence = clampConfidence(patch.confidence);
  if (patch.disclosureLevel !== undefined)
    data.disclosureLevel = assertAllowed(
      patch.disclosureLevel,
      DISCLOSURE_LEVELS,
      "disclosure_level"
    );
  if (patch.reviewReason !== undefined)
    data.reviewReason = patch.reviewReason
      ? String(patch.reviewReason).slice(0, 2_000)
      : null;
  if (patch.validFrom !== undefined)
    data.validFrom = patch.validFrom ? new Date(patch.validFrom) : null;
  if (patch.validUntil !== undefined)
    data.validUntil = patch.validUntil ? new Date(patch.validUntil) : null;
  const updateAssertion = (db) =>
    db.workspace_cognitive_assertions.update({
      where: { id: assertionId },
      data,
    });
  const syncReady = await cognitionSyncReady();
  const updated = syncReady
    ? await prisma.$transaction(async (tx) => {
        const saved = await updateAssertion(tx);
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.assertion_updated",
          changedPaths: [`assertions.${assertionId}`],
          payloadHint: { operation: "update", assertionId },
        });
        return saved;
      })
    : await updateAssertion(prisma);
  return parseAssertion(updated);
}

async function patchPosition(workspaceId, positionId, patch = {}) {
  workspaceId = Number(workspaceId);
  positionId = Number(positionId);
  const existing = await prisma.workspace_cognitive_positions.findFirst({
    where: { id: positionId, workspaceId },
  });
  if (!existing) return null;
  const data = {};
  if (patch.stance !== undefined)
    data.stance = assertAllowed(patch.stance, STANCES, "stance");
  if (patch.status !== undefined) {
    data.status = assertAllowed(
      patch.status,
      POSITION_STATUSES,
      "position_status"
    );
    data.confirmedAt =
      patch.status === "confirmed" ? new Date() : existing.confirmedAt;
  }
  if (patch.rationale !== undefined)
    data.rationale = patch.rationale
      ? String(patch.rationale).slice(0, 4_000)
      : null;
  if (patch.conditions !== undefined)
    data.conditionsJson = json(patch.conditions);
  if (patch.meetingDisclosure !== undefined)
    data.meetingDisclosure = assertAllowed(
      patch.meetingDisclosure,
      DISCLOSURE_LEVELS,
      "meeting_disclosure"
    );
  const updatePosition = async (db) => {
    const position = await db.workspace_cognitive_positions.update({
      where: { id: positionId },
      data,
    });
    if (position.status === "confirmed") {
      await db.workspace_cognitive_assertions.updateMany({
        where: {
          id: position.assertionId,
          workspaceId,
          verificationStatus: "candidate",
        },
        data: { verificationStatus: "user_confirmed", reviewReason: null },
      });
    } else if (["withdrawn", "superseded"].includes(position.status)) {
      const confirmedCount = await db.workspace_cognitive_positions.count({
        where: {
          workspaceId,
          assertionId: position.assertionId,
          status: "confirmed",
        },
      });
      if (!confirmedCount) {
        await db.workspace_cognitive_assertions.updateMany({
          where: {
            id: position.assertionId,
            workspaceId,
            createdByType: "user",
            verificationStatus: "user_confirmed",
          },
          data: {
            verificationStatus: "candidate",
            reviewReason: "all_user_positions_withdrawn",
          },
        });
      }
    }
    return position;
  };
  const syncReady = await cognitionSyncReady();
  const position = syncReady
    ? await prisma.$transaction(async (tx) => {
        const saved = await updatePosition(tx);
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.position_updated",
          changedPaths: [`positions.${positionId}`],
          payloadHint: { operation: "update", positionId },
        });
        return saved;
      })
    : await updatePosition(prisma);
  return parsePosition(position);
}

async function patchEvidence(workspaceId, evidenceId, patch = {}) {
  workspaceId = Number(workspaceId);
  evidenceId = Number(evidenceId);
  const existing = await prisma.workspace_cognitive_evidence.findFirst({
    where: { id: evidenceId, workspaceId },
  });
  if (!existing) return null;
  const data = {};
  if (patch.disclosureLevel !== undefined)
    data.disclosureLevel = assertAllowed(
      patch.disclosureLevel,
      DISCLOSURE_LEVELS,
      "disclosure_level"
    );
  if (patch.freshness !== undefined) {
    if (
      !["current", "stale", "missing", "review_required"].includes(
        patch.freshness
      )
    )
      throw new Error("invalid_evidence_freshness");
    data.freshness = patch.freshness;
  }
  const updateEvidence = (db) =>
    db.workspace_cognitive_evidence.update({
      where: { id: evidenceId },
      data,
    });
  const syncReady = await cognitionSyncReady();
  const evidence = syncReady
    ? await prisma.$transaction(async (tx) => {
        const saved = await updateEvidence(tx);
        await recordCognitionChange(tx, {
          workspaceId,
          eventType: "cognition.evidence_updated",
          changedPaths: [`evidence.${evidenceId}`],
          payloadHint: { operation: "update", evidenceId },
        });
        return saved;
      })
    : await updateEvidence(prisma);
  return parseEvidence(evidence);
}

async function listItems(workspaceId, filters = {}) {
  workspaceId = Number(workspaceId);
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  const assertions = await prisma.workspace_cognitive_assertions.findMany({
    where: {
      workspaceId,
      ...(filters.assertionType
        ? { assertionType: filters.assertionType }
        : {}),
      ...(filters.verificationStatus
        ? { verificationStatus: filters.verificationStatus }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  const ids = assertions.map((item) => item.id);
  const [positions, evidence, relations] = ids.length
    ? await Promise.all([
        prisma.workspace_cognitive_positions.findMany({
          where: { workspaceId, assertionId: { in: ids } },
          orderBy: { updatedAt: "desc" },
        }),
        prisma.workspace_cognitive_evidence.findMany({
          where: { workspaceId, assertionId: { in: ids } },
          orderBy: { updatedAt: "desc" },
        }),
        prisma.workspace_cognitive_relations.findMany({
          where: {
            workspaceId,
            OR: [
              { fromAssertionId: { in: ids } },
              { toAssertionId: { in: ids } },
            ],
          },
        }),
      ])
    : [[], [], []];
  return {
    assertions: assertions.map(parseAssertion),
    positions: positions.map(parsePosition),
    evidence: evidence.map(parseEvidence),
    relations,
  };
}

function groupByType(assertions = []) {
  const output = {};
  for (const type of ASSERTION_TYPES) output[type] = [];
  for (const assertion of assertions)
    output[assertion.assertionType]?.push(assertion);
  return output;
}

async function rebuildProfile(workspaceId) {
  workspaceId = Number(workspaceId);
  const canonicalCount = await prisma.workspace_cognitive_items.count({
    where: { workspaceId },
  });
  if (canonicalCount)
    return parseProfile(
      await WorkspaceCognitionBatch.rebuildCanonicalProfile(workspaceId)
    );
  const [workspace, assertions, positions, evidence, relations, latest] =
    await Promise.all([
      prisma.workspaces.findUnique({ where: { id: workspaceId } }),
      prisma.workspace_cognitive_assertions.findMany({
        where: {
          workspaceId,
          verificationStatus: { in: [...FORMAL_STATUSES] },
        },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.workspace_cognitive_positions.findMany({
        where: { workspaceId, status: "confirmed" },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.workspace_cognitive_evidence.findMany({
        where: { workspaceId, freshness: "current" },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.workspace_cognitive_relations.findMany({ where: { workspaceId } }),
      prisma.workspace_cognitive_profiles.findFirst({
        where: { workspaceId },
        orderBy: { revision: "desc" },
      }),
    ]);
  const grouped = groupByType(assertions.map(parseAssertion));
  const evidenceByAssertion = new Map();
  for (const item of evidence) {
    if (!evidenceByAssertion.has(item.assertionId))
      evidenceByAssertion.set(item.assertionId, []);
    evidenceByAssertion.get(item.assertionId).push(parseEvidence(item));
  }
  const assertionById = new Map(
    assertions.map((item) => [item.id, parseAssertion(item)])
  );
  const conflicts = relations
    .filter((relation) => relation.relationType === "conflicts_with")
    .map((relation) => ({
      kind: "assertion_conflict",
      relationId: relation.id,
      left: assertionById.get(relation.fromAssertionId) || null,
      right: assertionById.get(relation.toAssertionId) || null,
    }))
    .filter((item) => item.left && item.right);
  const positionGroups = {};
  const parsedPositions = positions.map(parsePosition);
  const positionsByAssertion = new Map();
  for (const position of parsedPositions) {
    const key = String(position.subjectUserId);
    if (!positionGroups[key]) positionGroups[key] = [];
    positionGroups[key].push({
      ...position,
      assertion: assertionById.get(position.assertionId) || null,
    });
    if (!positionsByAssertion.has(position.assertionId))
      positionsByAssertion.set(position.assertionId, []);
    positionsByAssertion.get(position.assertionId).push(position);
  }
  const positionConflicts = [...positionsByAssertion.entries()]
    .filter(([, values]) => {
      const stances = new Set(values.map((item) => item.stance));
      return stances.has("supports") && stances.has("opposes");
    })
    .map(([assertionId, values]) => ({
      kind: "position_conflict",
      assertion: assertionById.get(assertionId) || null,
      positions: values,
    }))
    .filter((item) => item.assertion);
  const evidenceConflicts = [...evidenceByAssertion.entries()]
    .filter(([, values]) => {
      const kinds = new Set(values.map((item) => item.evidenceKind));
      return kinds.has("supports") && kinds.has("refutes");
    })
    .map(([assertionId, values]) => ({
      kind: "evidence_conflict",
      assertion: assertionById.get(assertionId) || null,
      evidence: values,
    }))
    .filter((item) => item.assertion);
  const sourceBacked = assertions.filter(
    (item) => item.verificationStatus === "source_backed"
  );
  const evidenceCovered = sourceBacked.filter((item) =>
    (evidenceByAssertion.get(item.id) || []).some(
      (source) => source.sourceType !== "thread_capsule_origin"
    )
  ).length;
  const lastUpdatedAt = assertions
    .map((item) => new Date(item.updatedAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const profileBody = {
    scope: {
      workspaceId,
      name: workspace?.name || null,
      slug: workspace?.slug || null,
      objective: workspace?.openAiPrompt || null,
    },
    facts: grouped.document_fact,
    conclusions: grouped.conclusion,
    decisions: grouped.decision,
    hypotheses: grouped.hypothesis,
    openQuestions: grouped.open_question,
    risks: grouped.risk,
    constraints: grouped.constraint,
    positionsByUser: positionGroups,
    disputes: [...conflicts, ...positionConflicts, ...evidenceConflicts],
    evidenceCoverage: {
      sourceBackedAssertions: sourceBacked.length,
      coveredAssertions: evidenceCovered,
      ratio: sourceBacked.length ? evidenceCovered / sourceBacked.length : 1,
      staleEvidenceCount: await prisma.workspace_cognitive_evidence.count({
        where: { workspaceId, freshness: { not: "current" } },
      }),
    },
  };
  const revision = Number(latest?.revision || 0) + 1;
  const hash = contentHash(profileBody);
  const syncReady = await cognitionSyncReady();
  const profile = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace_cognitive_profiles.create({
      data: {
        workspaceId,
        revision,
        profileJson: json(profileBody),
        sourceWatermark: lastUpdatedAt
          ? new Date(lastUpdatedAt).toISOString()
          : null,
        contentHash: hash,
      },
    });
    if (assertions.length) {
      await tx.workspace_cognitive_assertions.updateMany({
        where: { workspaceId, id: { in: assertions.map((item) => item.id) } },
        data: { profileRevision: revision },
      });
    }
    if (syncReady) {
      await recordCognitionChange(tx, {
        workspaceId,
        eventType: "cognition.profile_rebuilt",
        changedPaths: ["profile", "assertions"],
        payloadHint: {
          operation: "rebuild",
          profileId: created.id,
          revision,
        },
      });
    }
    return created;
  });
  return parseProfile(profile);
}

async function getLatestProfile(
  workspaceId,
  { rebuildIfMissing = false } = {}
) {
  let row = await prisma.workspace_cognitive_profiles.findFirst({
    where: { workspaceId: Number(workspaceId) },
    orderBy: { revision: "desc" },
  });
  let profile = parseProfile(row);
  if (
    rebuildIfMissing &&
    process.env.WORKSPACE_COGNITION_BATCH_V2 !== "0" &&
    (!profile || profile.canonical !== true)
  ) {
    await WorkspaceCognitionBatch.rebuildCanonicalProfile(workspaceId);
    row = await prisma.workspace_cognitive_profiles.findFirst({
      where: { workspaceId: Number(workspaceId) },
      orderBy: { revision: "desc" },
    });
    profile = parseProfile(row);
  } else if (!profile && rebuildIfMissing) {
    return await rebuildProfile(workspaceId);
  }
  if (!profile) return null;
  const state = await WorkspaceCognitionBatch.getProfileState(workspaceId);
  return { ...profile, ...state };
}

async function markDocumentEvidenceStale(
  workspaceId,
  documentIds = [],
  reason = "source_changed"
) {
  workspaceId = Number(workspaceId);
  const ids = documentIds.map(String).filter(Boolean);
  if (!workspaceId || !ids.length) return { evidence: 0, assertions: 0 };
  const evidenceRows = await prisma.workspace_cognitive_evidence.findMany({
    where: { workspaceId, documentId: { in: ids } },
    select: { assertionId: true },
  });
  const assertionIds = [
    ...new Set(evidenceRows.map((item) => item.assertionId)),
  ];
  const evidenceResult = await prisma.workspace_cognitive_evidence.updateMany({
    where: { workspaceId, documentId: { in: ids } },
    data: { freshness: "stale" },
  });
  const assertionResult = assertionIds.length
    ? await prisma.workspace_cognitive_assertions.updateMany({
        where: {
          workspaceId,
          id: { in: assertionIds },
          verificationStatus: {
            in: ["source_backed", "user_confirmed", "contested"],
          },
        },
        data: { verificationStatus: "candidate", reviewReason: reason },
      })
    : { count: 0 };
  await WorkspaceCognitionBatch.appendEvidenceEventsForSources({
    workspaceId,
    documentIds: ids,
    eventType: "stale",
    reason,
  });
  return { evidence: evidenceResult.count, assertions: assertionResult.count };
}

async function markChatEvidenceStale(
  workspaceId,
  chatIds = [],
  reason = "source_chat_changed"
) {
  workspaceId = Number(workspaceId);
  const ids = chatIds.map(Number).filter(Number.isInteger);
  if (!workspaceId || !ids.length) return { evidence: 0, assertions: 0 };
  const evidenceRows = await prisma.workspace_cognitive_evidence.findMany({
    where: { workspaceId, chatId: { in: ids } },
    select: { assertionId: true },
  });
  const assertionIds = [
    ...new Set(evidenceRows.map((item) => item.assertionId)),
  ];
  const evidenceResult = await prisma.workspace_cognitive_evidence.updateMany({
    where: { workspaceId, chatId: { in: ids } },
    data: { freshness: "stale" },
  });
  const assertionResult = assertionIds.length
    ? await prisma.workspace_cognitive_assertions.updateMany({
        where: {
          workspaceId,
          id: { in: assertionIds },
          verificationStatus: {
            in: ["source_backed", "user_confirmed", "contested"],
          },
        },
        data: { verificationStatus: "candidate", reviewReason: reason },
      })
    : { count: 0 };
  await WorkspaceCognitionBatch.appendEvidenceEventsForSources({
    workspaceId,
    chatIds: ids,
    eventType: reason.includes("deleted") ? "missing" : "stale",
    reason,
  });
  return { evidence: evidenceResult.count, assertions: assertionResult.count };
}

async function createExtractionJob(data = {}) {
  return await prisma.workspace_cognitive_extraction_jobs.create({ data });
}

async function updateExtractionJob(jobId, data = {}) {
  return await prisma.workspace_cognitive_extraction_jobs.update({
    where: { id: Number(jobId) },
    data,
  });
}

async function deleteWorkspaceData(workspaceIds = [], db = prisma) {
  const ids = [...new Set(workspaceIds.map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0
  );
  if (!ids.length) return;
  await WorkspaceCognitionBatch.deleteWorkspaceBatchData(ids, db);
  const where = { workspaceId: { in: ids } };
  await db.workspace_meeting_audit_events.deleteMany({ where });
  await db.workspace_meeting_sessions.deleteMany({ where });
  await db.workspace_meeting_authorizations.deleteMany({ where });
  await db.workspace_meeting_packets.deleteMany({ where });
  await db.workspace_cognitive_extraction_jobs.deleteMany({ where });
  await db.workspace_cognitive_evidence.deleteMany({ where });
  await db.workspace_cognitive_positions.deleteMany({ where });
  await db.workspace_cognitive_relations.deleteMany({ where });
  await db.workspace_cognitive_profiles.deleteMany({ where });
  await db.workspace_cognitive_assertions.deleteMany({ where });
}

module.exports = {
  WorkspaceCognition: {
    createAssertion,
    addEvidence,
    createPosition,
    createRelation,
    patchAssertion,
    patchPosition,
    patchEvidence,
    listItems,
    rebuildProfile,
    getLatestProfile,
    markDocumentEvidenceStale,
    markChatEvidenceStale,
    createExtractionJob,
    updateExtractionJob,
    deleteWorkspaceData,
    ...WorkspaceCognitionBatch,
  },
  ASSERTION_TYPES,
  VERIFICATION_STATUSES,
  STANCES,
  POSITION_STATUSES,
  DISCLOSURE_LEVELS,
  EVIDENCE_SOURCE_TYPES,
  RELATION_TYPES,
  normalizeStatement,
  assertionHash,
  contentHash,
};
