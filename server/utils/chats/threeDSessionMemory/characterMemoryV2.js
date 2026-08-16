const crypto = require("crypto");
const { serialize, deserialize, canonicalJson } = require("./storage");
const {
  ADAPTIVE_SELF_KEYS,
  RELATIONSHIP_V2_KEYS,
  initialAdaptiveSelf,
  initialRelationshipV2,
  legacyRelationshipProjection,
  migrateLegacyRelationship,
  validateReflectionV2,
} = require("./longTermContract");
const { effectiveTransition, evaluateCandidate } = require("./formationPolicy");

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizedFingerprint(type, value) {
  return digest({
    type,
    value: String(value || "")
      .trim()
      .toLowerCase(),
  });
}

async function relationshipV2(profile) {
  return profile.relationshipV2Json
    ? deserialize(profile.relationshipV2Json)
    : migrateLegacyRelationship(await deserialize(profile.relationshipJson));
}

async function adaptiveSelf(profile) {
  return profile.adaptiveSelfJson
    ? deserialize(profile.adaptiveSelfJson)
    : initialAdaptiveSelf();
}

async function addEvidence(
  tx,
  { profile, session, subjectType, subjectId, source },
  rowsByOrdinal
) {
  for (const evidence of source) {
    const row = rowsByOrdinal.get(evidence.turn_ordinal);
    if (!row || row.languageHash !== evidence.evidence_hash)
      throw Object.assign(
        new Error("athena_3d_character_memory_evidence_invalid"),
        {
          code: "athena_3d_character_memory_evidence_invalid",
        }
      );
    await tx.athena_3d_character_memory_evidence.upsert({
      where: {
        subjectType_subjectId_memorySessionId_sourceTurnOrdinal: {
          subjectType,
          subjectId,
          memorySessionId: session.id,
          sourceTurnOrdinal: row.ordinal,
        },
      },
      create: {
        id: id("chr_mem_evidence"),
        profileId: profile.id,
        subjectType,
        subjectId,
        memorySessionId: session.id,
        conversationId: session.conversationId,
        sourceTurnId: row.sourceTurnId,
        sourceTurnOrdinal: row.ordinal,
        sourceResponseId: row.responseId,
        evidenceHash: row.languageHash,
      },
      update: {},
    });
  }
}

