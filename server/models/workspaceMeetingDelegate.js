const { v4: uuidv4 } = require("uuid");
const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");
const { contentHash, WorkspaceCognition } = require("./workspaceCognition");
const { WorkspaceThread } = require("./workspaceThread");
const { SyncV2 } = require("./syncV2");
const { nodeKeys } = require("../utils/syncV2/nodeRegistry");

async function meetingSyncReady() {
  return SyncV2.enabled("meetings") && (await SyncV2.schemaReady());
}

async function recordMeetingChange(
  tx,
  { workspaceId, eventType, changedPaths, payloadHint }
) {
  return await SyncV2.recordNodeChange(tx, {
    nodeKey: nodeKeys.workspaceDomain(workspaceId, "meetings"),
    content: payloadHint,
    eventType,
    changedPaths,
    payloadHint,
  });
}

function json(value, fallback = "{}") {
  try {
    return JSON.stringify(value ?? safeJsonParse(fallback, {}));
  } catch {
    return fallback;
  }
}

function parsePacket(row = null) {
  if (!row) return null;
  return {
    ...row,
    selection: safeJsonParse(row.selectionJson, {}),
    sourceWhitelist: safeJsonParse(row.sourceWhitelistJson, {}),
    disclosureRules: safeJsonParse(row.disclosureRulesJson, {}),
    redactionRules: safeJsonParse(row.redactionRulesJson, []),
  };
}

function parseAuthorization(row = null) {
  if (!row) return null;
  return {
    ...row,
    targetScope: safeJsonParse(row.targetScopeJson, {}),
    limits: safeJsonParse(row.limitsJson, {}),
    conditions: safeJsonParse(row.conditionsJson, {}),
  };
}

function parseAudit(row = null) {
  if (!row) return null;
  return {
    ...row,
    request: safeJsonParse(row.requestJson, {}),
    result: safeJsonParse(row.resultJson, {}),
    evidenceRefs: safeJsonParse(row.evidenceRefsJson, []),
  };
}

async function authorizationsForPacket(workspaceId, packetId) {
  return (
    await prisma.workspace_meeting_authorizations.findMany({
      where: {
        workspaceId: Number(workspaceId),
        meetingPacketId: Number(packetId),
      },
      orderBy: { id: "asc" },
    })
  ).map(parseAuthorization);
}

async function getPacket(workspaceId, packetId) {
  const packet = await prisma.workspace_meeting_packets.findFirst({
    where: { id: Number(packetId), workspaceId: Number(workspaceId) },
  });
  if (!packet) return null;
  return {
    ...parsePacket(packet),
    authorizations: await authorizationsForPacket(workspaceId, packetId),
  };
}

async function listPackets(workspaceId) {
  const packets = await prisma.workspace_meeting_packets.findMany({
    where: { workspaceId: Number(workspaceId) },
    orderBy: [{ updatedAt: "desc" }, { revision: "desc" }],
  });
  return packets.map(parsePacket);
}

async function replaceAuthorizations(
  tx,
  packet,
  authorizations = [],
  userId = null
) {
  await tx.workspace_meeting_authorizations.deleteMany({
    where: { workspaceId: packet.workspaceId, meetingPacketId: packet.id },
  });
  for (const authorization of authorizations) {
    if (!authorization?.actionType) continue;
    await tx.workspace_meeting_authorizations.create({
      data: {
        workspaceId: packet.workspaceId,
        meetingPacketId: packet.id,
        actionType: String(authorization.actionType).slice(0, 120),
        targetScopeJson: json(authorization.targetScope || {}),
        limitsJson: json(authorization.limits || {}),
        conditionsJson: json(authorization.conditions || {}),
        validFrom: authorization.validFrom
          ? new Date(authorization.validFrom)
          : null,
        validUntil: authorization.validUntil
          ? new Date(authorization.validUntil)
          : null,
        allowConditional: Boolean(authorization.allowConditional),
        requiresSecondApproval: Boolean(authorization.requiresSecondApproval),
        status: "active",
        createdByUserId: userId ? Number(userId) : null,
      },
    });
  }
}

