const crypto = require("crypto");
const prisma = require("../../prisma");
const { TokenManager } = require("../../helpers/tiktoken");
const { memoryConfig } = require("./config");
const { canonicalJson, serialize, deserialize } = require("./storage");
const {
  decayedEmotion,
  initialAdaptiveSelf,
  initialEmotion,
  initialRelationship,
  initialRelationshipV2,
  legacyRelationshipProjection,
  validateConsolidation,
} = require("./longTermContract");
const { requireCharacterCore } = require("./characterCoreRegistry");
const {
  adaptiveSelf,
  formReflectionV2,
  relationshipV2,
} = require("./characterMemoryV2");
const {
  deleteObjectIndex,
  deleteProfileIndex,
  semanticRecall,
} = require("./characterMemoryVectorIndex");

const tokenManager = new TokenManager("deepseek-v4-flash");
const FACE_REGIONS = Object.freeze([
  "brow",
  "eyelid",
  "eye_shape",
  "pupil",
  "cheek",
  "nose",
  "lip",
  "jaw",
]);
const STATE_SECTIONS = Object.freeze([
  "performance_intent",
  "attention",
  "face",
  "gaze",
  "head_neck",
  "shoulders",
  "torso",
  "left_arm",
  "right_arm",
  "left_hand",
  "right_hand",
  "left_leg",
  "right_leg",
  "posture",
  "locomotion",
  "action",
  "voice_delivery",
  "activity",
  "performance_state",
  "decay",
]);
const STATE_METADATA_KEYS = Object.freeze([
  "source_turn_id",
  "source_response_id",
  "source_sequence_id",
  "updated_at",
]);

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex");
}

function contextCursorId() {
  return `chr_ctx_${crypto.randomUUID().replace(/-/g, "")}`;
}

function memoryId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function persistentMode(input = {}) {
  return (
    input.memoryMode === "persistent" || input.memory?.mode === "persistent"
  );
}

function tokenCount(value) {
  return tokenManager.countFromString(
    typeof value === "string" ? value : canonicalJson(value)
  );
}

function searchableText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(searchableText).join(" ");
  if (typeof value === "object")
    return Object.values(value).map(searchableText).join(" ");
  return String(value);
}

function queryTerms(value) {
  const text = searchableText(value).toLowerCase().replace(/\s+/g, "");
  const terms = new Set();
  for (const word of searchableText(value)
    .toLowerCase()
    .match(/[a-z0-9_]{2,}/g) || [])
    terms.add(word);
  for (let index = 0; index < text.length - 1; index += 1)
    terms.add(text.slice(index, index + 2));
  return [...terms].slice(0, 128);
}

function relevance(value, terms) {
  const haystack = searchableText(value).toLowerCase().replace(/\s+/g, "");
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0
  );
}

function trimArrayToTokenBudget(value, key, budget) {
  while (tokenCount(value[key]) > budget && value[key].length) value[key].pop();
}

function historicalStateEvidence(state) {
  if (!state || typeof state !== "object") return null;
  return {
    revision: state.revision ?? null,
    performance_intent: state.performance_intent || null,
    attention: state.attention || null,
    voice_delivery: state.voice_delivery || null,
    performance_state: state.performance_state || null,
    activity: state.activity || null,
    policy: "emotional_evidence_only_do_not_resume_physical_pose_or_action",
  };
}

function memoryError(code, status = 500, details = null) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  if (details) error.details = details;
  return error;
}

function assertPersistentState(state, label) {
  if (!state || Array.isArray(state) || typeof state !== "object")
    throw memoryError("athena_3d_memory_state_window_invalid", 400, { label });
  const missing = STATE_SECTIONS.filter(
    (section) => state[section] === undefined || state[section] === null
  );
  const missingMetadata = STATE_METADATA_KEYS.filter(
    (key) => state[key] === undefined
  );
  if (
    !Number.isInteger(state.revision) ||
    missing.length ||
    missingMetadata.length
  )
    throw memoryError("athena_3d_memory_state_window_incomplete", 400, {
      label,
      missing,
      missingMetadata,
    });
  if (!Array.isArray(state.face))
    throw memoryError("athena_3d_memory_face_state_invalid", 400, { label });
  const regions = new Set(state.face.map((entry) => entry?.region));
  const missingFaceRegions = FACE_REGIONS.filter(
    (region) => !regions.has(region)
  );
  if (missingFaceRegions.length)
    throw memoryError("athena_3d_memory_face_state_incomplete", 400, {
      label,
      missingFaceRegions,
    });
}

function assertStateWindow(stateWindow, { initial = false } = {}) {
  if (!stateWindow || Array.isArray(stateWindow))
    throw memoryError("athena_3d_memory_state_window_invalid", 400);
  assertPersistentState(stateWindow.previous_state, "previous_state");
  assertPersistentState(stateWindow.current_state, "current_state");
  if (initial && stateWindow.transition === null) return stateWindow;
  const transition = stateWindow.transition;
  if (!transition || typeof transition !== "object")
    throw memoryError("athena_3d_memory_state_transition_required", 400);
  if (
    Number(transition.from_revision) !==
      Number(stateWindow.previous_state.revision) ||
    Number(transition.to_revision) !==
      Number(stateWindow.current_state.revision)
  )
    throw memoryError(
      "athena_3d_memory_state_transition_revision_invalid",
      400
    );
  const missingChanges = STATE_SECTIONS.filter(
    (section) =>
      typeof transition.changes?.[section]?.changed !== "boolean" ||
      !("from" in (transition.changes?.[section] || {})) ||
      !("to" in (transition.changes?.[section] || {}))
  );
  if (missingChanges.length)
    throw memoryError("athena_3d_memory_state_transition_incomplete", 400, {
      missingChanges,
    });
  return stateWindow;
}

function scopeMatches(row, scope = {}) {
  const numberOrNull = (value) =>
    value === null || value === undefined ? null : Number(value);
  return (
    numberOrNull(row.workspaceId) === numberOrNull(scope.workspaceId) &&
    numberOrNull(row.threadId) === numberOrNull(scope.threadId) &&
    numberOrNull(row.ownerUserId) === numberOrNull(scope.ownerUserId) &&
    String(row.agentRunId || "") === String(scope.agentRunId || "")
  );
}

class ThreeDSessionMemoryRepository {
  constructor({ client = prisma, env = process.env } = {}) {
    this.client = client;
    this.env = env;
    this.config = memoryConfig(env);
  }

  async findSession(conversationId) {
    return this.client.athena_3d_session_memories.findUnique({
      where: { conversationId },
    });
  }

  async requireSession(conversationId, scope = null) {
    const session = await this.findSession(conversationId);
    if (!session) throw memoryError("athena_3d_memory_session_not_found", 404);
    if (scope && !scopeMatches(session, scope))
      throw memoryError("athena_3d_memory_session_not_found", 404);
    return session;
  }