async function formReflectionV2({
  client,
  job,
  session,
  profile,
  rows,
  payload,
  result,
}) {
  const relationshipBefore = await relationshipV2(profile);
  const adaptiveBefore = await adaptiveSelf(profile);
  const validation = validateReflectionV2(payload, {
    relationshipBefore,
    adaptiveBefore,
    turnOrdinals: rows.map((row) => row.ordinal),
    turnEvidence: rows.map((row) => ({
      ordinal: row.ordinal,
      evidence_hash: row.languageHash,
    })),
  });
  if (!validation.ok)
    throw Object.assign(new Error(validation.code), { code: validation.code });

  const usage = result.usage || {};
  const hit = Number(
    usage.prompt_cache_hit_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      0
  );
  const miss = Number(
    usage.prompt_cache_miss_tokens ??
      usage.input_tokens_details?.cache_miss_tokens ??
      0
  );
  const rate = hit + miss > 0 ? hit / (hit + miss) : 0;

  const formed = await client.$transaction(async (tx) => {
    const rowsByOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
    const accepted = new Map();
    for (const candidate of payload.memory_candidates) {
      const fingerprint = normalizedFingerprint(
        candidate.type,
        candidate.event_summary
      );
      const priorMemory = await tx.athena_3d_character_memories.findUnique({
        where: {
          profileId_fingerprint: { profileId: profile.id, fingerprint },
        },
      });
      const priorSessions = priorMemory
        ? await tx.athena_3d_character_memory_evidence.findMany({
            where: { subjectType: "memory", subjectId: priorMemory.id },
            distinct: ["memorySessionId"],
            select: { memorySessionId: true },
          })
        : [];
      const priorCandidates =
        await tx.athena_3d_character_memory_candidates.findMany({
          where: {
            profileId: profile.id,
            type: candidate.type,
            eventSummary: candidate.event_summary,
            memorySessionId: { not: session.id },
          },
          distinct: ["memorySessionId"],
          select: { memorySessionId: true },
        });
      let decision = evaluateCandidate(candidate);
      const stableSingleFact =
        candidate.values.information_value >= 0.8 &&
        candidate.values.future_relevance >= 0.65;
      if (
        decision.accepted &&
        candidate.type === "habit" &&
        !stableSingleFact &&
        !priorSessions.some((entry) => entry.memorySessionId !== session.id) &&
        priorCandidates.length === 0
      )
        decision = {
          accepted: false,
          reason: "cross_session_evidence_required",
        };
      const candidateRow =
        await tx.athena_3d_character_memory_candidates.upsert({
          where: {
            memorySessionId_finalizationEpoch_candidateKey: {
              memorySessionId: session.id,
              finalizationEpoch: job.finalizationEpoch,
              candidateKey: candidate.candidate_key,
            },
          },
          create: {
            id: id("chr_mem_candidate"),
            profileId: profile.id,
            memorySessionId: session.id,
            finalizationEpoch: job.finalizationEpoch,
            candidateKey: candidate.candidate_key,
            type: candidate.type,
            firstPersonMemory: candidate.first_person_memory,
            eventSummary: candidate.event_summary,
            valuesJson: serialize(candidate.values),
            confidence: candidate.confidence,
            tagsJson: serialize(candidate.tags),
            proposedPersistence: candidate.proposed_persistence,
            decision: decision.accepted ? "accepted" : "rejected",
            decisionReason: decision.reason,
          },
          update: {},
        });
      await addEvidence(
        tx,
        {
          profile,
          session,
          subjectType: "candidate",
          subjectId: candidateRow.id,
          source: candidate.source_evidence,
        },
        rowsByOrdinal
      );
      if (!decision.accepted) continue;
      const memory = await tx.athena_3d_character_memories.upsert({
        where: {
          profileId_fingerprint: { profileId: profile.id, fingerprint },
        },
        create: {
          id: id("chr_memory"),
          profileId: profile.id,
          type: candidate.type,
          firstPersonMemory: candidate.first_person_memory,
          eventSummary: candidate.event_summary,
          importance: candidate.values.information_value,
          relationshipValue: candidate.values.relationship_value,
          emotionalValue: candidate.values.emotional_value,
          futureRelevance: candidate.values.future_relevance,
          characterImpact: candidate.values.character_impact,
          confidence: candidate.confidence,
          persistence: candidate.proposed_persistence,
          tagsJson: serialize(candidate.tags),
          fingerprint,
        },
        update: {
          confidence: Math.max(candidate.confidence, 0),
          tagsJson: serialize(candidate.tags),
          indexStatus: "pending",
          indexError: null,
        },
      });
      await addEvidence(
        tx,
        {
          profile,
          session,
          subjectType: "memory",
          subjectId: memory.id,
          source: candidate.source_evidence,
        },
        rowsByOrdinal
      );
      accepted.set(candidate.candidate_key, {
        candidate,
        memory,
        decision,
        priorSessionCount: new Set([
          ...priorSessions.map((entry) => entry.memorySessionId),
          ...priorCandidates.map((entry) => entry.memorySessionId),
        ]).size,
      });
    }

    for (const update of payload.user_model_updates) {
      const acceptedSource = accepted.get(update.candidate_key);
      if (!acceptedSource) continue;
      const fingerprint = normalizedFingerprint(
        "user_model",
        update.observation
      );
      const existing =
        await tx.athena_3d_character_user_model_entries.findUnique({
          where: {
            profileId_fingerprint: { profileId: profile.id, fingerprint },
          },
        });
      const stableSingle =
        acceptedSource.candidate.values.information_value >= 0.8 &&
        acceptedSource.candidate.values.future_relevance >= 0.65;
      const existingEvidence = existing
        ? await tx.athena_3d_character_memory_evidence.findMany({
            where: { subjectType: "user_model", subjectId: existing.id },
            select: { memorySessionId: true },
          })
        : [];
      const sourceSessionCount =
        new Set([
          ...existingEvidence.map((entry) => entry.memorySessionId),
          session.id,
        ]).size + Number(acceptedSource.priorSessionCount || 0);
      const status =
        update.mode === "contradict"
          ? "contradicted"
          : stableSingle || sourceSessionCount >= 2
            ? "active"
            : "observing";
      const entry = await tx.athena_3d_character_user_model_entries.upsert({
        where: {
          profileId_fingerprint: { profileId: profile.id, fingerprint },
        },
        create: {
          id: id("chr_user_model"),
          profileId: profile.id,
          observation: update.observation,
          firstPersonInterpretation: update.first_person_interpretation,
          confidence: update.confidence,
          status,
          occurrenceCount: 1,
          sourceSessionCount: 1,
          fingerprint,
        },
        update: {
          firstPersonInterpretation: update.first_person_interpretation,
          confidence: Math.max(existing?.confidence || 0, update.confidence),
          status,
          occurrenceCount: { increment: 1 },
          sourceSessionCount,
          indexStatus: "pending",
          indexError: null,
        },
      });
      await addEvidence(
        tx,
        {
          profile,
          session,
          subjectType: "user_model",
          subjectId: entry.id,
          source: update.source_evidence,
        },
        rowsByOrdinal
      );
    }

    const acceptedCandidates = [...accepted.values()].map(
      (entry) => entry.candidate
    );
    const relationship = effectiveTransition({
      before: relationshipBefore,
      transition: payload.relationship_transition,
      keys: RELATIONSHIP_V2_KEYS,
      accepted: acceptedCandidates,
      kind: "relationship",
    });
    const adaptive = effectiveTransition({
      before: adaptiveBefore,
      transition: payload.adaptive_self_transition,
      keys: ADAPTIVE_SELF_KEYS,
      accepted: acceptedCandidates,
      kind: "adaptive",
    });

    const maxRelationshipChange = Math.max(
      ...Object.values(relationship.delta).map(Math.abs)
    );
    const maxAdaptiveChange = Math.max(
      ...Object.values(adaptive.delta).map(Math.abs)
    );
    for (const growth of payload.growth_candidates) {
      const source = growth.source_memory_candidate_keys
        .map((key) => accepted.get(key))
        .filter(Boolean);
      if (!source.length || growth.confidence < 0.75) continue;
      const patternCount = await tx.athena_3d_character_memories.count({
        where: {
          profileId: profile.id,
          type: source[0].memory.type,
          status: "active",
        },
      });
      if (
        maxRelationshipChange < 0.05 &&
        maxAdaptiveChange < 0.03 &&
        patternCount < 3
      )
        continue;
      const fingerprint = normalizedFingerprint(
        growth.type,
        growth.first_person_summary
      );
      const node = await tx.athena_3d_character_growth_nodes.upsert({
        where: {
          profileId_fingerprint: { profileId: profile.id, fingerprint },
        },
        create: {
          id: id("chr_growth"),
          profileId: profile.id,
          type: growth.type,
          firstPersonSummary: growth.first_person_summary,
          changesJson: serialize({ relationship, adaptive }),
          confidence: growth.confidence,
          fingerprint,
        },
        update: {
          confidence: growth.confidence,
          changesJson: serialize({ relationship, adaptive }),
          indexStatus: "pending",
        },
      });
      for (const item of source) {
        const evidences = await tx.athena_3d_character_memory_evidence.findMany(
          { where: { subjectType: "memory", subjectId: item.memory.id } }
        );
        await addEvidence(
          tx,
          {
            profile,
            session,
            subjectType: "growth",
            subjectId: node.id,
            source: evidences
              .filter((e) => e.memorySessionId === session.id)
              .map((e) => ({
                turn_ordinal: e.sourceTurnOrdinal,
                evidence_hash: e.evidenceHash,
              })),
          },
          rowsByOrdinal
        );
      }
    }

    for (const milestone of payload.emotional_milestone_candidates) {
      const source = milestone.source_memory_candidate_keys
        .map((key) => accepted.get(key))
        .filter(Boolean);
      const eligible =
        source.length &&
        milestone.emotional_value >= 0.85 &&
        Math.max(milestone.relationship_value, milestone.character_impact) >=
          0.75 &&
        milestone.confidence >= 0.85;
      if (!eligible) continue;
      if (milestone.type.startsWith("first_")) {
        const prior =
          await tx.athena_3d_character_emotional_milestones.findFirst({
            where: {
              profileId: profile.id,
              type: milestone.type,
              status: "active",
            },
          });
        if (prior) continue;
      }
      const fingerprint = normalizedFingerprint(
        milestone.type,
        milestone.first_person_memory
      );
      const node = await tx.athena_3d_character_emotional_milestones.upsert({
        where: {
          profileId_fingerprint: { profileId: profile.id, fingerprint },
        },
        create: {
          id: id("chr_milestone"),
          profileId: profile.id,
          type: milestone.type,
          firstPersonMemory: milestone.first_person_memory,
          confidence: milestone.confidence,
          fingerprint,
        },
        update: { confidence: milestone.confidence, indexStatus: "pending" },
      });
      for (const item of source)
        await addEvidence(
          tx,
          {
            profile,
            session,
            subjectType: "milestone",
            subjectId: node.id,
            source: item.candidate.source_evidence,
          },
          rowsByOrdinal
        );
    }

    const activeUserModel =
      await tx.athena_3d_character_user_model_entries.findMany({
        where: { profileId: profile.id, status: "active" },
        orderBy: { confidence: "desc" },
        take: 64,
      });
    const userModelSummary = {
      entries: activeUserModel.map((entry) => ({
        observation: entry.observation,
        first_person_interpretation: entry.firstPersonInterpretation,
        confidence: entry.confidence,
        occurrence_count: entry.occurrenceCount,
      })),
      updated_at: Date.now(),
    };
    const legacyBefore = legacyRelationshipProjection(relationshipBefore);
    const legacyAfter = legacyRelationshipProjection(relationship.after);
    const legacyDelta = Object.fromEntries(
      Object.keys(legacyBefore).map((key) => [
        key,
        Number((legacyAfter[key] - legacyBefore[key]).toFixed(6)),
      ])
    );
    const updated = await tx.athena_3d_character_memory_profiles.updateMany({
      where: { id: profile.id, revision: job.expectedProfileRevision },
      data: {
        revision: job.expectedProfileRevision + 1,
        relationshipV2Json: serialize(relationship.after),
        adaptiveSelfJson: serialize(adaptive.after),
        relationshipJson: serialize(legacyAfter),
        userModelSummaryJson: serialize(userModelSummary),
        emotionJson: serialize({
          ...payload.final_emotion,
          observed_at: Date.now(),
        }),
        latestSessionId: session.id,
        schemaVersion: 2,
        reflectionVersion: "2.0",
        policyVersion: "2.0",
      },
    });
    if (updated.count !== 1)
      throw Object.assign(
        new Error("athena_3d_long_term_profile_revision_conflict"),
        { code: "athena_3d_long_term_profile_revision_conflict" }
      );
    await tx.athena_3d_character_memory_revisions.create({
      data: {
        id: id("chr_mem_revision"),
        profileId: profile.id,
        memorySessionId: session.id,
        finalizationEpoch: job.finalizationEpoch,
        fromRevision: job.expectedProfileRevision,
        toRevision: job.expectedProfileRevision + 1,
        relationshipBeforeJson: serialize(legacyBefore),
        relationshipDeltaJson: serialize(legacyDelta),
        relationshipAfterJson: serialize(legacyAfter),
        relationshipV2BeforeJson: serialize(relationshipBefore),
        relationshipV2DeltaJson: serialize(relationship.delta),
        relationshipV2AfterJson: serialize(relationship.after),
        adaptiveBeforeJson: serialize(adaptiveBefore),
        adaptiveDeltaJson: serialize(adaptive.delta),
        adaptiveAfterJson: serialize(adaptive.after),
        narrative:
          payload.relationship_transition.narrative ||
          payload.session_reflection.first_person_summary,
        confidence: Number(payload.relationship_transition.confidence ?? 1),
      },
    });
    await tx.athena_3d_character_memory_sessions.update({
      where: { id: session.id },
      data: {
        status: "finalized",
        finalizedThroughOrdinal: session.archivedThroughOrdinal,
        reflectionJson: serialize(payload),
        formationStatus: "formed",
        legacyReflectionPending: false,
        providerCacheHitTokens: hit,
        providerCacheMissTokens: miss,
        providerCacheHitRate: rate,
        cacheMode: result.cacheMode || "durable_rebuild",
        prefixSha256: result.prefixSha256 || null,
        finalizedAt: new Date(),
      },
    });
    await tx.athena_3d_character_memory_jobs.update({
      where: { id: job.id },
      data: {
        status: "completed",
        provider: result.provider,
        model: result.model,
        cacheMode: result.cacheMode || "durable_rebuild",
        prefixSha256: result.prefixSha256 || null,
        providerCacheHitTokens: hit,
        providerCacheMissTokens: miss,
        providerCacheHitRate: rate,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });
    return {
      completed: true,
      profile_revision: job.expectedProfileRevision + 1,
      accepted_memories: accepted.size,
      rejected_candidates: payload.memory_candidates.length - accepted.size,
      formation: {
        relationship: {
          effective_delta: relationship.delta,
          model_delta: relationship.model_delta,
          cap: relationship.cap,
        },
        adaptive_self: {
          effective_delta: adaptive.delta,
          model_delta: adaptive.model_delta,
          cap: adaptive.cap,
        },
      },
      warnings: [
        ...(JSON.stringify(relationship.delta) !==
        JSON.stringify(relationship.model_delta)
          ? [{ code: "relationship_delta_capped" }]
          : []),
        ...(JSON.stringify(adaptive.delta) !==
        JSON.stringify(adaptive.model_delta)
          ? [{ code: "adaptive_self_delta_capped" }]
          : []),
      ],
    };
  });
  return formed;
}

module.exports = { adaptiveSelf, formReflectionV2, relationshipV2 };