async function createPacket({ workspaceId, userId = null, data = {} } = {}) {
  workspaceId = Number(workspaceId);
  if (!workspaceId || !data.title)
    throw new Error("meeting_packet_title_required");
  const syncReady = await meetingSyncReady();
  const packet = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace_meeting_packets.create({
      data: {
        workspaceId,
        packetKey: uuidv4(),
        revision: 1,
        createdByUserId: userId ? Number(userId) : null,
        delegateUserId: data.delegateUserId
          ? Number(data.delegateUserId)
          : userId
            ? Number(userId)
            : null,
        title: String(data.title).slice(0, 240),
        objective: data.objective
          ? String(data.objective).slice(0, 4_000)
          : null,
        status: "draft",
        profileRevision: data.profileRevision
          ? Number(data.profileRevision)
          : null,
        selectionJson: json(data.selection || {}),
        sourceWhitelistJson: json(data.sourceWhitelist || {}),
        disclosureRulesJson: json(data.disclosureRules || {}),
        redactionRulesJson: json(data.redactionRules || [], "[]"),
      },
    });
    await replaceAuthorizations(tx, created, data.authorizations || [], userId);
    if (syncReady) {
      await recordMeetingChange(tx, {
        workspaceId,
        eventType: "meeting.packet_created",
        changedPaths: [`packets.${created.id}`],
        payloadHint: {
          operation: "append",
          packetId: created.id,
          revision: created.revision,
          status: created.status,
        },
      });
    }
    return created;
  });
  return await getPacket(workspaceId, packet.id);
}

async function updatePacket({
  workspaceId,
  packetId,
  userId = null,
  data = {},
} = {}) {
  const existing = await getPacket(workspaceId, packetId);
  if (!existing) return null;
  if (existing.status === "revoked") throw new Error("meeting_packet_revoked");
  const patch = {
    title: data.title ? String(data.title).slice(0, 240) : existing.title,
    objective:
      data.objective !== undefined
        ? data.objective
          ? String(data.objective).slice(0, 4_000)
          : null
        : existing.objective,
    delegateUserId:
      data.delegateUserId !== undefined
        ? data.delegateUserId
          ? Number(data.delegateUserId)
          : null
        : existing.delegateUserId,
    profileRevision:
      data.profileRevision !== undefined
        ? data.profileRevision
          ? Number(data.profileRevision)
          : null
        : existing.profileRevision,
    selectionJson: json(data.selection ?? existing.selection),
    sourceWhitelistJson: json(data.sourceWhitelist ?? existing.sourceWhitelist),
    disclosureRulesJson: json(data.disclosureRules ?? existing.disclosureRules),
    redactionRulesJson: json(
      data.redactionRules ?? existing.redactionRules,
      "[]"
    ),
  };

  const syncReady = await meetingSyncReady();
  const packet = await prisma.$transaction(async (tx) => {
    let target;
    if (existing.status === "frozen") {
      target = await tx.workspace_meeting_packets.create({
        data: {
          workspaceId: existing.workspaceId,
          packetKey: existing.packetKey,
          revision: existing.revision + 1,
          createdByUserId: userId ? Number(userId) : existing.createdByUserId,
          status: "draft",
          ...patch,
        },
      });
    } else {
      target = await tx.workspace_meeting_packets.update({
        where: { id: existing.id },
        data: patch,
      });
    }
    await replaceAuthorizations(
      tx,
      target,
      data.authorizations ?? existing.authorizations,
      userId
    );
    if (syncReady) {
      await recordMeetingChange(tx, {
        workspaceId: existing.workspaceId,
        eventType: "meeting.packet_updated",
        changedPaths: [`packets.${target.id}`],
        payloadHint: {
          operation: existing.status === "frozen" ? "revise" : "update",
          packetId: target.id,
          revision: target.revision,
          status: target.status,
        },
      });
    }
    return target;
  });
  return await getPacket(workspaceId, packet.id);
}

function selectedIds(selection = {}, key) {
  return [
    ...new Set(
      (Array.isArray(selection?.[key]) ? selection[key] : []).map(Number)
    ),
  ].filter((id) => Number.isInteger(id) && id > 0);
}