  async createSession(input = {}) {
    const conversationId = String(input.conversationId || "").trim();
    if (!conversationId)
      throw memoryError("athena_3d_memory_session_invalid", 400);
    assertStateWindow(input.stateWindow, { initial: true });
    const stateTokens = tokenCount(input.stateWindow);
    if (stateTokens > this.config.stateWindowMaxTokens)
      throw memoryError("athena_3d_memory_state_window_too_large", 413, {
        tokenCount: stateTokens,
        limit: this.config.stateWindowMaxTokens,
      });
    const previousStateJson = serialize(input.stateWindow.previous_state);
    const currentStateJson = serialize(input.stateWindow.current_state);
    const transitionJson = input.stateWindow.transition
      ? serialize(input.stateWindow.transition)
      : null;
    return this.client.$transaction(async (tx) => {
      const existing = await tx.athena_3d_session_memories.findUnique({
        where: { conversationId },
      });
      if (existing) {
        if (!scopeMatches(existing, input))
          throw memoryError("athena_3d_memory_session_scope_conflict", 409);
        return existing;
      }
      const wantsPersistent = persistentMode(input);
      const ownerUserId = Number(input.ownerUserId || 0);
      const characterId = String(input.characterId || "");
      const characterInstanceId = String(
        input.characterInstanceId || ""
      ).trim();
      const canPersist =
        wantsPersistent && ownerUserId > 0 && characterInstanceId;
      let profile = null;
      if (canPersist) {
        const core = requireCharacterCore(characterId);
        const initialV2 = initialRelationshipV2();
        profile = await tx.athena_3d_character_memory_profiles.upsert({
          where: {
            ownerUserId_characterId_characterInstanceId: {
              ownerUserId,
              characterId,
              characterInstanceId,
            },
          },
          create: {
            id: memoryId("chr_mem_profile"),
            ownerUserId,
            characterId,
            characterInstanceId,
            schemaVersion: 2,
            coreId: core.id,
            coreVersion: core.version,
            coreSha256: core.sha256,
            coreSnapshotJson: serialize(core.snapshot),
            adaptiveSelfJson: serialize(initialAdaptiveSelf()),
            relationshipV2Json: serialize(initialV2),
            userModelSummaryJson: serialize({ entries: [], updated_at: null }),
            reflectionVersion: "2.0",
            policyVersion: "2.0",
            relationshipJson: serialize(
              legacyRelationshipProjection(initialV2)
            ),
            emotionJson: serialize(initialEmotion()),
          },
          update: {},
        });
      }
      const longTermContext = profile
        ? await this.longTermContextForProfile(tx, profile, null)
        : null;
      const session = await tx.athena_3d_session_memories.create({
        data: {
          conversationId,
          workspaceId: input.workspaceId ?? null,
          threadId: input.threadId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          agentRunId: input.agentRunId || null,
          characterId,
          characterInstanceId: characterInstanceId || null,
          status: "active",
          stateRevision: Number(input.stateWindow.current_state.revision || 0),
          checkpointRevision: 0,
          contextCursorId: contextCursorId(),
          contextUpdatedAt: new Date(),
          projectedContextTokens: stateTokens,
          memoryMode: canPersist ? "persistent" : "ephemeral",
          longTermProfileId: profile?.id || null,
          longTermProfileRevision: Number(profile?.revision || 0),
          longTermContextJson: longTermContext
            ? serialize(longTermContext)
            : null,
        },
      });
      await tx.athena_3d_character_state_windows.create({
        data: {
          conversationId,
          stateRevision: Number(input.stateWindow.current_state.revision || 0),
          previousStateJson,
          transitionJson,
          currentStateJson,
          windowHash: sha256(input.stateWindow),
          tokenCount: stateTokens,
          sourceTurnId: input.stateWindow.current_state.source_turn_id || null,
          sourceResponseId:
            input.stateWindow.current_state.source_response_id || null,
          sourceSequenceId:
            input.stateWindow.current_state.source_sequence_id || null,
        },
      });
      return {
        ...session,
        character_memory: profile
          ? {
              profile_ref: { id: profile.id, revision: profile.revision },
              status: "ready",
              latest_session_id: profile.latestSessionId,
            }
          : {
              profile_ref: null,
              status: wantsPersistent ? "ephemeral" : "disabled",
              latest_session_id: null,
            },
      };
    });
  }