async function buildFrozenSnapshot(packet) {
  const selection = packet.selection || {};
  const assertionIds = selectedIds(selection, "assertionIds");
  const positionIds = selectedIds(selection, "positionIds");
  const evidenceIds = selectedIds(selection, "evidenceIds");
  const [profile, assertions, positions, evidence, relations] =
    await Promise.all([
      packet.profileRevision
        ? prisma.workspace_cognitive_profiles.findFirst({
            where: {
              workspaceId: packet.workspaceId,
              revision: packet.profileRevision,
            },
          })
        : prisma.workspace_cognitive_profiles.findFirst({
            where: { workspaceId: packet.workspaceId },
            orderBy: { revision: "desc" },
          }),
      prisma.workspace_cognitive_assertions.findMany({
        where: { workspaceId: packet.workspaceId, id: { in: assertionIds } },
      }),
      prisma.workspace_cognitive_positions.findMany({
        where: { workspaceId: packet.workspaceId, id: { in: positionIds } },
      }),
      prisma.workspace_cognitive_evidence.findMany({
        where: { workspaceId: packet.workspaceId, id: { in: evidenceIds } },
      }),
      prisma.workspace_cognitive_relations.findMany({
        where: {
          workspaceId: packet.workspaceId,
          OR: [
            { fromAssertionId: { in: assertionIds } },
            { toAssertionId: { in: assertionIds } },
          ],
        },
      }),
    ]);
  if (!profile) throw new Error("cognitive_profile_required");
  if (assertions.length !== assertionIds.length)
    throw new Error("invalid_assertion_selection");
  if (positions.length !== positionIds.length)
    throw new Error("invalid_position_selection");
  if (evidence.length !== evidenceIds.length)
    throw new Error("invalid_evidence_selection");

  const formal = new Set(["source_backed", "user_confirmed", "contested"]);
  if (
    assertions.some(
      (item) => Number(item.profileRevision) !== Number(profile.revision)
    )
  )
    throw new Error("assertion_profile_revision_mismatch");
  if (assertions.some((item) => !formal.has(item.verificationStatus)))
    throw new Error("unconfirmed_assertion_forbidden");
  if (
    assertions.some(
      (item) =>
        !["meeting_allowed", "meeting_redacted"].includes(item.disclosureLevel)
    )
  )
    throw new Error("assertion_disclosure_not_approved");
  if (positions.some((item) => item.status !== "confirmed"))
    throw new Error("unconfirmed_position_forbidden");
  if (
    positions.some(
      (item) =>
        !["meeting_allowed", "meeting_redacted"].includes(
          item.meetingDisclosure
        )
    )
  )
    throw new Error("position_disclosure_not_approved");
  if (
    packet.delegateUserId &&
    positions.some(
      (item) => Number(item.subjectUserId) !== Number(packet.delegateUserId)
    )
  )
    throw new Error("delegate_cannot_carry_other_user_position");
  if (evidence.some((item) => item.freshness !== "current"))
    throw new Error("stale_evidence_forbidden");
  if (evidence.some((item) => item.sourceType === "thread_capsule_origin"))
    throw new Error("capsule_cannot_be_meeting_evidence");
  if (
    evidence.some(
      (item) =>
        !["meeting_allowed", "meeting_redacted"].includes(item.disclosureLevel)
    )
  )
    throw new Error("evidence_disclosure_not_approved");
  const selectedAssertionSet = new Set(assertionIds);
  if (positions.some((item) => !selectedAssertionSet.has(item.assertionId)))
    throw new Error("position_assertion_not_selected");
  if (evidence.some((item) => !selectedAssertionSet.has(item.assertionId)))
    throw new Error("evidence_assertion_not_selected");
  for (const assertion of assertions.filter(
    (item) => item.assertionType === "document_fact"
  )) {
    const hasDocumentEvidence = evidence.some(
      (item) =>
        item.assertionId === assertion.id &&
        item.sourceType === "document_chunk" &&
        item.evidenceKind === "supports" &&
        item.documentId &&
        item.chunkId
    );
    if (!hasDocumentEvidence)
      throw new Error("document_fact_meeting_evidence_required");
  }
  const canonicalItems = await prisma.workspace_cognitive_items.findMany({
    where: {
      workspaceId: packet.workspaceId,
      id: {
        in: assertions
          .map((item) => item.canonicalItemId)
          .filter((id) => Number.isInteger(Number(id)))
          .map(Number),
      },
    },
  });
  const canonicalById = new Map(canonicalItems.map((item) => [item.id, item]));
  const snapshotAssertions = assertions.map((assertion) => {
    const canonical = canonicalById.get(assertion.canonicalItemId);
    return {
      ...assertion,
      canonicalItemId: canonical?.id || assertion.canonicalItemId || null,
      canonicalItemKey: canonical?.itemKey || null,
      canonicalItemVersion: canonical?.version || null,
    };
  });

  return {
    profile: {
      revision: profile.revision,
      contentHash: profile.contentHash,
      generatedAt: profile.generatedAt,
    },
    assertions: snapshotAssertions,
    positions,
    evidence,
    relations,
    sourceWhitelist: packet.sourceWhitelist,
    disclosureRules: packet.disclosureRules,
    redactionRules: packet.redactionRules,
    authorizations: packet.authorizations,
  };
}