  async longTermContextForProfile(tx, profile, query = null) {
    const [sessions, userModel, memories, growthNodes, milestones] =
      await Promise.all([
        tx.athena_3d_character_memory_sessions.findMany({
          where: { profileId: profile.id },
          orderBy: { createdAt: "desc" },
          take: query ? 24 : 3,
        }),
        tx.athena_3d_character_user_model_entries.findMany({
          where: { profileId: profile.id, status: "active" },
          orderBy: { confidence: "desc" },
          take: 64,
        }),
        tx.athena_3d_character_memories.findMany({
          where: { profileId: profile.id, status: "active" },
          orderBy: { createdAt: "desc" },
          take: 256,
        }),
        tx.athena_3d_character_growth_nodes.findMany({
          where: { profileId: profile.id, status: "active" },
          orderBy: { createdAt: "desc" },
          take: 64,
        }),
        tx.athena_3d_character_emotional_milestones.findMany({
          where: { profileId: profile.id, status: "active" },
          orderBy: { createdAt: "desc" },
          take: 64,
        }),
      ]);
    const hydrated = await Promise.all(
      sessions.map(async (row) => ({
        row,
        summary: row.reflectionJson
          ? await deserialize(row.reflectionJson)
          : row.summaryJson
            ? await deserialize(row.summaryJson)
            : null,
      }))
    );
    const terms = query ? queryTerms(query) : [];
    const selected = (
      query
        ? hydrated
            .map((entry, index) => ({
              ...entry,
              score: relevance(entry.summary, terms),
              recency: hydrated.length - index,
            }))
            .sort((a, b) => b.score - a.score || b.recency - a.recency)
        : hydrated
    ).slice(0, 3);
    let semantic = [];
    const recallWarnings = [];
    if (query) {
      try {
        semantic = await semanticRecall(profile.id, searchableText(query));
      } catch (error) {
        recallWarnings.push({
          code: "character_memory_vector_recall_degraded",
          message: String(error.message || error),
        });
      }
    }
    const semanticScores = new Map(
      semantic.map((item) => [`${item.type}:${item.id}`, item.semantic_score])
    );
    const now = Date.now();
    const scoredMemories = memories
      .map((row) => {
        const semanticScore = semanticScores.get(`memory:${row.id}`) || 0;
        const lexical = query
          ? Math.min(
              1,
              relevance([row.firstPersonMemory, row.eventSummary], terms) / 4
            )
          : 0;
        const ageDays = Math.max(
          0,
          (now - row.createdAt.getTime()) / 86_400_000
        );
        const recency = Math.exp(-ageDays / 90);
        const relationship = row.relationshipValue;
        const importance = Math.max(
          row.importance,
          row.emotionalValue,
          row.characterImpact
        );
        return {
          row,
          score:
            0.45 * Math.max(semanticScore, lexical) +
            0.2 * relationship +
            0.15 * importance +
            0.1 * recency +
            0.1 * row.futureRelevance,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
    const sessionIds = selected.map((entry) => entry.row.id);
    const candidateTurns =
      query && sessionIds.length
        ? await tx.athena_3d_character_memory_turns.findMany({
            where: { memorySessionId: { in: sessionIds } },
            orderBy: { createdAt: "desc" },
            take: 48,
          })
        : [];
    const hydratedTurns = await Promise.all(
      candidateTurns.map(async (row) => ({
        row,
        user: await deserialize(row.userJson),
        assistant: await deserialize(row.assistantJson),
      }))
    );
    const selectedTurns = hydratedTurns
      .map((entry, index) => ({
        ...entry,
        score: relevance([entry.user, entry.assistant], terms),
        recency: hydratedTurns.length - index,
      }))
      .sort((a, b) => b.score - a.score || b.recency - a.recency)
      .slice(0, 6)
      .reverse();
    const core = profile.coreSnapshotJson
      ? {
          id: profile.coreId,
          version: profile.coreVersion,
          sha256: profile.coreSha256,
          snapshot: await deserialize(profile.coreSnapshotJson),
        }
      : requireCharacterCore(profile.characterId);
    const context = {
      object: "athena.3d_center.character_memory_context",
      protocol_version: "2.0",
      profile_ref: { id: profile.id, revision: profile.revision },
      character_core: core,
      adaptive_self: await adaptiveSelf(profile),
      character_user_model: userModel.map((row) => ({
        id: row.id,
        observation: row.observation,
        first_person_interpretation: row.firstPersonInterpretation,
        confidence: row.confidence,
        occurrence_count: row.occurrenceCount,
      })),
      relationship_model: await relationshipV2(profile),
      relationship_compatibility: await deserialize(profile.relationshipJson),
      autobiographical_memories: scoredMemories.map(({ row, score }) => ({
        id: row.id,
        type: row.type,
        first_person_memory: row.firstPersonMemory,
        event_summary: row.eventSummary,
        confidence: row.confidence,
        relevance_score: Number(score.toFixed(6)),
        tags: JSON.parse(row.tagsJson || "[]"),
      })),
      growth_nodes: growthNodes.map((row) => ({
        id: row.id,
        type: row.type,
        first_person_summary: row.firstPersonSummary,
        confidence: row.confidence,
      })),
      emotional_milestones: milestones.map((row) => ({
        id: row.id,
        type: row.type,
        first_person_memory: row.firstPersonMemory,
        confidence: row.confidence,
      })),
      emotion_continuity: decayedEmotion(
        await deserialize(profile.emotionJson)
      ),
      recent_sessions: await Promise.all(
        selected.map(async ({ row, summary }) => ({
          id: row.id,
          conversation_id: row.conversationId,
          finalized_at: row.finalizedAt?.getTime?.() || null,
          consolidation_status: row.status,
          summary,
          final_state_evidence: {
            hash: row.finalStateHash,
            revision: row.sourceStateRevision,
            emotional_state: historicalStateEvidence(
              await deserialize(row.finalStateSnapshotJson)
            ),
          },
        }))
      ),
      relevant_turns: selectedTurns.map(({ row, user, assistant }) => ({
        memory_session_id: row.memorySessionId,
        ordinal: row.ordinal,
        user,
        assistant,
      })),
      recall: {
        frozen: Boolean(query),
        query_sha256: query ? sha256(searchableText(query)) : null,
        max_sessions: 3,
        max_turn_pairs: 6,
        strategy: semantic.length ? "hybrid" : "keyword_importance_recency",
        weights: {
          semantic_similarity: 0.45,
          relationship_value: 0.2,
          importance: 0.15,
          recency: 0.1,
          future_relevance: 0.1,
        },
        warnings: recallWarnings,
      },
      physical_state_policy: "emotion_evidence_only_replan_current_scene",
    };
    if (tokenCount(context.character_core) > 4_000)
      throw memoryError("athena_3d_character_core_context_too_large", 500);
    trimArrayToTokenBudget(context, "character_user_model", 6_000);
    trimArrayToTokenBudget(context, "autobiographical_memories", 10_000);
    while (
      tokenCount([context.growth_nodes, context.emotional_milestones]) >
        4_000 &&
      (context.growth_nodes.length || context.emotional_milestones.length)
    ) {
      if (context.growth_nodes.length >= context.emotional_milestones.length)
        context.growth_nodes.pop();
      else context.emotional_milestones.pop();
    }
    while (
      tokenCount([context.recent_sessions, context.relevant_turns]) > 4_000 &&
      context.relevant_turns.length
    )
      context.relevant_turns.shift();
    while (
      tokenCount([context.recent_sessions, context.relevant_turns]) > 4_000 &&
      context.recent_sessions.length > 1
    )
      context.recent_sessions.pop();
    while (
      tokenCount(context) > this.config.longTermContextMaxTokens &&
      context.autobiographical_memories.length
    )
      context.autobiographical_memories.pop();
    while (
      tokenCount(context) > this.config.longTermContextMaxTokens &&
      context.relevant_turns.length
    )
      context.relevant_turns.shift();
    while (
      tokenCount(context) > this.config.longTermContextMaxTokens &&
      context.recent_sessions.length > 1
    )
      context.recent_sessions.pop();
    while (
      tokenCount(context) > this.config.longTermContextMaxTokens &&
      context.character_user_model.length
    )
      context.character_user_model.pop();
    context.token_count = tokenCount(context);
    return context;
  }

  async freezeLongTermRecall(input = {}) {
    const session = await this.requireSession(input.conversationId, input);
    if (session.memoryMode !== "persistent" || !session.longTermProfileId)
      return {
        frozen: false,
        reason: "ephemeral",
        context_ref: this.contextRef(session),
      };
    const current = session.longTermContextJson
      ? await deserialize(session.longTermContextJson)
      : null;
    if (current?.recall?.frozen)
      return {
        frozen: true,
        replay: true,
        context_ref: this.contextRef(session),
      };
    const profile =
      await this.client.athena_3d_character_memory_profiles.findUnique({
        where: { id: session.longTermProfileId },
      });
    if (!profile)
      throw memoryError("athena_3d_long_term_profile_not_found", 404);
    const context = await this.longTermContextForProfile(
      this.client,
      profile,
      input.input
    );
    const nextCursor = contextCursorId();
    const updated = await this.client.athena_3d_session_memories.updateMany({
      where: {
        conversationId: session.conversationId,
        contextCursorId: session.contextCursorId,
        lastCommittedTurnOrdinal: 0,
      },
      data: {
        longTermContextJson: serialize(context),
        longTermProfileRevision: profile.revision,
        contextCursorId: nextCursor,
        contextUpdatedAt: new Date(),
      },
    });
    const latest = await this.requireSession(input.conversationId, input);
    return {
      frozen:
        updated.count === 1 ||
        Boolean(
          latest.longTermContextJson &&
            (await deserialize(latest.longTermContextJson))?.recall?.frozen
        ),
      context_ref: this.contextRef(latest),
    };
  }

  contextRef(session, now = Date.now()) {
    return {
      cursor_id: session.contextCursorId,
      memory_revision: Number(session.memoryRevision || 0),
      state_revision: Number(session.stateRevision || 0),
      checkpoint_revision: Number(session.checkpointRevision || 0),
      last_turn_ordinal: Number(session.lastCommittedTurnOrdinal || 0),
      expires_at: Number(now) + this.config.contextCacheTtlMs,
    };
  }

  contextRebuildReason(ref, current, now = Date.now()) {
    if (ref === null || !ref || typeof ref !== "object")
      return "cursor_missing";
    if (Number(ref.expires_at || 0) <= Number(now)) return "cursor_expired";
    if (Number(ref.checkpoint_revision) !== Number(current.checkpoint_revision))
      return "checkpoint_advanced";
    if (
      String(ref.cursor_id || "") !== String(current.cursor_id || "") ||
      Number(ref.memory_revision) !== Number(current.memory_revision) ||
      Number(ref.state_revision) !== Number(current.state_revision) ||
      Number(ref.last_turn_ordinal) !== Number(current.last_turn_ordinal)
    )
      return "cursor_stale";
    return null;
  }

  async contextPrepare(input = {}) {
    const now = Date.now();
    const session = await this.requireSession(input.conversationId, input);
    const currentRef = this.contextRef(session, now);
    const legacyLatest = input.contextRef === undefined;
    const reason = legacyLatest
      ? null
      : this.contextRebuildReason(input.contextRef, currentRef, now);
    const coldStart = Number(session.lastCommittedTurnOrdinal || 0) === 0;
    if (!reason)
      return {
        protocol_version: "1.0",
        conversation_id: session.conversationId,
        mode: coldStart ? "cold_start" : "incremental",
        rebuild_reason: null,
        current_ref: currentRef,
        memory_point: null,
        projected_context_tokens: Number(session.projectedContextTokens || 0),
        hard_gate:
          Number(session.projectedContextTokens || 0) >=
          this.config.hardGateTokens,
      };
    const resolved = await this.contextResolve(input);
    return {
      ...resolved,
      mode: coldStart ? "cold_start" : "resynced",
      rebuild_reason: reason,
      current_ref: currentRef,
    };
  }

  async readStateWindow(row) {
    if (!row) return null;
    const revision = Number(row.stateRevision || 0);
    return {
      previous_state: await deserialize(
        row.previousStateJson,
        `${row.conversationId}:state-window:previous:${revision}`,
        this.env
      ),
      transition: row.transitionJson
        ? await deserialize(
            row.transitionJson,
            `${row.conversationId}:state-window:transition:${revision}`,
            this.env
          )
        : null,
      current_state: await deserialize(
        row.currentStateJson,
        `${row.conversationId}:state-window:current:${revision}`,
        this.env
      ),
      token_count: row.tokenCount,
      revision,
    };
  }

  async contextResolve(input = {}) {
    const session = await this.requireSession(input.conversationId, input);
    const checkpoint = session.activeCheckpointId
      ? await this.client.athena_3d_session_memory_checkpoints.findUnique({
          where: { id: session.activeCheckpointId },
        })
      : null;
    const coveredTo = Number(checkpoint?.coveredToOrdinal || 0);
    const rows = await this.client.athena_3d_session_memory_turns.findMany({
      where: {
        conversationId: session.conversationId,
        ordinal: { gt: coveredTo },
      },
      orderBy: { ordinal: "asc" },
    });
    const turns = [];
    for (const row of rows) {
      turns.push({
        turn_id: row.id,
        ordinal: row.ordinal,
        response_id: row.responseId,
        user: await deserialize(
          row.userJson,
          `${row.id}:3d-memory:user`,
          this.env
        ),
        assistant: await deserialize(
          row.assistantJson,
          `${row.id}:3d-memory:assistant`,
          this.env
        ),
      });
    }
    const stateRow =
      await this.client.athena_3d_character_state_windows.findUnique({
        where: { conversationId: session.conversationId },
      });
    const stateWindow = await this.readStateWindow(stateRow);
    const checkpointPayload = checkpoint?.summaryJson
      ? await deserialize(
          checkpoint.summaryJson,
          `${checkpoint.id}:3d-memory:checkpoint`,
          this.env
        )
      : null;
    const projectedTokens =
      Number(checkpoint?.tokenAfter || 0) +
      rows.reduce((sum, row) => sum + Number(row.tokenCount || 0), 0) +
      Number(stateRow?.tokenCount || 0);
    const compaction =
      await this.client.athena_3d_session_memory_checkpoints.findFirst({
        where: {
          conversationId: session.conversationId,
          status: { in: ["queued", "running"] },
        },
        orderBy: { createdAt: "asc" },
      });
    return {
      protocol_version: "1.0",
      conversation_id: session.conversationId,
      memory_revision: session.memoryRevision,
      state_revision: stateRow?.stateRevision ?? session.stateRevision,
      checkpoint_revision: Number(session.checkpointRevision || 0),
      current_ref: this.contextRef(session),
      memory_point: {
        layout: "dialogue_then_performance_state",
        long_term_character_memory: session.longTermContextJson
          ? await deserialize(session.longTermContextJson)
          : null,
        dialogue: {
          checkpoint: checkpointPayload
            ? {
                id: checkpoint.id,
                previous_checkpoint_id: checkpoint.previousCheckpointId,
                covered_from_ordinal: checkpoint.coveredFromOrdinal,
                covered_to_ordinal: checkpoint.coveredToOrdinal,
                content: checkpointPayload,
                compression_version: checkpoint.compressionVersion,
              }
            : null,
          turns,
        },
        performance_state: {
          state_window: stateWindow,
        },
      },
      projected_context_tokens: projectedTokens,
      context_budget_tokens: this.config.contextBudgetTokens,
      compression_trigger_tokens: this.config.compressionTriggerTokens,
      hard_gate_tokens: this.config.hardGateTokens,
      hard_gate: projectedTokens >= this.config.hardGateTokens,
      compaction: compaction
        ? { id: compaction.id, status: compaction.status }
        : null,
    };
  }

  async commitTurn(input = {}) {
    const conversationId = String(input.conversationId || "").trim();
    const turnId = String(input.turnId || "").trim();
    if (!conversationId || !turnId || !Number.isInteger(input.ordinal))
      throw memoryError("athena_3d_memory_turn_invalid", 400);
    assertStateWindow(input.stateWindow);
    const existing =
      await this.client.athena_3d_session_memory_turns.findUnique({
        where: { id: turnId },
      });
    if (existing) {
      const replaySession = await this.requireSession(conversationId, input);
      return {
        committed: true,
        replay: true,
        memory_revision: replaySession.memoryRevision,
        state_revision: replaySession.stateRevision,
        checkpoint_revision: replaySession.checkpointRevision,
        context_ref: this.contextRef(replaySession),
      };
    }
    const stateTokens = tokenCount(input.stateWindow);
    if (stateTokens > this.config.stateWindowMaxTokens)
      throw memoryError("athena_3d_memory_state_window_too_large", 413, {
        tokenCount: stateTokens,
        limit: this.config.stateWindowMaxTokens,
      });
    const language = {
      user: String(input.user || ""),
      assistant: String(input.assistant || ""),
    };
    const languageTokens = tokenCount(language);
    const nextStateRevision = Number(input.stateWindow.current_state.revision);
    const userJson = serialize(language.user);
    const assistantJson = serialize(language.assistant);
    const previousStateJson = serialize(input.stateWindow.previous_state);
    const transitionJson = input.stateWindow.transition
      ? serialize(input.stateWindow.transition)
      : null;
    const currentStateJson = serialize(input.stateWindow.current_state);
    return this.client.$transaction(async (tx) => {
      const session = await tx.athena_3d_session_memories.findUnique({
        where: { conversationId },
      });
      if (!session || !scopeMatches(session, input))
        throw memoryError("athena_3d_memory_session_not_found", 404);
      const replay = await tx.athena_3d_session_memory_turns.findUnique({
        where: { id: turnId },
      });
      if (replay)
        return {
          committed: true,
          replay: true,
          memory_revision: session.memoryRevision,
          state_revision: session.stateRevision,
          checkpoint_revision: session.checkpointRevision,
          context_ref: this.contextRef(session),
        };
      if (session.memoryRevision !== Number(input.expectedMemoryRevision))
        throw memoryError("athena_3d_memory_revision_conflict", 409, {
          expected: input.expectedMemoryRevision,
          actual: session.memoryRevision,
        });
      // Conversation ordinals include failed model turns. Session Memory owns
      // only successfully committed turns, so gaps are valid while reversal
      // and duplicate ordinals remain conflicts.
      if (input.ordinal <= session.lastCommittedTurnOrdinal)
        throw memoryError("athena_3d_memory_ordinal_conflict", 409, {
          committedThrough: session.lastCommittedTurnOrdinal,
          received: input.ordinal,
        });
      const stateRow = await tx.athena_3d_character_state_windows.findUnique({
        where: { conversationId },
      });
      if (
        !stateRow ||
        stateRow.stateRevision !== Number(input.expectedStateRevision)
      )
        throw memoryError("athena_3d_memory_state_revision_conflict", 409);
      await tx.athena_3d_session_memory_turns.create({
        data: {
          id: turnId,
          conversationId,
          ordinal: input.ordinal,
          responseId: input.responseId || null,
          userJson,
          assistantJson,
          languageHash: sha256(language),
          tokenCount: languageTokens,
          previousContextCursorId:
            input.previousContextRef?.cursor_id || session.contextCursorId,
        },
      });
      const stateUpdated =
        await tx.athena_3d_character_state_windows.updateMany({
          where: {
            conversationId,
            stateRevision: Number(input.expectedStateRevision),
          },
          data: {
            stateRevision: nextStateRevision,
            previousStateJson,
            transitionJson,
            currentStateJson,
            windowHash: sha256(input.stateWindow),
            tokenCount: stateTokens,
            sourceTurnId: turnId,
            sourceResponseId: input.responseId || null,
            sourceSequenceId:
              input.stateWindow.current_state.source_sequence_id || null,
          },
        });
      if (stateUpdated.count !== 1)
        throw memoryError("athena_3d_memory_state_revision_conflict", 409);
      const activeCheckpoint = session.activeCheckpointId
        ? await tx.athena_3d_session_memory_checkpoints.findUnique({
            where: { id: session.activeCheckpointId },
          })
        : null;
      const uncompactedTokens = session.uncompactedTokens + languageTokens;
      const uncompactedTurns = session.uncompactedTurns + 1;
      const projectedContextTokens =
        Number(activeCheckpoint?.tokenAfter || 0) +
        uncompactedTokens +
        stateTokens;
      const nextMemoryRevision = session.memoryRevision + 1;
      const nextContextCursorId = contextCursorId();
      await tx.athena_3d_session_memory_turns.update({
        where: { id: turnId },
        data: { contextCursorId: nextContextCursorId },
      });
      const sessionUpdated = await tx.athena_3d_session_memories.updateMany({
        where: { conversationId, memoryRevision: session.memoryRevision },
        data: {
          memoryRevision: nextMemoryRevision,
          stateRevision: nextStateRevision,
          lastCommittedTurnOrdinal: input.ordinal,
          uncompactedTokens,
          uncompactedTurns,
          projectedContextTokens,
          status: input.sessionStatus || "active",
          contextCursorId: nextContextCursorId,
          contextUpdatedAt: new Date(),
        },
      });
      if (sessionUpdated.count !== 1)
        throw memoryError("athena_3d_memory_revision_conflict", 409);
      let checkpointJob = null;
      const shouldCompact =
        projectedContextTokens >= this.config.compressionTriggerTokens ||
        uncompactedTurns >= this.config.compressionTriggerTurns;
      if (shouldCompact) {
        const pending = await tx.athena_3d_session_memory_checkpoints.findFirst(
          {
            where: { conversationId, status: { in: ["queued", "running"] } },
          }
        );
        if (!pending) {
          const coveredFromOrdinal =
            Number(activeCheckpoint?.coveredToOrdinal || 0) + 1;
          const sourceRows = await tx.athena_3d_session_memory_turns.findMany({
            where: {
              conversationId,
              ordinal: { gte: coveredFromOrdinal, lte: input.ordinal },
            },
            orderBy: { ordinal: "asc" },
            select: { ordinal: true, languageHash: true },
          });
          const checkpointId = `ath3d_mem_cp_${crypto
            .randomUUID()
            .replace(/-/g, "")}`;
          checkpointJob = await tx.athena_3d_session_memory_checkpoints.create({
            data: {
              id: checkpointId,
              rangeKey: `${conversationId}:${session.activeCheckpointId || "root"}:${input.ordinal}`,
              conversationId,
              previousCheckpointId: session.activeCheckpointId,
              coveredFromOrdinal,
              coveredToOrdinal: input.ordinal,
              sourceHash: sha256(sourceRows),
              compressionVersion: "athena.3d-session-memory.compaction.v1",
              tokenBefore:
                Number(activeCheckpoint?.tokenAfter || 0) + uncompactedTokens,
              status: "queued",
            },
          });
        } else checkpointJob = pending;
      }
      return {
        committed: true,
        replay: false,
        memory_revision: nextMemoryRevision,
        state_revision: nextStateRevision,
        checkpoint_revision: Number(session.checkpointRevision || 0),
        context_ref: {
          cursor_id: nextContextCursorId,
          memory_revision: nextMemoryRevision,
          state_revision: nextStateRevision,
          checkpoint_revision: Number(session.checkpointRevision || 0),
          last_turn_ordinal: input.ordinal,
          expires_at: Date.now() + this.config.contextCacheTtlMs,
        },
        projected_context_tokens: projectedContextTokens,
        hard_gate: projectedContextTokens >= this.config.hardGateTokens,
        checkpoint_job: checkpointJob
          ? { id: checkpointJob.id, status: checkpointJob.status }
          : null,
      };
    });
  }

  async status(input = {}) {
    const session = await this.requireSession(input.conversationId, input);
    const pending =
      await this.client.athena_3d_session_memory_checkpoints.findFirst({
        where: {
          conversationId: session.conversationId,
          status: { in: ["queued", "running", "failed"] },
        },
        orderBy: { createdAt: "desc" },
      });
    return {
      protocol_version: "1.0",
      conversation_id: session.conversationId,
      status: session.status,
      memory_revision: session.memoryRevision,
      state_revision: session.stateRevision,
      checkpoint_revision: session.checkpointRevision,
      context_ref: this.contextRef(session),
      last_committed_turn_ordinal: session.lastCommittedTurnOrdinal,
      projected_context_tokens: session.projectedContextTokens,
      context_budget_tokens: this.config.contextBudgetTokens,
      compression_trigger_tokens: this.config.compressionTriggerTokens,
      hard_gate_tokens: this.config.hardGateTokens,
      active_checkpoint_id: session.activeCheckpointId,
      pending_checkpoint: pending
        ? { id: pending.id, status: pending.status, attempts: pending.attempts }
        : null,
      character_memory: {
        mode: session.memoryMode,
        profile_ref: session.longTermProfileId
          ? {
              id: session.longTermProfileId,
              revision: session.longTermProfileRevision,
            }
          : null,
      },
    };
  }

  async archiveLongTerm(input = {}) {
    const session = await this.requireSession(input.conversationId, input);
    if (session.memoryMode !== "persistent" || !session.longTermProfileId)
      return { archived: false, reason: "ephemeral" };
    const stateRow =
      await this.client.athena_3d_character_state_windows.findUnique({
        where: { conversationId: session.conversationId },
      });
    const turns = await this.client.athena_3d_session_memory_turns.findMany({
      where: { conversationId: session.conversationId },
      orderBy: { ordinal: "asc" },
    });
    if (!stateRow)
      throw memoryError("athena_3d_long_term_final_state_missing", 409);
    const currentState = await deserialize(stateRow.currentStateJson);
    return this.client.$transaction(async (tx) => {
      const profile = await tx.athena_3d_character_memory_profiles.findUnique({
        where: { id: session.longTermProfileId },
      });
      if (!profile)
        throw memoryError("athena_3d_long_term_profile_not_found", 404);
      const existing = await tx.athena_3d_character_memory_sessions.findUnique({
        where: { conversationId: session.conversationId },
      });
      const currentStateHash = sha256(currentState);
      if (
        existing &&
        existing.archivedThroughOrdinal === session.lastCommittedTurnOrdinal &&
        existing.finalStateHash === currentStateHash &&
        ["consolidation_queued", "consolidating", "finalized"].includes(
          existing.status
        )
      ) {
        const replayJob = await tx.athena_3d_character_memory_jobs.findUnique({
          where: {
            memorySessionId_finalizationEpoch: {
              memorySessionId: existing.id,
              finalizationEpoch: existing.finalizationEpoch,
            },
          },
        });
        return {
          archived: true,
          replay: true,
          memory_session_id: existing.id,
          archived_through_ordinal: existing.archivedThroughOrdinal,
          finalization_epoch: existing.finalizationEpoch,
          job: replayJob
            ? { id: replayJob.id, status: replayJob.status }
            : null,
        };
      }
      const nextEpoch = Number(existing?.finalizationEpoch || 0) + 1;
      const memorySessionId = existing?.id || memoryId("chr_mem_session");
      const memorySession = await tx.athena_3d_character_memory_sessions.upsert(
        {
          where: { conversationId: session.conversationId },
          create: {
            id: memorySessionId,
            conversationId: session.conversationId,
            profileId: profile.id,
            workspaceId: session.workspaceId,
            threadId: session.threadId,
            ownerUserId: profile.ownerUserId,
            characterId: profile.characterId,
            characterInstanceId: profile.characterInstanceId,
            status: "consolidation_queued",
            formationStatus: "pending",
            finalizationEpoch: nextEpoch,
            archivedThroughOrdinal: session.lastCommittedTurnOrdinal,
            finalStateSnapshotJson: serialize(currentState),
            finalStateHash: currentStateHash,
            sourceStateRevision: stateRow.stateRevision,
            sourceTurnId: stateRow.sourceTurnId,
            sourceResponseId: stateRow.sourceResponseId,
            sourceContextRefJson: serialize(this.contextRef(session)),
          },
          update: {
            status: "consolidation_queued",
            formationStatus: "pending",
            finalizationEpoch: nextEpoch,
            archivedThroughOrdinal: session.lastCommittedTurnOrdinal,
            finalStateSnapshotJson: serialize(currentState),
            finalStateHash: currentStateHash,
            sourceStateRevision: stateRow.stateRevision,
            sourceTurnId: stateRow.sourceTurnId,
            sourceResponseId: stateRow.sourceResponseId,
            sourceContextRefJson: serialize(this.contextRef(session)),
          },
        }
      );
      for (const turn of turns)
        await tx.athena_3d_character_memory_turns.upsert({
          where: {
            conversationId_ordinal: {
              conversationId: session.conversationId,
              ordinal: turn.ordinal,
            },
          },
          create: {
            id: memoryId("chr_mem_turn"),
            memorySessionId,
            conversationId: session.conversationId,
            ordinal: turn.ordinal,
            sourceTurnId: turn.id,
            responseId: turn.responseId,
            userJson: turn.userJson,
            assistantJson: turn.assistantJson,
            languageHash: turn.languageHash,
          },
          update: {
            responseId: turn.responseId,
            userJson: turn.userJson,
            assistantJson: turn.assistantJson,
            languageHash: turn.languageHash,
          },
        });
      const newTurns = turns.filter(
        (row) => row.ordinal > Number(existing?.finalizedThroughOrdinal || 0)
      );
      const sourceHash = sha256({
        turns: newTurns.map((row) => [row.ordinal, row.languageHash]),
        finalStateHash: currentStateHash,
        profileRevision: profile.revision,
      });
      const job = await tx.athena_3d_character_memory_jobs.upsert({
        where: {
          memorySessionId_finalizationEpoch: {
            memorySessionId,
            finalizationEpoch: nextEpoch,
          },
        },
        create: {
          id: memoryId("chr_mem_job"),
          memorySessionId,
          finalizationEpoch: nextEpoch,
          sourceHash,
          expectedProfileRevision: profile.revision,
          schemaVersion: 2,
          taskKind: "reflection",
          contextRefJson: serialize(this.contextRef(session)),
        },
        update: {},
      });
      return {
        archived: true,
        memory_session_id: memorySession.id,
        archived_through_ordinal: memorySession.archivedThroughOrdinal,
        finalization_epoch: nextEpoch,
        job: { id: job.id, status: job.status },
      };
    });
  }

  async claimLongTermJob(ownerId) {
    const now = new Date();
    const candidate =
      await this.client.athena_3d_character_memory_jobs.findFirst({
        where: {
          attempts: { lt: this.config.longTermJobMaxAttempts },
          OR: [
            { status: "queued", leaseExpiresAt: null },
            { status: "queued", leaseExpiresAt: { lte: now } },
            { status: "running", leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
    if (!candidate) return null;
    const claimed =
      await this.client.athena_3d_character_memory_jobs.updateMany({
        where: { id: candidate.id, attempts: candidate.attempts },
        data: {
          status: "running",
          leaseOwner: ownerId,
          leaseExpiresAt: new Date(Date.now() + this.config.jobLeaseMs),
          attempts: candidate.attempts + 1,
        },
      });
    return claimed.count === 1
      ? this.client.athena_3d_character_memory_jobs.findUnique({
          where: { id: candidate.id },
        })
      : null;
  }

  async enqueueLegacyReflectionJob() {
    const session =
      await this.client.athena_3d_character_memory_sessions.findFirst({
        where: { legacyReflectionPending: true },
        orderBy: { createdAt: "asc" },
      });
    if (!session) return null;
    const profile =
      await this.client.athena_3d_character_memory_profiles.findUnique({
        where: { id: session.profileId },
      });
    if (!profile) return null;
    const nextEpoch = Number(session.finalizationEpoch || 0) + 1;
    return this.client.$transaction(async (tx) => {
      const job = await tx.athena_3d_character_memory_jobs.upsert({
        where: {
          memorySessionId_finalizationEpoch: {
            memorySessionId: session.id,
            finalizationEpoch: nextEpoch,
          },
        },
        create: {
          id: memoryId("chr_mem_job"),
          memorySessionId: session.id,
          finalizationEpoch: nextEpoch,
          schemaVersion: 2,
          taskKind: "legacy_reflection_replay",
          sourceHash: sha256({
            session: session.id,
            epoch: nextEpoch,
            finalStateHash: session.finalStateHash,
          }),
          expectedProfileRevision: profile.revision,
        },
        update: {},
      });
      await tx.athena_3d_character_memory_sessions.update({
        where: { id: session.id },
        data: {
          finalizationEpoch: nextEpoch,
          status: "consolidation_queued",
          formationStatus: "legacy_reflection_queued",
          legacyReflectionPending: false,
        },
      });
      return job;
    });
  }

  async claimLongTermJobById(jobId, ownerId) {
    const candidate =
      await this.client.athena_3d_character_memory_jobs.findUnique({
        where: { id: jobId },
      });
    if (
      !candidate ||
      !["queued", "hot_pending"].includes(candidate.status) ||
      candidate.attempts >= this.config.longTermJobMaxAttempts
    )
      return null;
    const claimed =
      await this.client.athena_3d_character_memory_jobs.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          attempts: candidate.attempts,
        },
        data: {
          status: "running",
          leaseOwner: ownerId,
          leaseExpiresAt: new Date(Date.now() + this.config.jobLeaseMs),
          attempts: candidate.attempts + 1,
        },
      });
    return claimed.count === 1
      ? this.client.athena_3d_character_memory_jobs.findUnique({
          where: { id: candidate.id },
        })
      : null;
  }

  async longTermJobSource(job) {
    const session =
      await this.client.athena_3d_character_memory_sessions.findUnique({
        where: { id: job.memorySessionId },
      });
    if (!session)
      throw memoryError("athena_3d_long_term_session_not_found", 404);
    const profile =
      await this.client.athena_3d_character_memory_profiles.findUnique({
        where: { id: session.profileId },
      });
    const rows = await this.client.athena_3d_character_memory_turns.findMany({
      where: { memorySessionId: session.id },
      orderBy: { ordinal: "asc" },
    });
    return {
      session,
      profile,
      rows,
      source: {
        object: "athena.3d_center.character_memory_source",
        protocol_version: "2.0",
        finalization_epoch: job.finalizationEpoch,
        finalized_through_ordinal: session.finalizedThroughOrdinal,
        new_turn_ordinals: rows
          .filter((row) => row.ordinal > session.finalizedThroughOrdinal)
          .map((row) => row.ordinal),
        character_core: {
          id: profile.coreId,
          version: profile.coreVersion,
          sha256: profile.coreSha256,
          snapshot: profile.coreSnapshotJson
            ? await deserialize(profile.coreSnapshotJson)
            : requireCharacterCore(profile.characterId).snapshot,
          policy: "read_only",
        },
        current_adaptive_self: await adaptiveSelf(profile),
        current_relationship: await relationshipV2(profile),
        turns: await Promise.all(
          rows.map(async (row) => ({
            ordinal: row.ordinal,
            turn_id: row.sourceTurnId,
            response_id: row.responseId,
            evidence_hash: row.languageHash,
            user: await deserialize(row.userJson),
            assistant: await deserialize(row.assistantJson),
          }))
        ),
        authoritative_final_state: await deserialize(
          session.finalStateSnapshotJson
        ),
      },
    };
  }

  async completeLongTermJob(job, result) {
    const { session, profile, source, rows } =
      await this.longTermJobSource(job);
    if (
      result.payload?.object === "athena.3d_center.character_reflection" &&
      result.payload?.protocol_version === "2.0"
    )
      return formReflectionV2({
        client: this.client,
        job,
        session,
        profile,
        rows,
        payload: result.payload,
        result,
      });
    const before = await deserialize(profile.relationshipJson);
    const validation = validateConsolidation(
      result.payload,
      before,
      source.turns.map((turn) => turn.ordinal)
    );
    if (!validation.ok) throw memoryError(validation.code, 502);
    const payload = validation.value;
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
    return this.client.$transaction(async (tx) => {
      const updated = await tx.athena_3d_character_memory_profiles.updateMany({
        where: { id: profile.id, revision: job.expectedProfileRevision },
        data: {
          revision: job.expectedProfileRevision + 1,
          relationshipJson: serialize(payload.relationship_transition.after),
          emotionJson: serialize({
            ...payload.final_emotion,
            observed_at: Date.now(),
          }),
          latestSessionId: session.id,
        },
      });
      if (updated.count !== 1)
        throw memoryError("athena_3d_long_term_profile_revision_conflict", 409);
      await tx.athena_3d_character_memory_revisions.create({
        data: {
          id: memoryId("chr_mem_revision"),
          profileId: profile.id,
          memorySessionId: session.id,
          finalizationEpoch: job.finalizationEpoch,
          fromRevision: job.expectedProfileRevision,
          toRevision: job.expectedProfileRevision + 1,
          relationshipBeforeJson: serialize(
            payload.relationship_transition.before
          ),
          relationshipDeltaJson: serialize(
            payload.relationship_transition.delta
          ),
          relationshipAfterJson: serialize(
            payload.relationship_transition.after
          ),
          narrative: payload.relationship_transition.narrative,
          confidence: payload.relationship_transition.confidence,
        },
      });
      await tx.athena_3d_character_memory_sessions.update({
        where: { id: session.id },
        data: {
          status: "finalized",
          finalizedThroughOrdinal: session.archivedThroughOrdinal,
          summaryJson: serialize(payload),
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
      };
    });
  }

  async failLongTermJob(job, error) {
    if (String(error?.code || "").includes("profile_revision_conflict")) {
      const memorySession =
        await this.client.athena_3d_character_memory_sessions.findUnique({
          where: { id: job.memorySessionId },
        });
      const latestProfile = memorySession
        ? await this.client.athena_3d_character_memory_profiles.findUnique({
            where: { id: memorySession.profileId },
          })
        : null;
      if (latestProfile) {
        await this.client.athena_3d_character_memory_jobs.update({
          where: { id: job.id },
          data: {
            status: "queued",
            expectedProfileRevision: latestProfile.revision,
            attempts: 0,
            errorCode: error.code,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        return;
      }
    }
    const terminal = job.attempts >= this.config.longTermJobMaxAttempts;
    await this.client.athena_3d_character_memory_jobs.update({
      where: { id: job.id },
      data: {
        status: terminal ? "needs_reconsolidation" : "queued",
        errorCode: error.code || error.message,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (terminal)
      await this.client.athena_3d_character_memory_sessions.update({
        where: { id: job.memorySessionId },
        data: { status: "needs_reconsolidation" },
      });
  }

  async requireProfile(input = {}) {
    const ownerUserId = Number(input.ownerUserId || 0);
    const characterInstanceId = String(input.characterInstanceId || "").trim();
    if (!ownerUserId || !characterInstanceId)
      throw memoryError("athena_3d_long_term_memory_scope_required", 400);
    const profile =
      await this.client.athena_3d_character_memory_profiles.findFirst({
        where: {
          ownerUserId,
          characterInstanceId,
          ...(input.characterId
            ? { characterId: String(input.characterId) }
            : {}),
        },
      });
    if (!profile)
      throw memoryError("athena_3d_long_term_profile_not_found", 404);
    return profile;
  }

  async resolveLongTermContext(input = {}) {
    const profile = await this.requireProfile(input);
    const context = await this.longTermContextForProfile(this.client, profile);
    return { profile, context };
  }

  async longTermStatus(input = {}) {
    const profile = await this.requireProfile(input);
    const core = profile.coreSnapshotJson
      ? {
          id: profile.coreId,
          version: profile.coreVersion,
          sha256: profile.coreSha256,
          snapshot: await deserialize(profile.coreSnapshotJson),
        }
      : requireCharacterCore(profile.characterId);
    const [
      relationshipModel,
      adaptive,
      userModelCount,
      memoryCount,
      growthCount,
      milestoneCount,
    ] = await Promise.all([
      relationshipV2(profile),
      adaptiveSelf(profile),
      this.client.athena_3d_character_user_model_entries.count({
        where: { profileId: profile.id, status: "active" },
      }),
      this.client.athena_3d_character_memories.count({
        where: { profileId: profile.id, status: "active" },
      }),
      this.client.athena_3d_character_growth_nodes.count({
        where: { profileId: profile.id, status: "active" },
      }),
      this.client.athena_3d_character_emotional_milestones.count({
        where: { profileId: profile.id, status: "active" },
      }),
    ]);
    const projectProfile = async () => ({
      id: profile.id,
      revision: profile.revision,
      schema_version: profile.schemaVersion,
      character_id: profile.characterId,
      character_instance_id: profile.characterInstanceId,
      core_ref: { id: core.id, version: core.version, sha256: core.sha256 },
      adaptive_self: adaptive,
      relationship: relationshipModel,
      relationship_compatibility: await deserialize(profile.relationshipJson),
      user_model_summary: profile.userModelSummaryJson
        ? await deserialize(profile.userModelSummaryJson)
        : { entries: [] },
      emotion: await deserialize(profile.emotionJson),
      latest_session_id: profile.latestSessionId,
      statistics: {
        user_model_entries: userModelCount,
        autobiographical_memories: memoryCount,
        growth_nodes: growthCount,
        emotional_milestones: milestoneCount,
      },
    });
    const sessions =
      await this.client.athena_3d_character_memory_sessions.findMany({
        where: { profileId: profile.id },
        orderBy: { createdAt: "desc" },
        take: Math.max(1, Math.min(Number(input.limit || 50), 100)),
      });
    const projectSession = (row) => ({
      id: row.id,
      conversation_id: row.conversationId,
      status: row.status,
      finalization_epoch: row.finalizationEpoch,
      archived_through_ordinal: row.archivedThroughOrdinal,
      finalized_through_ordinal: row.finalizedThroughOrdinal,
      final_state_hash: row.finalStateHash,
      source_state_revision: row.sourceStateRevision,
      cache_mode: row.cacheMode,
      provider_cache: {
        hit_tokens: Number(row.providerCacheHitTokens || 0),
        miss_tokens: Number(row.providerCacheMissTokens || 0),
        hit_rate: Number(row.providerCacheHitRate || 0),
      },
      finalized_at: row.finalizedAt?.getTime?.() || null,
      created_at: row.createdAt?.getTime?.() || null,
    });
    if (input.memorySessionId) {
      const session = sessions.find(
        (row) => row.id === String(input.memorySessionId)
      );
      if (!session)
        throw memoryError("athena_3d_long_term_session_not_found", 404);
      const turns = await this.client.athena_3d_character_memory_turns.findMany(
        {
          where: { memorySessionId: session.id },
          orderBy: { ordinal: "asc" },
        }
      );
      return {
        profile: await projectProfile(),
        session: {
          ...projectSession(session),
          summary: session.summaryJson
            ? await deserialize(session.summaryJson)
            : null,
          reflection: session.reflectionJson
            ? await deserialize(session.reflectionJson)
            : null,
          formation_status: session.formationStatus,
          final_state_snapshot: await deserialize(
            session.finalStateSnapshotJson
          ),
          turns: await Promise.all(
            turns.map(async (row) => ({
              ordinal: row.ordinal,
              turn_id: row.sourceTurnId,
              response_id: row.responseId,
              user: await deserialize(row.userJson),
              assistant: await deserialize(row.assistantJson),
            }))
          ),
        },
      };
    }
    return {
      profile: await projectProfile(),
      sessions: sessions.map(projectSession),
    };
  }

  async listLongTermObjects(input = {}) {
    const profile = await this.requireProfile(input);
    const limit = Math.max(1, Math.min(Number(input.limit || 50), 100));
    const kind = String(input.kind || "memories");
    if (kind === "growth_nodes")
      return this.client.athena_3d_character_growth_nodes.findMany({
        where: { profileId: profile.id, status: "active" },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
    if (kind === "milestones")
      return this.client.athena_3d_character_emotional_milestones.findMany({
        where: { profileId: profile.id, status: "active" },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
    return this.client.athena_3d_character_memories.findMany({
      where: { profileId: profile.id, status: "active" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async reprojectProfile(tx, profile) {
    const revisions = await tx.athena_3d_character_memory_revisions.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: "asc" },
    });
    const relationship = initialRelationship();
    const relationshipV2State = initialRelationshipV2();
    const adaptiveState = initialAdaptiveSelf();
    for (const revision of revisions) {
      const delta = await deserialize(revision.relationshipDeltaJson);
      for (const key of Object.keys(relationship))
        relationship[key] = Math.min(
          1,
          Math.max(0, Number(relationship[key]) + Number(delta[key] || 0))
        );
      const v2Delta = revision.relationshipV2DeltaJson
        ? await deserialize(revision.relationshipV2DeltaJson)
        : {
            familiarity: delta.closeness || 0,
            trust: delta.trust || 0,
            comfort: delta.comfort || 0,
            attachment: delta.affection || 0,
            openness: -Number(delta.guardedness || 0),
            physical_closeness: 0,
          };
      for (const key of Object.keys(relationshipV2State))
        relationshipV2State[key] = Math.min(
          1,
          Math.max(
            0,
            Number(relationshipV2State[key]) + Number(v2Delta[key] || 0)
          )
        );
      const adaptiveDelta = revision.adaptiveDeltaJson
        ? await deserialize(revision.adaptiveDeltaJson)
        : {};
      for (const key of Object.keys(adaptiveState))
        adaptiveState[key] = Math.min(
          1,
          Math.max(
            0,
            Number(adaptiveState[key]) + Number(adaptiveDelta[key] || 0)
          )
        );
    }
    const latestSession =
      await tx.athena_3d_character_memory_sessions.findFirst({
        where: { profileId: profile.id, status: "finalized" },
        orderBy: { finalizedAt: "desc" },
      });
    const summary = latestSession?.summaryJson
      ? await deserialize(latestSession.summaryJson)
      : null;
    await tx.athena_3d_character_memory_profiles.update({
      where: { id: profile.id },
      data: {
        revision: revisions.length,
        relationshipJson: serialize(
          legacyRelationshipProjection(relationshipV2State)
        ),
        relationshipV2Json: serialize(relationshipV2State),
        adaptiveSelfJson: serialize(adaptiveState),
        emotionJson: serialize(
          summary?.final_emotion
            ? { ...summary.final_emotion, observed_at: Date.now() }
            : initialEmotion()
        ),
        latestSessionId: latestSession?.id || null,
      },
    });
  }

  async deleteLongTermSession(input = {}) {
    const profile = await this.requireProfile(input);
    const memorySessionId = String(input.memorySessionId || "");
    const session =
      await this.client.athena_3d_character_memory_sessions.findFirst({
        where: { id: memorySessionId, profileId: profile.id },
      });
    if (!session)
      throw memoryError("athena_3d_long_term_session_not_found", 404);
    const orphaned = [];
    await this.client.$transaction(async (tx) => {
      const affectedEvidence =
        await tx.athena_3d_character_memory_evidence.findMany({
          where: { memorySessionId },
          select: { subjectType: true, subjectId: true },
        });
      await tx.athena_3d_character_memory_evidence.deleteMany({
        where: { memorySessionId },
      });
      await tx.athena_3d_character_memory_candidates.deleteMany({
        where: { memorySessionId },
      });
      for (const evidence of affectedEvidence) {
        const remaining = await tx.athena_3d_character_memory_evidence.count({
          where: {
            subjectType: evidence.subjectType,
            subjectId: evidence.subjectId,
          },
        });
        if (remaining) continue;
        const delegate = {
          memory: tx.athena_3d_character_memories,
          user_model: tx.athena_3d_character_user_model_entries,
          growth: tx.athena_3d_character_growth_nodes,
          milestone: tx.athena_3d_character_emotional_milestones,
        }[evidence.subjectType];
        if (delegate) {
          await delegate.deleteMany({ where: { id: evidence.subjectId } });
          orphaned.push({ type: evidence.subjectType, id: evidence.subjectId });
        }
      }
      await tx.athena_3d_character_memory_jobs.deleteMany({
        where: { memorySessionId },
      });
      await tx.athena_3d_character_memory_revisions.deleteMany({
        where: { memorySessionId },
      });
      await tx.athena_3d_character_memory_turns.deleteMany({
        where: { memorySessionId },
      });
      await tx.athena_3d_character_memory_sessions.delete({
        where: { id: memorySessionId },
      });
      await this.reprojectProfile(tx, profile);
    });
    for (const item of orphaned)
      await deleteObjectIndex(profile.id, item.type, item.id);
    return { deleted: true, memory_session_id: memorySessionId };
  }

  async resetLongTermProfile(input = {}) {
    const profile = await this.requireProfile(input);
    await deleteProfileIndex(this.client, profile.id).catch(() => false);
    const sessions =
      await this.client.athena_3d_character_memory_sessions.findMany({
        where: { profileId: profile.id },
        select: { id: true },
      });
    const ids = sessions.map((row) => row.id);
    await this.client.$transaction([
      this.client.athena_3d_session_memories.updateMany({
        where: { longTermProfileId: profile.id },
        data: {
          memoryMode: "ephemeral",
          longTermProfileId: null,
          longTermProfileRevision: 0,
          longTermContextJson: null,
          contextCursorId: contextCursorId(),
          contextUpdatedAt: new Date(),
        },
      }),
      this.client.athena_3d_character_memory_jobs.deleteMany({
        where: { memorySessionId: { in: ids } },
      }),
      this.client.athena_3d_character_memory_evidence.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_memory_candidates.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_user_model_entries.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_memories.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_growth_nodes.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_emotional_milestones.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_memory_revisions.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_memory_turns.deleteMany({
        where: { memorySessionId: { in: ids } },
      }),
      this.client.athena_3d_character_memory_sessions.deleteMany({
        where: { profileId: profile.id },
      }),
      this.client.athena_3d_character_memory_profiles.delete({
        where: { id: profile.id },
      }),
    ]);
    return { deleted: true, profile_id: profile.id };
  }

  async reconsolidateLongTerm(input = {}) {
    const profile = await this.requireProfile(input);
    const session = input.memorySessionId
      ? await this.client.athena_3d_character_memory_sessions.findFirst({
          where: { id: String(input.memorySessionId), profileId: profile.id },
        })
      : await this.client.athena_3d_character_memory_sessions.findFirst({
          where: { profileId: profile.id },
          orderBy: { createdAt: "desc" },
        });
    if (!session)
      throw memoryError("athena_3d_long_term_session_not_found", 404);
    const nextEpoch = session.finalizationEpoch + 1;
    const job = await this.client.athena_3d_character_memory_jobs.create({
      data: {
        id: memoryId("chr_mem_job"),
        memorySessionId: session.id,
        finalizationEpoch: nextEpoch,
        sourceHash: sha256({
          session: session.id,
          epoch: nextEpoch,
          finalStateHash: session.finalStateHash,
        }),
        expectedProfileRevision: profile.revision,
        schemaVersion: 2,
        taskKind: "reflection",
      },
    });
    await this.client.athena_3d_character_memory_sessions.update({
      where: { id: session.id },
      data: {
        finalizationEpoch: nextEpoch,
        status: "consolidation_queued",
      },
    });
    return { queued: true, job: { id: job.id, status: job.status } };
  }

  async deleteSession(input = {}) {
    const existing = await this.findSession(input.conversationId);
    if (!existing)
      return {
        conversation_id: String(input.conversationId || ""),
        deleted: true,
        replay: true,
      };
    if (!scopeMatches(existing, input))
      throw memoryError("athena_3d_memory_session_not_found", 404);
    const session = existing;
    const conversationId = session.conversationId;
    await this.client.$transaction([
      this.client.athena_3d_character_state_windows.deleteMany({
        where: { conversationId },
      }),
      this.client.athena_3d_session_memory_checkpoints.deleteMany({
        where: { conversationId },
      }),
      this.client.athena_3d_session_memory_turns.deleteMany({
        where: { conversationId },
      }),
      this.client.athena_3d_session_memories.deleteMany({
        where: { conversationId },
      }),
    ]);
    return { conversation_id: conversationId, deleted: true };
  }

  async claimCheckpoint(ownerId) {
    const now = new Date();
    const candidate =
      await this.client.athena_3d_session_memory_checkpoints.findFirst({
        where: {
          attempts: { lt: this.config.jobMaxAttempts },
          OR: [
            { status: "queued", leaseExpiresAt: null },
            { status: "queued", leaseExpiresAt: { lte: now } },
            { status: "running", leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
    if (!candidate) return null;
    const claimed =
      await this.client.athena_3d_session_memory_checkpoints.updateMany({
        where: {
          id: candidate.id,
          attempts: candidate.attempts,
          status: candidate.status,
          leaseExpiresAt: candidate.leaseExpiresAt,
        },
        data: {
          status: "running",
          leaseOwner: ownerId,
          leaseExpiresAt: new Date(now.getTime() + this.config.jobLeaseMs),
          attempts: candidate.attempts + 1,
          errorCode: null,
        },
      });
    if (claimed.count !== 1) return null;
    return this.client.athena_3d_session_memory_checkpoints.findUnique({
      where: { id: candidate.id },
    });
  }

  async checkpointSource(job) {
    const previous = job.previousCheckpointId
      ? await this.client.athena_3d_session_memory_checkpoints.findUnique({
          where: { id: job.previousCheckpointId },
        })
      : null;
    const rows = await this.client.athena_3d_session_memory_turns.findMany({
      where: {
        conversationId: job.conversationId,
        ordinal: {
          gte: job.coveredFromOrdinal,
          lte: job.coveredToOrdinal,
        },
      },
      orderBy: { ordinal: "asc" },
    });
    const sourceHash = sha256(
      rows.map((row) => ({
        ordinal: row.ordinal,
        languageHash: row.languageHash,
      }))
    );
    if (sourceHash !== job.sourceHash)
      throw memoryError("athena_3d_memory_checkpoint_source_changed", 409);
    const turns = [];
    for (const row of rows)
      turns.push({
        ordinal: row.ordinal,
        user: await deserialize(
          row.userJson,
          `${row.id}:3d-memory:user`,
          this.env
        ),
        assistant: await deserialize(
          row.assistantJson,
          `${row.id}:3d-memory:assistant`,
          this.env
        ),
      });
    return {
      checkpoint: previous?.summaryJson
        ? await deserialize(
            previous.summaryJson,
            `${previous.id}:3d-memory:checkpoint`,
            this.env
          )
        : null,
      turns,
    };
  }

  async completeCheckpoint(job, result) {
    const outputTokens = tokenCount(result.payload);
    if (outputTokens > this.config.checkpointMaxTokens)
      throw memoryError("athena_3d_memory_checkpoint_too_large", 502, {
        tokenCount: outputTokens,
        limit: this.config.checkpointMaxTokens,
      });
    const summaryJson = serialize(result.payload);
    return this.client.$transaction(async (tx) => {
      const session = await tx.athena_3d_session_memories.findUnique({
        where: { conversationId: job.conversationId },
      });
      const current = await tx.athena_3d_session_memory_checkpoints.findUnique({
        where: { id: job.id },
      });
      if (
        !session ||
        current?.status !== "running" ||
        current.leaseOwner !== job.leaseOwner ||
        current.attempts !== job.attempts
      )
        return { applied: false, lease_lost: true };
      if (
        String(session.activeCheckpointId || "") !==
        String(job.previousCheckpointId || "")
      ) {
        await tx.athena_3d_session_memory_checkpoints.update({
          where: { id: job.id },
          data: {
            status: "superseded",
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
          },
        });
        return { applied: false, superseded: true };
      }
      const remaining = await tx.athena_3d_session_memory_turns.aggregate({
        where: {
          conversationId: job.conversationId,
          ordinal: { gt: job.coveredToOrdinal },
        },
        _sum: { tokenCount: true },
        _count: { id: true },
      });
      const state = await tx.athena_3d_character_state_windows.findUnique({
        where: { conversationId: job.conversationId },
      });
      await tx.athena_3d_session_memory_checkpoints.update({
        where: { id: job.id },
        data: {
          summaryJson,
          summaryHash: sha256(result.payload),
          provider: result.provider,
          model: result.model,
          tokenAfter: outputTokens,
          status: "completed",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      const projectedContextTokens =
        outputTokens +
        Number(remaining._sum.tokenCount || 0) +
        Number(state?.tokenCount || 0);
      await tx.athena_3d_session_memories.update({
        where: { conversationId: job.conversationId },
        data: {
          activeCheckpointId: job.id,
          checkpointRevision: { increment: 1 },
          contextCursorId: contextCursorId(),
          contextUpdatedAt: new Date(),
          uncompactedTokens: Number(remaining._sum.tokenCount || 0),
          uncompactedTurns: Number(remaining._count.id || 0),
          projectedContextTokens,
        },
      });
      if (
        Number(remaining._count.id || 0) > 0 &&
        (projectedContextTokens >= this.config.compressionTriggerTokens ||
          Number(remaining._count.id || 0) >=
            this.config.compressionTriggerTurns)
      ) {
        const sourceRows = await tx.athena_3d_session_memory_turns.findMany({
          where: {
            conversationId: job.conversationId,
            ordinal: {
              gt: job.coveredToOrdinal,
              lte: session.lastCommittedTurnOrdinal,
            },
          },
          orderBy: { ordinal: "asc" },
          select: { ordinal: true, languageHash: true },
        });
        const followupId = `ath3d_mem_cp_${crypto
          .randomUUID()
          .replace(/-/g, "")}`;
        await tx.athena_3d_session_memory_checkpoints.create({
          data: {
            id: followupId,
            rangeKey: `${job.conversationId}:${job.id}:${session.lastCommittedTurnOrdinal}`,
            conversationId: job.conversationId,
            previousCheckpointId: job.id,
            coveredFromOrdinal: job.coveredToOrdinal + 1,
            coveredToOrdinal: session.lastCommittedTurnOrdinal,
            sourceHash: sha256(sourceRows),
            compressionVersion: "athena.3d-session-memory.compaction.v1",
            tokenBefore: outputTokens + Number(remaining._sum.tokenCount || 0),
            status: "queued",
          },
        });
      }
      return { applied: true, checkpoint_id: job.id };
    });
  }

  async failCheckpoint(job, error) {
    const retryable = Number(job.attempts) < this.config.jobMaxAttempts;
    return this.client.athena_3d_session_memory_checkpoints.updateMany({
      where: { id: job.id, status: "running", leaseOwner: job.leaseOwner },
      data: {
        status: retryable ? "queued" : "failed",
        leaseOwner: null,
        leaseExpiresAt: retryable
          ? new Date(Date.now() + Math.min(60_000, 2 ** job.attempts * 1_000))
          : null,
        errorCode: String(
          error?.code || error?.message || "compaction_failed"
        ).slice(0, 160),
      },
    });
  }
}

module.exports = {
  ThreeDSessionMemoryRepository,
  memoryError,
  scopeMatches,
  sha256,
  tokenCount,
  assertStateWindow,
};