async function freezePacket(workspaceId, packetId) {
  const profileState = await WorkspaceCognition.getProfileState(workspaceId);
  if (profileState.stale) {
    const error = new Error("cognitive_profile_stale");
    error.code = "cognitive_profile_stale";
    throw error;
  }
  const packet = await getPacket(workspaceId, packetId);
  if (!packet) return null;
  if (packet.status !== "draft")
    throw new Error("only_draft_packet_can_freeze");
  const snapshot = await buildFrozenSnapshot(packet);
  const frozenSelection = { ...packet.selection, snapshot };
  const hash = contentHash({
    packetKey: packet.packetKey,
    revision: packet.revision,
    delegateUserId: packet.delegateUserId,
    title: packet.title,
    objective: packet.objective,
    selection: frozenSelection,
  });
  const syncReady = await meetingSyncReady();
  await prisma.$transaction(async (tx) => {
    const frozen = await tx.workspace_meeting_packets.update({
      where: { id: packet.id },
      data: {
        status: "frozen",
        profileRevision: snapshot.profile.revision,
        selectionJson: json(frozenSelection),
        contentHash: hash,
        frozenAt: new Date(),
      },
    });
    if (syncReady) {
      await recordMeetingChange(tx, {
        workspaceId,
        eventType: "meeting.packet_frozen",
        changedPaths: [`packets.${frozen.id}.status`],
        payloadHint: {
          operation: "freeze",
          packetId: frozen.id,
          revision: frozen.revision,
          status: frozen.status,
        },
      });
    }
  });
  return await getPacket(workspaceId, packetId);
}

async function revokePacket(workspaceId, packetId) {
  const packet = await getPacket(workspaceId, packetId);
  if (!packet) return null;
  const revokedAt = new Date();
  const syncReady = await meetingSyncReady();
  await prisma.$transaction(async (tx) => {
    await tx.workspace_meeting_packets.update({
      where: { id: packet.id },
      data: { status: "revoked", revokedAt },
    });
    await tx.workspace_meeting_sessions.updateMany({
      where: {
        workspaceId: Number(workspaceId),
        meetingPacketId: packet.id,
        status: "active",
      },
      data: { status: "revoked", endedAt: revokedAt },
    });
    if (syncReady) {
      await recordMeetingChange(tx, {
        workspaceId,
        eventType: "meeting.packet_revoked",
        changedPaths: [
          `packets.${packet.id}.status`,
          `sessions.packet.${packet.id}`,
        ],
        payloadHint: {
          operation: "revoke",
          packetId: packet.id,
          revision: packet.revision,
          status: "revoked",
        },
      });
    }
  });
  return await getPacket(workspaceId, packetId);
}

async function createSession({ workspace, packetId, userId = null } = {}) {
  const packet = await getPacket(workspace.id, packetId);
  if (!packet || packet.status !== "frozen")
    throw new Error("frozen_packet_required");
  const { thread, message } = await WorkspaceThread.new(workspace, userId, {
    name: `Meeting: ${packet.title}`,
    thread_type: WorkspaceThread.THREAD_TYPES.meeting,
    created_from: "meeting_packet",
  });
  if (!thread) throw new Error(message || "meeting_thread_create_failed");
  const syncReady = await meetingSyncReady();
  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.workspace_meeting_sessions.create({
      data: {
        workspaceId: workspace.id,
        meetingPacketId: packet.id,
        threadId: thread.id,
        delegateUserId: packet.delegateUserId,
        createdByUserId: userId ? Number(userId) : null,
        status: "active",
      },
    });
    await createAuditRecord(tx, {
      workspaceId: workspace.id,
      meetingSessionId: created.id,
      actorUserId: userId,
      eventType: "meeting_started",
      decision: "allowed",
      result: {
        packetId: packet.id,
        packetHash: packet.contentHash,
        threadId: thread.id,
      },
    });
    if (syncReady) {
      await recordMeetingChange(tx, {
        workspaceId: workspace.id,
        eventType: "meeting.session_started",
        changedPaths: [`sessions.${created.id}`],
        payloadHint: {
          operation: "start",
          sessionId: created.id,
          packetId: packet.id,
          threadId: thread.id,
          status: created.status,
        },
      });
    }
    return created;
  });
  return { session, thread, packet };
}

async function getSession(workspaceId, sessionId) {
  const session = await prisma.workspace_meeting_sessions.findFirst({
    where: { id: Number(sessionId), workspaceId: Number(workspaceId) },
  });
  if (!session) return null;
  const packet = await getPacket(workspaceId, session.meetingPacketId);
  return { session, packet };
}

async function createAuditRecord(
  db,
  {
    workspaceId,
    meetingSessionId,
    actorUserId = null,
    eventType,
    decision = null,
    request = {},
    result = {},
    evidenceRefs = [],
    authorizationId = null,
  } = {}
) {
  return await db.workspace_meeting_audit_events.create({
    data: {
      workspaceId: Number(workspaceId),
      meetingSessionId: Number(meetingSessionId),
      actorUserId: actorUserId ? Number(actorUserId) : null,
      eventType,
      decision,
      requestJson: json(request),
      resultJson: json(result),
      evidenceRefsJson: json(evidenceRefs, "[]"),
      authorizationId: authorizationId ? Number(authorizationId) : null,
    },
  });
}

async function recordAudit(input = {}) {
  if (!(await meetingSyncReady()))
    return await createAuditRecord(prisma, input);
  return await prisma.$transaction(async (tx) => {
    const audit = await createAuditRecord(tx, input);
    await recordMeetingChange(tx, {
      workspaceId: input.workspaceId,
      eventType: `meeting.audit.${String(input.eventType || "recorded")}`,
      changedPaths: [`audit.${audit.id}`],
      payloadHint: {
        operation: "append-audit",
        auditId: audit.id,
        sessionId: Number(input.meetingSessionId),
        auditType: input.eventType,
        decision: input.decision || null,
      },
    });
    return audit;
  });
}

async function listAudit(workspaceId, sessionId) {
  return (
    await prisma.workspace_meeting_audit_events.findMany({
      where: {
        workspaceId: Number(workspaceId),
        meetingSessionId: Number(sessionId),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).map(parseAudit);
}

function numberWithin(value, maximum) {
  if (maximum === undefined || maximum === null || maximum === "") return true;
  if (value === undefined || value === null || value === "") return false;
  const numericValue = Number(value);
  const numericMaximum = Number(maximum);
  return (
    Number.isFinite(numericValue) &&
    Number.isFinite(numericMaximum) &&
    numericValue >= 0 &&
    numericMaximum >= 0 &&
    numericValue <= numericMaximum
  );
}

function targetAllowed(target, scope = {}) {
  const allowedTargets = Array.isArray(scope.allowedTargets)
    ? scope.allowedTargets
    : [];
  if (!allowedTargets.length) return true;
  if (!target) return false;
  return allowedTargets.map(String).includes(String(target));
}

async function validateCommitment({
  workspaceId,
  packetId,
  proposal = {},
} = {}) {
  const authorizations = await authorizationsForPacket(workspaceId, packetId);
  const now = Date.now();
  const candidates = authorizations.filter(
    (authorization) =>
      authorization.status === "active" &&
      authorization.actionType === proposal.actionType &&
      (!authorization.validFrom ||
        new Date(authorization.validFrom).getTime() <= now) &&
      (!authorization.validUntil ||
        new Date(authorization.validUntil).getTime() >= now)
  );
  for (const authorization of candidates) {
    const limits = authorization.limits || {};
    const targetScope = authorization.targetScope || {};
    const dueAt = proposal.dueAt ? new Date(proposal.dueAt).getTime() : null;
    const latestDueAt = limits.latestDueAt
      ? new Date(limits.latestDueAt).getTime()
      : null;
    const deadlineAllowed = latestDueAt
      ? Number.isFinite(dueAt) && dueAt <= latestDueAt
      : !proposal.dueAt || Number.isFinite(dueAt);
    const allowed =
      targetAllowed(proposal.target, targetScope) &&
      numberWithin(proposal.amount, limits.maxAmount) &&
      numberWithin(proposal.quantity, limits.maxQuantity) &&
      numberWithin(proposal.durationMinutes, limits.maxDurationMinutes) &&
      deadlineAllowed &&
      (!proposal.conditional || authorization.allowConditional);
    if (!allowed) continue;
    return {
      allowed: !authorization.requiresSecondApproval,
      requiresApproval: authorization.requiresSecondApproval,
      reason: authorization.requiresSecondApproval
        ? "second_approval_required"
        : null,
      authorization,
    };
  }
  return {
    allowed: false,
    requiresApproval: true,
    reason: candidates.length
      ? "commitment_out_of_bounds"
      : "authorization_missing_or_expired",
    authorization: candidates[0] || null,
  };
}

module.exports = {
  WorkspaceMeetingDelegate: {
    createPacket,
    updatePacket,
    getPacket,
    listPackets,
    freezePacket,
    revokePacket,
    createSession,
    getSession,
    recordAudit,
    listAudit,
    validateCommitment,
  },
};
