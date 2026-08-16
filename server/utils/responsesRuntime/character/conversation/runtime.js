const prisma = require("../../../prisma");
const { sha256 } = require("../../contract");
const {
  PLAINTEXT_JSON_STORAGE,
  ResponsesRepository,
} = require("../../repository");
const { PROFILE } = require("../v2/profile");
const {
  FlashCharacterV2Adapter,
  characterV2Instructions,
  characterV2ContextPrefix,
} = require("../v2/flashAdapter");
const { MockPerformanceClient } = require("../v2/mockPerformanceClient");
const { materializeCharacterV2Record } = require("../v2/runtime");
const {
  conversationError,
  id,
  initialCharacterState,
  materializeNextState,
  normalizeConversationControl,
  validateCreateConversationRequest,
  validateTurnInput,
} = require("./contract");
const { CharacterConversationRepository } = require("./repository");
const {
  PerformanceDeploymentClient,
} = require("./performanceDeploymentClient");
const { ThreeDSessionMemoryClient } = require("./sessionMemoryClient");
const { GatewayContextClient } = require("./gatewayContextClient");
const {
  initialPersistentState,
  materializePersistentStateWindow,
} = require("./persistentState");

function scopeFromAthena(athena = {}) {
  const workspaceId = Number.isFinite(Number(athena.workspaceId))
    ? Number(athena.workspaceId)
    : null;
  const threadId = Number.isFinite(Number(athena.threadId))
    ? Number(athena.threadId)
    : null;
  const ownerUserId = Number.isFinite(Number(athena.userId))
    ? Number(athena.userId)
    : null;
  const agentRunId = String(athena.agentRunId || "").trim() || null;
  if (workspaceId === null && !agentRunId)
    throw conversationError("character_conversation_scope_required", 400);
  return { workspaceId, threadId, ownerUserId, agentRunId };
}

function publicConversation(row, state = null) {
  return {
    id: row.id,
    object: "character.conversation",
    protocol_version: "2.0",
    status: row.status,
    character_id: row.characterId,
    character_instance_id: row.characterInstanceId,
    current_turn_id: row.currentTurnId,
    last_response_id: row.currentHeadResponseId,
    state_revision: row.stateRevision,
    previous_activity: row.previousActivity,
    soft_close_due_at: row.softCloseDueAt?.getTime?.() || null,
    suspended_at: row.suspendedAt?.getTime?.() || null,
    ended_at: row.endedAt?.getTime?.() || null,
    created_at: row.createdAt?.getTime?.() || null,
    updated_at: row.lastUpdatedAt?.getTime?.() || null,
    ...(state ? { character_state: state.character_state } : {}),
  };
}

function publicTurn(row) {
  return {
    id: row.id,
    object: "character.turn",
    conversation_id: row.conversationId,
    ordinal: row.ordinal,
    previous_turn_id: row.previousTurnId,
    response_id: row.responseId,
    status: row.status,
    expected_state_revision: row.expectedStateRevision,
    expected_memory_revision: row.expectedMemoryRevision,
    memory_status: row.memoryStatus,
    context_ref: row.contextRef || null,
    created_at: row.createdAt?.getTime?.() || null,
    completed_at: row.completedAt?.getTime?.() || null,
  };
}

function userInputText(input = []) {
  return input
    .filter((item) => item?.type === "user_message")
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === "input_text")
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
}

function speechText(response) {
  const speech = response?.output?.[1]?.tracks?.find(
    (track) => track.name === "speech"
  );
  return (speech?.cues || [])
    .map((cue) => cue.text)
    .filter(Boolean)
    .join("\n");
}

function providerCacheEvidence(usage = {}) {
  const hitTokens = Number(
    usage?.hit_tokens ?? usage?.input_tokens_details?.cached_tokens ?? 0
  );
  const missTokens = Number(
    usage?.miss_tokens ?? usage?.input_tokens_details?.cache_miss_tokens ?? 0
  );
  const total = hitTokens + missTokens;
  return {
    hit_tokens: hitTokens,
    miss_tokens: missTokens,
    hit_rate: total > 0 ? Number((hitTokens / total).toFixed(4)) : 0,
  };
}

class CharacterConversationRuntime {
  constructor({
    client = prisma,
    repository = null,
    responsesRepository = null,
    adapter = new FlashCharacterV2Adapter(),
    profile = PROFILE,
    performanceClient = new MockPerformanceClient(),
    performanceDeploymentClient = new PerformanceDeploymentClient(),
    sessionMemoryClient = new ThreeDSessionMemoryClient(),
    gatewayContextClient = new GatewayContextClient(),
    now = () => Date.now(),
  } = {}) {
    this.client = client;
    this.repository =
      repository || new CharacterConversationRepository({ client });
    this.responsesRepository =
      responsesRepository || new ResponsesRepository({ client });
    this.adapter = adapter;
    this.profile = profile;
    this.performanceClient = performanceClient;
    this.performanceDeploymentClient = performanceDeploymentClient;
    this.sessionMemoryClient = sessionMemoryClient;
    this.gatewayContextClient = gatewayContextClient;
    this.now = now;
    this.active = new Map();
  }

  snapshot() {
    return { ready: true, activeCharacterConversations: this.active.size };
  }

  async authorize(conversationId, athena, { privileged = false } = {}) {
    const row = await this.repository.findConversation(conversationId);
    if (!row || row.conversationType !== "character" || row.deletedAt)
      throw conversationError("character_conversation_not_found", 404);
    if (privileged) return row;
    const scope = scopeFromAthena(athena);
    if (
      row.workspaceId !== scope.workspaceId ||
      row.threadId !== scope.threadId ||
      (row.ownerUserId !== null && row.ownerUserId !== scope.ownerUserId) ||
      (row.agentRunId && row.agentRunId !== scope.agentRunId)
    )
      throw conversationError("character_conversation_not_found", 404);
    return row;
  }

  async create(body = {}) {
    const request = validateCreateConversationRequest(body);
    const scope = scopeFromAthena(request.athena);
    const conversationId = id("ath_conv");
    const characterState = initialCharacterState(request.previous_activity);
    const persistentState = initialPersistentState(characterState);
    const character = {
      ...request.character,
      capability_manifest:
        request.character.capability_manifest || this.profile.manifestRef,
    };
    const sessionState = {
      character,
      generation: request.generation,
      metadata: request.metadata,
      memory: request.memory,
      character_state: characterState,
      persistent_state_window: {
        previous_state: persistentState,
        transition: null,
        current_state: persistentState,
      },
    };
    const row = await this.repository.createConversation(
      {
        id: conversationId,
        scopeKey: `character:${conversationId}`,
        workspaceId: scope.workspaceId,
        threadId: scope.threadId,
        agentRunId: scope.agentRunId,
        ownerUserId: scope.ownerUserId,
        status: "created",
        characterId: request.character.character_id,
        characterInstanceId: request.character.instance_id,
        previousActivity: request.previous_activity,
      },
      sessionState
    );
    let contextRef = null;
    const creationWarnings = [];
    if (this.sessionMemoryClient.enabled()) {
      try {
        await this.sessionMemoryClient.createSession({
          conversationId,
          workspaceId: scope.workspaceId,
          threadId: scope.threadId,
          ownerUserId: scope.ownerUserId,
          agentRunId: scope.agentRunId,
          characterId: request.character.character_id,
          characterInstanceId: request.character.instance_id,
          stateWindow: sessionState.persistent_state_window,
          memoryMode: request.memory.mode,
          memory: request.memory,
        });
        const prepared = await this.sessionMemoryClient.contextPrepare({
          ...this.memoryScope(row),
          contextRef: null,
        });
        contextRef = prepared.current_ref || null;
        try {
          const promptContext = this.contextFromMemory(
            prepared,
            row,
            sessionState
          );
          await this.gatewayContextClient.install({
            sessionId: conversationId,
            contextRef,
            memoryPoint: promptContext,
            template: this.contextTemplate(),
            status: row.status,
          });
        } catch {
          creationWarnings.push({
            code: "athena_3d_context_prewarm_failed",
            message:
              "The session was created; Model Gateway context will rebuild on the first response.",
          });
        }
      } catch (error) {
        await this.repository.updateConversation(conversationId, {
          status: "failed",
          currentTurnId: null,
        });
        throw error;
      }
    }
    await this.repository.appendEvent({
      conversationId,
      eventType: "character.conversation.created",
      payload: { conversation: publicConversation(row, sessionState) },
    });
    const memoryStatus = this.sessionMemoryClient.enabled()
      ? await this.sessionMemoryClient
          .status(this.memoryScope(row))
          .catch(() => null)
      : null;
    const warnings = [...creationWarnings];
    if (
      request.memory.mode === "persistent" &&
      memoryStatus?.character_memory?.mode !== "persistent"
    )
      warnings.push({
        code: "character_memory_ephemeral",
        message:
          "A stable owner and character_instance_id are required for cross-session character memory; this session remains ephemeral.",
      });
    return {
      ...publicConversation(row, sessionState),
      context_ref: contextRef,
      character_memory: memoryStatus?.character_memory || null,
      warnings,
    };
  }

  async retrieve(conversationId, athena, options = {}) {
    const row = await this.authorize(conversationId, athena, options);
    const state = await this.repository.readSessionState(row);
    let contextRef = null;
    let characterMemory = null;
    if (this.sessionMemoryClient.enabled()) {
      const status = await this.sessionMemoryClient.status(
        this.memoryScope(row)
      );
      contextRef = status?.context_ref || null;
      characterMemory = status?.character_memory || null;
    }
    return {
      ...publicConversation(row, state),
      context_ref: contextRef,
      character_memory: characterMemory,
    };
  }

  contextTemplate() {
    return {
      stableInstructions: characterV2Instructions(this.profile, {
        conversation: true,
      }),
      contextPrefix: characterV2ContextPrefix(),
    };
  }

  contextFromMemory(memory, conversation, sessionState) {
    const durableWindow =
      memory?.memory_point?.performance_state?.state_window || null;
    const sessionWindow = sessionState.persistent_state_window || null;
    const persistentStateWindow =
      Number(sessionWindow?.current_state?.revision || 0) >
      Number(durableWindow?.current_state?.revision || 0)
        ? sessionWindow
        : durableWindow || sessionWindow;
    return {
      conversation_id: conversation.id,
      long_term_character_memory:
        memory?.memory_point?.long_term_character_memory || null,
      dialogue_memory: {
        checkpoint: memory?.memory_point?.dialogue?.checkpoint || null,
        turns: memory?.memory_point?.dialogue?.turns || [],
      },
      performance_state_memory: {
        conversation_status: conversation.status,
        previous_activity: conversation.previousActivity,
        character_state: sessionState.character_state,
        persistent_state_window: persistentStateWindow,
        memory_revision: Number(
          memory?.memory_revision ?? memory?.current_ref?.memory_revision ?? 0
        ),
        state_revision: Number(
          memory?.state_revision ??
            memory?.current_ref?.state_revision ??
            sessionState.character_state.revision
        ),
        checkpoint_revision: Number(
          memory?.checkpoint_revision ??
            memory?.current_ref?.checkpoint_revision ??
            0
        ),
        projected_context_tokens: Number(memory?.projected_context_tokens || 0),
      },
    };
  }

  async hydrateReplay(turnRow, athena) {
    const conversation = await this.authorize(turnRow.conversationId, athena);
    const sessionState = await this.repository.readSessionState(conversation);
    const checkpoint = turnRow.responseId
      ? await this.responsesRepository.readCheckpoint(turnRow.responseId)
      : null;
    return {
      conversation: publicConversation(conversation, sessionState),
      turn: publicTurn(turnRow),
      response: checkpoint?.state?.character_response || null,
      performance_resolution: checkpoint?.state?.resolution || null,
      performance_plan: checkpoint?.state?.performance_plan || null,
      ...(turnRow.control || {}),
      character_state: sessionState.character_state,
      persistent_state_window: sessionState.persistent_state_window || null,
      memory_status: turnRow.memoryStatus,
      context: {
        mode: "replay",
        previous_ref: turnRow.previousContextRef || null,
        current_ref: turnRow.contextRef || turnRow.previousContextRef || null,
        advance_status: "replayed",
        gateway_cache: {
          slot_hit: turnRow.gatewaySlotHit === true,
          rebuild_reason: turnRow.contextRebuildReason || null,
        },
        provider_cache: {
          hit_tokens: Number(turnRow.providerCacheHitTokens || 0),
          miss_tokens: Number(turnRow.providerCacheMissTokens || 0),
          hit_rate: Number(turnRow.providerCacheHitRate || 0),
        },
      },
      warnings: turnRow.control?.warnings || [],
      replay: true,
    };
  }

  async contextFor(conversation, sessionState, contextRef, contextRefPresent) {
    if (this.sessionMemoryClient.enabled()) {
      const memory = await this.sessionMemoryClient.contextPrepare({
        ...this.memoryScope(conversation),
        ...(contextRefPresent ? { contextRef } : {}),
      });
      if (memory?.hard_gate)
        throw conversationError("character_memory_compaction_catching_up", 503);
      return {
        promptContext: this.contextFromMemory(
          memory,
          conversation,
          sessionState
        ),
        preparation: memory,
      };
    }
    const turns = await this.repository.recentTurns(conversation.id, 12);
    const recentTurns = [];
    for (const turn of turns) {
      const checkpoint = turn.responseId
        ? await this.responsesRepository.readCheckpoint(turn.responseId)
        : null;
      recentTurns.push({
        ordinal: turn.ordinal,
        user_input: turn.input,
        character_speech: speechText(checkpoint?.state?.character_response),
        handoff: turn.control?.effective_handoff || null,
        conversation_horizon: turn.control?.conversation_horizon || null,
      });
    }
    return {
      promptContext: {
        conversation_id: conversation.id,
        dialogue_memory: {
          checkpoint: null,
          turns: recentTurns,
        },
        performance_state_memory: {
          conversation_status: conversation.status,
          previous_activity: conversation.previousActivity,
          character_state: sessionState.character_state,
          persistent_state_window: sessionState.persistent_state_window,
          memory_revision: 0,
          state_revision: sessionState.character_state.revision,
          projected_context_tokens: 0,
        },
      },
      preparation: null,
    };
  }

  async completeIncrementalContext({
    conversation,
    sessionState,
    contextState,
    completionInput,
  }) {
    const template = {
      stableInstructions: completionInput.stableInstructions,
      contextPrefix: completionInput.contextPrefix,
    };
    let promptContext = contextState.promptContext;
    let preparation = contextState.preparation;
    let slotHit = !preparation?.memory_point;
    let rebuildReason = preparation?.rebuild_reason || null;
    if (preparation?.memory_point) {
      await this.gatewayContextClient.install({
        sessionId: conversation.id,
        contextRef: preparation.current_ref,
        memoryPoint: promptContext,
        template,
        status: conversation.status,
      });
      slotHit = false;
    }
    const complete = () =>
      this.gatewayContextClient.complete({
        contextRef: preparation.current_ref,
        input: completionInput.input,
        completion: {
          provider: completionInput.provider,
          model: completionInput.model,
          response_format: completionInput.responseFormat,
          temperature: completionInput.temperature,
          max_output_tokens: completionInput.maxOutputTokens,
        },
        template,
      });
    let completed;
    try {
      completed = await complete();
    } catch (error) {
      if (
        ![
          "athena_3d_context_slot_miss",
          "athena_3d_context_template_changed",
        ].includes(error?.code)
      )
        throw error;
      const full = await this.sessionMemoryClient.contextResolve(
        this.memoryScope(conversation)
      );
      preparation = {
        ...full,
        mode: "resynced",
        rebuild_reason:
          error.code === "athena_3d_context_template_changed"
            ? "template_changed"
            : "gateway_slot_miss",
        current_ref: full.current_ref,
      };
      rebuildReason = preparation.rebuild_reason;
      slotHit = false;
      promptContext = this.contextFromMemory(full, conversation, sessionState);
      await this.gatewayContextClient.install({
        sessionId: conversation.id,
        contextRef: preparation.current_ref,
        memoryPoint: promptContext,
        template,
        status: conversation.status,
      });
      completed = await complete();
    }
    contextState.promptContext = promptContext;
    contextState.preparation = preparation;
    contextState.evidence = {
      mode: preparation?.mode || "incremental",
      previous_ref: preparation?.current_ref || null,
      gateway_cache: { slot_hit: slotHit, rebuild_reason: rebuildReason },
    };
    return completed.result;
  }

  async persistCharacterResponse({
    conversation,
    turn,
    record,
    input,
    performancePlan = null,
    memoryCommit = null,
  }) {
    const response = record.response;
    await this.responsesRepository.createResponse({
      id: response.id,
      conversationId: conversation.id,
      previousResponseId: conversation.currentHeadResponseId,
      chatRunId: null,
      agentRunId: conversation.agentRunId,
      ownerUserId: conversation.ownerUserId,
      idempotencyKey: null,
      taskPriority: "P0",
      taskIntent: "character_conversation_turn",
      provider: "deepseek",
      model: record.model || "deepseek-v4-flash",
      requestedProtocol: "character_responses_v2",
      effectiveProtocol: record.effectiveProtocol,
      status: response.status,
      background: false,
      store: true,
      storageMode: PLAINTEXT_JSON_STORAGE,
      inputHash: sha256(input),
      usageJson: JSON.stringify(response.usage || {}),
      resultSha256: sha256(response),
      completedAt: new Date(this.now()),
      expiresAt: new Date(this.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await Promise.all([
      ...response.output.map((item, index) =>
        this.responsesRepository.appendItem({
          responseId: response.id,
          sequence: index,
          itemType: item.type,
          status: item.status,
          payload: item,
          storageMode: PLAINTEXT_JSON_STORAGE,
        })
      ),
      ...record.events.map((event) =>
        this.responsesRepository.appendEvent({
          responseId: response.id,
          sequence: event.sequence_number,
          eventType: event.type,
          payload: event,
          storageMode: PLAINTEXT_JSON_STORAGE,
        })
      ),
      this.responsesRepository.writeCheckpoint(
        response.id,
        {
          character_response: response,
          resolution: record.resolution,
          execution: record.execution,
          performance_plan: performancePlan,
          input,
          turn_id: turn.id,
          output: response.output,
          outputText: speechText(response),
          usage: response.usage,
          memory_commit: memoryCommit,
        },
        { storageMode: PLAINTEXT_JSON_STORAGE }
      ),
    ]);
  }

  memoryScope(conversation) {
    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      threadId: conversation.threadId,
      ownerUserId: conversation.ownerUserId,
      agentRunId: conversation.agentRunId,
    };
  }

  async cleanupSessionMemory(
    conversation,
    {
      turnId = null,
      responseId = null,
      reason,
      replay = false,
      immediate = false,
    }
  ) {
    if (!this.sessionMemoryClient.enabled()) return { deleted: false };
    try {
      const status = await this.sessionMemoryClient.status(
        this.memoryScope(conversation)
      );
      let longTermArchive = null;
      if (status?.character_memory?.mode === "persistent") {
        longTermArchive = await this.sessionMemoryClient.archiveLongTerm({
          ...this.memoryScope(conversation),
          contextRef: status.context_ref,
          reason,
        });
        if (!longTermArchive?.archived)
          throw conversationError(
            "character_long_term_memory_archive_failed",
            503
          );
      }
      const result = await this.sessionMemoryClient.deleteSession(
        this.memoryScope(conversation)
      );
      if (!longTermArchive)
        try {
          await this.gatewayContextClient.invalidate({
            session_id: conversation.id,
          });
        } catch {}
      try {
        await this.repository.appendEvent({
          conversationId: conversation.id,
          turnId,
          responseId,
          eventType: "character.session_memory.deleted",
          payload: {
            reason,
            replay,
            immediate,
            content_retained: Boolean(longTermArchive),
            long_term_memory_session_id:
              longTermArchive?.memory_session_id || null,
            delete_replay: result?.replay === true,
          },
        });
      } catch {}
      return {
        deleted: true,
        replay: result?.replay === true,
        long_term_archive: longTermArchive,
      };
    } catch (error) {
      try {
        await this.repository.appendEvent({
          conversationId: conversation.id,
          turnId,
          responseId,
          eventType: "character.session_memory.delete_pending",
          payload: {
            reason,
            replay,
            immediate,
            retryable: true,
            error: {
              code:
                error?.code ||
                error?.message ||
                "athena_3d_memory_delete_failed",
            },
          },
        });
      } catch {}
      return {
        deleted: false,
        warning: {
          code: "character_session_memory_delete_pending",
          message:
            "The conversation is terminal, but deletion of its 3D session memory is pending and can be retried idempotently.",
        },
      };
    }
  }

  async reconcilePendingMemory(conversation) {
    if (!this.sessionMemoryClient.enabled()) return null;
    const pending = await this.repository.pendingMemoryTurn(conversation.id);
    if (!pending) return null;
    const checkpoint = pending.responseId
      ? await this.responsesRepository.readCheckpoint(pending.responseId)
      : null;
    const commit = checkpoint?.state?.memory_commit;
    if (!commit)
      throw conversationError(
        "character_memory_reconciliation_unavailable",
        503
      );
    try {
      const result = await this.sessionMemoryClient.commitTurn(commit);
      const completed = await this.repository.markMemoryCommitted(
        pending.id,
        result
      );
      try {
        await this.gatewayContextClient.invalidate({
          session_id: conversation.id,
        });
      } catch {}
      await this.repository.appendEvent({
        conversationId: conversation.id,
        turnId: pending.id,
        responseId: pending.responseId,
        eventType: "character.turn.memory_committed",
        payload: { memory: result, reconciled: true },
      });
      await this.repository.appendEvent({
        conversationId: conversation.id,
        turnId: pending.id,
        responseId: pending.responseId,
        eventType: "character.turn.completed",
        payload: { turn: publicTurn(completed), reconciled: true },
      });
      if (conversation.status === "ended") {
        await this.cleanupSessionMemory(conversation, {
          turnId: pending.id,
          responseId: pending.responseId,
          reason: "conversation_ended",
        });
      }
      return result;
    } catch (error) {
      throw conversationError("character_memory_commit_pending", 503, {
        cause: error.code || error.message,
        turn_id: pending.id,
      });
    }
  }

  async appendResponseEvents(conversationId, turnId, record) {
    for (const event of record.events) {
      await this.repository.appendEvent({
        conversationId,
        turnId,
        responseId: record.response.id,
        eventType: event.type,
        payload: {
          response_sequence_number: event.sequence_number,
          event: { ...event, sequence_number: undefined },
        },
      });
    }
    for (const event of record.execution.events || []) {
      await this.repository.appendEvent({
        conversationId,
        turnId,
        responseId: record.response.id,
        eventType: event.type,
        payload: {
          response_sequence_number: event.sequence_number,
          event: { ...event, sequence_number: undefined },
        },
      });
    }
  }

  async turn(conversationId, body = {}, { forceEnd = false } = {}) {
    const request = validateTurnInput(body);
    const replayRow = await this.repository.findTurnByIdempotencyKey(
      request.idempotencyKey
    );
    if (replayRow) {
      const hydrated = await this.repository.hydrateTurn(replayRow);
      if (hydrated.conversationId !== conversationId)
        throw conversationError("character_turn_idempotency_conflict", 409);
      if (hydrated.status === "memory_pending") {
        const replayConversation = await this.authorize(
          conversationId,
          request.athena
        );
        await this.reconcilePendingMemory(replayConversation);
        return this.hydrateReplay(
          await this.repository.hydrateTurn(
            await this.repository.findTurnByIdempotencyKey(
              request.idempotencyKey
            )
          ),
          request.athena
        );
      }
      return this.hydrateReplay(hydrated, request.athena);
    }
    let conversation = await this.authorize(conversationId, request.athena);
    if (["ended", "cancelled", "failed"].includes(conversation.status))
      throw conversationError("character_conversation_terminal", 409);
    if (conversation.status === "suspended")
      throw conversationError("character_conversation_suspended", 409);
    await this.reconcilePendingMemory(conversation);
    conversation = await this.repository.findConversation(conversationId);
    const sessionState = await this.repository.readSessionState(conversation);
    const contextState = await this.contextFor(
      conversation,
      sessionState,
      request.contextRef,
      request.contextRefPresent
    );
    const context = contextState.promptContext;
    const turnId = id("chr_turn");
    const claimed = await this.repository.claimTurn(conversation, turnId);
    if (!claimed) throw conversationError("character_turn_already_active", 409);
    if (conversation.status === "soft_closed")
      await this.repository.appendEvent({
        conversationId,
        turnId,
        eventType: "character.conversation.resuming",
        payload: { reason: "user_input" },
      });
    if (
      this.sessionMemoryClient.enabled() &&
      Number(context.performance_state_memory?.memory_revision || 0) === 0 &&
      context.long_term_character_memory?.profile_ref &&
      !context.long_term_character_memory?.recall?.frozen
    ) {
      await this.sessionMemoryClient.freezeLongTermRecall({
        ...this.memoryScope(conversation),
        input: userInputText(request.input),
      });
      const frozen = await this.sessionMemoryClient.contextResolve(
        this.memoryScope(conversation)
      );
      contextState.preparation = {
        ...frozen,
        mode: "resynced",
        rebuild_reason: "cursor_stale",
        current_ref: frozen.current_ref,
      };
      contextState.promptContext = this.contextFromMemory(
        frozen,
        conversation,
        sessionState
      );
    }
    conversation = await this.repository.findConversation(conversationId);
    const ordinal = await this.repository.nextOrdinal(conversationId);
    const turn = await this.repository.createTurn(
      {
        id: turnId,
        conversationId,
        ordinal,
        previousTurnId: sessionState.character_state.source_turn_id,
        idempotencyKey: request.idempotencyKey,
        status: "active",
        expectedStateRevision: conversation.stateRevision,
        expectedMemoryRevision: Number(
          context.performance_state_memory?.memory_revision || 0
        ),
        memoryStatus: this.sessionMemoryClient.enabled()
          ? "preparing"
          : "not_required",
        previousContextJson: contextState.preparation?.current_ref
          ? JSON.stringify(contextState.preparation.current_ref)
          : null,
        contextMode: contextState.preparation?.mode || null,
      },
      request.input
    );
    this.active.set(conversationId, { turnId, cancelled: false });
    await this.repository.appendEvent({
      conversationId,
      turnId,
      eventType: "character.turn.created",
      payload: { turn: publicTurn(turn) },
    });
    await this.repository.appendEvent({
      conversationId,
      turnId,
      eventType: "character.turn.input.received",
      payload: { input: request.input },
    });
    await this.repository.appendEvent({
      conversationId,
      turnId,
      eventType: "character.turn.response.started",
      payload: {},
    });
    try {
      const characterRequest = {
        protocol_version: "2.0",
        character: sessionState.character,
        conversation: {
          id: conversation.id,
          previous_response_id: conversation.currentHeadResponseId,
        },
        input: request.input,
        generation: sessionState.generation,
        metadata: sessionState.metadata,
      };
      const generated = await this.adapter.generate(characterRequest, {
        ...(this.sessionMemoryClient.enabled()
          ? {
              contextCompletion: (completionInput) =>
                this.completeIncrementalContext({
                  conversation,
                  sessionState,
                  contextState,
                  completionInput,
                }),
            }
          : { conversationContext: context }),
      });
      const effectiveContext = contextState.promptContext;
      if (this.active.get(conversationId)?.cancelled)
        throw conversationError("character_turn_interrupted", 409);
      const record = materializeCharacterV2Record({
        generated,
        profile: this.profile,
        performanceClient: this.performanceClient,
      });
      const performancePlan = await this.performanceDeploymentClient.compile({
        sessionId: sessionState.metadata?.performance_session_id,
        conversationId,
        record,
        scope: scopeFromAthena(request.athena),
      });
      const control = normalizeConversationControl(record.payload, {
        currentState: sessionState.character_state,
        response: record.response,
        forceEnd,
      });
      const cacheEvidence = providerCacheEvidence(generated.providerCache);
      if (
        contextState.evidence?.gateway_cache?.rebuild_reason ||
        contextState.evidence?.mode === "resynced"
      )
        control.warnings.push({
          code: "athena_3d_context_resynced",
          message:
            "The supplied incremental context was rebuilt from durable 3D Session Memory before generation.",
          details: {
            rebuild_reason:
              contextState.evidence?.gateway_cache?.rebuild_reason || null,
          },
        });
      const nextCharacterState = materializeNextState(
        control.state_transition,
        sessionState.character_state,
        turnId
      );
      if (control.outcome === "close_ready")
        nextCharacterState.performance_state = "close_ready";
      if (control.outcome === "ended")
        nextCharacterState.performance_state = "closing";
      const persistentStateWindow = materializePersistentStateWindow({
        previousState:
          effectiveContext.performance_state_memory?.persistent_state_window
            ?.current_state ||
          sessionState.persistent_state_window?.current_state ||
          initialPersistentState(sessionState.character_state),
        transition: record.payload.persistent_state_transition,
        turnId,
        responseId: record.response.id,
        sequenceId: record.response.output?.[1]?.id || null,
        now: this.now(),
      });
      const nextSessionState = {
        ...sessionState,
        character_state: nextCharacterState,
        persistent_state_window: persistentStateWindow,
      };
      const memoryCommitPayload = this.sessionMemoryClient.enabled()
        ? {
            ...this.memoryScope(conversation),
            turnId,
            ordinal,
            responseId: record.response.id,
            expectedMemoryRevision: Number(
              effectiveContext.performance_state_memory?.memory_revision || 0
            ),
            expectedStateRevision: Number(
              effectiveContext.performance_state_memory?.state_revision || 0
            ),
            previousContextRef:
              contextState.preparation?.current_ref ||
              request.contextRef ||
              null,
            user: userInputText(request.input),
            assistant: speechText(record.response),
            stateWindow: persistentStateWindow,
            sessionStatus: control.outcome,
          }
        : null;
      await this.persistCharacterResponse({
        conversation,
        turn,
        record,
        input: request.input,
        performancePlan,
        memoryCommit: memoryCommitPayload,
      });
      await this.appendResponseEvents(conversationId, turnId, record);
      await this.repository.appendEvent({
        conversationId,
        turnId,
        responseId: record.response.id,
        eventType: "character.turn.response.completed",
        payload: { response: record.response },
      });
      const now = this.now();
      const status = control.outcome;
      const softCloseDueAt =
        status === "close_ready"
          ? new Date(now + control.soft_close_timing.effective_wait_ms)
          : null;
      if (status === "ended") {
        await this.repository.updateConversation(conversationId, {
          status: "closing",
          softCloseDueAt: null,
        });
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.conversation.closing",
          payload: { reason: control.end_intent.kind },
        });
      }
      const updated = await this.repository.updateSessionState(
        conversation,
        nextSessionState,
        {
          status,
          currentTurnId: null,
          softCloseDueAt,
          endedAt: status === "ended" ? new Date(now) : null,
        }
      );
      if (!updated) throw conversationError("character_state_conflict", 409);
      await this.repository.updateConversation(conversationId, {
        currentHeadResponseId: record.response.id,
      });
      let memoryCommit = null;
      let memoryCommitError = null;
      let gatewayCommitWarning = null;
      if (memoryCommitPayload) {
        try {
          memoryCommit =
            await this.sessionMemoryClient.commitTurn(memoryCommitPayload);
        } catch (error) {
          memoryCommitError = error;
        }
      }
      if (memoryCommit && !memoryCommitError) {
        try {
          await this.gatewayContextClient.commit({
            session_id: conversationId,
            previous_context_ref:
              contextState.evidence?.previous_ref ||
              contextState.preparation?.current_ref ||
              null,
            context_ref: memoryCommit.context_ref,
            dialogue_turn: {
              turn_id: turnId,
              ordinal,
              response_id: record.response.id,
              user: userInputText(request.input),
              assistant: speechText(record.response),
            },
            performance_state_memory: {
              conversation_status: status,
              previous_activity: conversation.previousActivity,
              character_state: nextCharacterState,
              persistent_state_window: persistentStateWindow,
              memory_revision: Number(memoryCommit.memory_revision || 0),
              state_revision: Number(memoryCommit.state_revision || 0),
              checkpoint_revision: Number(
                memoryCommit.checkpoint_revision || 0
              ),
              projected_context_tokens: Number(
                memoryCommit.projected_context_tokens || 0
              ),
            },
            status,
            retain_for_long_term: sessionState.memory?.mode === "persistent",
          });
        } catch {
          gatewayCommitWarning = {
            code: "athena_3d_context_gateway_commit_failed",
            message:
              "Durable memory committed, but the disposable Gateway slot was not advanced; the next response will rebuild it.",
          };
        }
      }
      const currentContextRef = memoryCommitError
        ? contextState.evidence?.previous_ref ||
          contextState.preparation?.current_ref ||
          null
        : memoryCommit?.context_ref ||
          contextState.evidence?.previous_ref ||
          null;
      const responseContext = {
        mode: contextState.evidence?.mode || "incremental",
        previous_ref: request.contextRefPresent
          ? request.contextRef
          : contextState.preparation?.current_ref || null,
        current_ref: currentContextRef,
        advance_status: memoryCommitError
          ? "memory_pending"
          : memoryCommit?.replay
            ? "replayed"
            : "committed",
        gateway_cache: contextState.evidence?.gateway_cache || {
          slot_hit: false,
          rebuild_reason: null,
        },
        provider_cache: cacheEvidence,
        generation_contract: {
          provider: generated.model === "deepseek-v4-flash" ? "deepseek" : null,
          model: generated.model,
          response_format: { type: "json_object" },
          raw_output_type: "json_object",
          selection_retries: 0,
        },
      };
      const completionData = {
        responseId: record.response.id,
        modelWaitMs: Number.isInteger(control.soft_close_timing.model_wait_ms)
          ? control.soft_close_timing.model_wait_ms
          : null,
        effectiveWaitMs: control.soft_close_timing.effective_wait_ms,
        timingSource: control.soft_close_timing.source,
        endReason: status === "ended" ? control.end_intent.kind : null,
        contextJson: currentContextRef
          ? JSON.stringify(currentContextRef)
          : null,
        contextMode: responseContext.mode,
        gatewaySlotHit: responseContext.gateway_cache.slot_hit,
        contextRebuildReason:
          responseContext.gateway_cache.rebuild_reason || null,
        providerCacheHitTokens: cacheEvidence.hit_tokens,
        providerCacheMissTokens: cacheEvidence.miss_tokens,
        providerCacheHitRate: cacheEvidence.hit_rate,
      };
      const completedTurn = memoryCommitError
        ? await this.repository.markMemoryPending(
            turnId,
            completionData,
            control,
            memoryCommitError.code || memoryCommitError.message
          )
        : await this.repository.completeTurn(
            turnId,
            {
              ...completionData,
              status: "completed",
              memoryStatus: memoryCommitPayload ? "committed" : "not_required",
            },
            control
          );
      if (memoryCommitError)
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.turn.memory_pending",
          payload: {
            retryable: true,
            error: {
              code:
                memoryCommitError.code ||
                memoryCommitError.message ||
                "athena_3d_memory_commit_failed",
            },
          },
        });
      else if (memoryCommitPayload)
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.turn.memory_committed",
          payload: { memory: memoryCommit, reconciled: false },
        });
      if (control.effective_handoff)
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.turn.handoff",
          payload: {
            model_handoff: control.model_handoff,
            effective_handoff: control.effective_handoff,
            conversation_horizon: control.conversation_horizon,
          },
        });
      if (status === "close_ready")
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.conversation.close_ready",
          payload: {
            conversation_horizon: control.conversation_horizon,
            soft_close_timing: control.soft_close_timing,
            soft_close_due_at: softCloseDueAt.getTime(),
          },
        });
      else if (status === "ended") {
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.conversation.ended",
          payload: { reason: control.end_intent.kind },
        });
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.activity.resume.requested",
          payload: { activity: conversation.previousActivity },
        });
      } else
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.conversation.awaiting_user",
          payload: { handoff: control.effective_handoff },
        });
      if (!memoryCommitError)
        await this.repository.appendEvent({
          conversationId,
          turnId,
          responseId: record.response.id,
          eventType: "character.turn.completed",
          payload: { turn: publicTurn(completedTurn) },
        });
      const finalConversation =
        await this.repository.findConversation(conversationId);
      let memoryCleanup = null;
      if (
        status === "ended" &&
        !memoryCommitError &&
        this.sessionMemoryClient.enabled()
      ) {
        memoryCleanup = await this.cleanupSessionMemory(finalConversation, {
          turnId,
          responseId: record.response.id,
          reason: "conversation_ended",
        });
      }
      return {
        conversation: publicConversation(finalConversation, nextSessionState),
        turn: publicTurn(completedTurn),
        response: record.response,
        performance_resolution: record.resolution,
        performance_plan: performancePlan,
        conversation_horizon: control.conversation_horizon,
        model_handoff: control.model_handoff,
        effective_handoff: control.effective_handoff,
        soft_close_timing: control.soft_close_timing,
        character_state: nextCharacterState,
        persistent_state_window: persistentStateWindow,
        memory_status: completedTurn.memoryStatus,
        memory_commit: memoryCommit,
        context: responseContext,
        warnings: [
          ...record.response.warnings,
          ...control.warnings,
          ...(memoryCommitError
            ? [
                {
                  code: "character_memory_commit_pending",
                  message:
                    "The response was generated, but the durable 3D session memory commit is pending. The next turn is gated until reconciliation succeeds.",
                },
              ]
            : []),
          ...(memoryCleanup?.warning ? [memoryCleanup.warning] : []),
          ...(gatewayCommitWarning ? [gatewayCommitWarning] : []),
        ],
      };
    } catch (error) {
      await this.repository.failTurn(
        turnId,
        error.code || error.message || "character_turn_failed"
      );
      const latest = await this.repository.findConversation(conversationId);
      if (latest?.status === "active")
        await this.repository.updateConversation(conversationId, {
          status: "awaiting_user",
          currentTurnId: null,
        });
      await this.repository.appendEvent({
        conversationId,
        turnId,
        eventType: "character.turn.failed",
        payload: { error: { code: error.code || error.message } },
      });
      throw error;
    } finally {
      this.active.delete(conversationId);
    }
  }

  async events(conversationId, after, athena, options = {}) {
    await this.authorize(conversationId, athena, options);
    return this.repository.listEvents(conversationId, after);
  }

  async suspend(conversationId, body = {}) {
    const row = await this.authorize(conversationId, body.athena || {});
    if (["ended", "cancelled", "failed"].includes(row.status))
      throw conversationError("character_conversation_terminal", 409);
    const active = this.active.get(conversationId);
    if (active) active.cancelled = true;
    const reason = String(body.reason || "interaction_interrupted");
    const updated = await this.repository.updateConversation(conversationId, {
      status: "suspended",
      currentTurnId: null,
      softCloseDueAt: null,
      suspensionReason: reason,
      suspendedAt: new Date(this.now()),
    });
    await this.repository.appendEvent({
      conversationId,
      eventType: "character.conversation.suspended",
      payload: { reason },
    });
    try {
      await this.gatewayContextClient.invalidate({
        session_id: conversationId,
      });
    } catch {}
    return publicConversation(updated);
  }

  async resume(conversationId, body = {}) {
    const row = await this.authorize(conversationId, body.athena || {});
    if (row.status !== "suspended")
      throw conversationError("character_conversation_not_suspended", 409);
    await this.repository.updateConversation(conversationId, {
      status: "resuming",
      suspensionReason: null,
      suspendedAt: null,
    });
    await this.repository.appendEvent({
      conversationId,
      eventType: "character.conversation.resuming",
      payload: { reason: "explicit_resume" },
    });
    const updated = await this.repository.updateConversation(conversationId, {
      status: "awaiting_user",
    });
    await this.repository.appendEvent({
      conversationId,
      eventType: "character.conversation.resumed",
      payload: {},
    });
    return publicConversation(updated);
  }

  async end(conversationId, body = {}) {
    const row = await this.authorize(conversationId, body.athena || {});
    if (["ended", "cancelled"].includes(row.status)) {
      await this.cleanupSessionMemory(row, {
        reason: row.status,
        replay: true,
      });
      return publicConversation(row);
    }
    if (body.immediate === true) {
      const active = this.active.get(conversationId);
      if (active) active.cancelled = true;
      const updated = await this.repository.updateConversation(conversationId, {
        status: "ended",
        currentTurnId: null,
        softCloseDueAt: null,
        endedAt: new Date(this.now()),
      });
      await this.repository.appendEvent({
        conversationId,
        eventType: "character.conversation.ended",
        payload: { reason: "user_action", immediate: true },
      });
      await this.cleanupSessionMemory(updated, {
        reason: "user_action",
        immediate: true,
      });
      return publicConversation(updated);
    }
    return this.turn(
      conversationId,
      {
        input: [
          {
            id: id("chr_input"),
            type: "user_message",
            content: [
              {
                type: "input_text",
                text: "用户通过界面明确结束了当前对话。请用角色口吻做一句自然、简短的告别。",
              },
            ],
          },
        ],
        idempotency_key:
          body.idempotency_key || `end:${conversationId}:${this.now()}`,
        athena: body.athena || {},
      },
      { forceEnd: true }
    );
  }

  async maintain({ now = new Date(this.now()), limit = 25 } = {}) {
    const pendingMemory = this.sessionMemoryClient.enabled()
      ? await this.repository.pendingMemoryTurns(limit)
      : [];
    const memoryReconciled = [];
    const memoryPending = [];
    for (const turn of pendingMemory) {
      const conversation = await this.repository.findConversation(
        turn.conversationId
      );
      if (!conversation) continue;
      try {
        await this.reconcilePendingMemory(conversation);
        memoryReconciled.push(turn.id);
      } catch {
        memoryPending.push(turn.id);
      }
    }
    const due = await this.repository.dueSoftCloses(now, limit);
    const closed = [];
    for (const row of due) {
      const claimed = await this.client.responses_conversations.updateMany({
        where: {
          id: row.id,
          status: "close_ready",
          softCloseDueAt: row.softCloseDueAt,
        },
        data: { status: "soft_closing", softCloseDueAt: null },
      });
      if (claimed.count !== 1) continue;
      await this.repository.appendEvent({
        conversationId: row.id,
        eventType: "character.conversation.soft_closing",
        payload: {},
      });
      const latest = await this.repository.findConversation(row.id);
      const sessionState = await this.repository.readSessionState(latest);
      const ambientState = {
        ...sessionState.character_state,
        revision: sessionState.character_state.revision + 1,
        attention: { target: "none", intensity: 0.1 },
        activity: {
          current: row.previousActivity || "ambient_idle",
          previous: "conversation",
        },
        performance_state: "ambient",
        decay: { mode: "to_ambient", target: "soft_neutral", duration_ms: 0 },
        updated_at: this.now(),
      };
      const previousPersistent =
        sessionState.persistent_state_window?.current_state ||
        initialPersistentState(sessionState.character_state);
      const ambientPersistentNext = {
        ...previousPersistent,
        attention: { target: "none", intensity: 0.1 },
        activity: {
          current: row.previousActivity || "ambient_idle",
          previous: "conversation",
        },
        performance_state: "ambient",
        decay: {
          mode: "to_ambient",
          target: "soft_neutral",
          duration_ms: 0,
        },
      };
      const ambientPersistentWindow = materializePersistentStateWindow({
        previousState: previousPersistent,
        transition: {
          from_revision: previousPersistent.revision,
          style: "blend",
          duration_ms: 0,
          next_state: ambientPersistentNext,
        },
        turnId: `ambient:${row.id}`,
        responseId: null,
        sequenceId: null,
        now: this.now(),
      });
      const nextState = {
        ...sessionState,
        character_state: ambientState,
        persistent_state_window: ambientPersistentWindow,
      };
      const updated = await this.repository.updateSessionState(
        latest,
        nextState,
        { status: "soft_closed", currentTurnId: null }
      );
      if (!updated) continue;
      await this.repository.appendEvent({
        conversationId: row.id,
        eventType: "character.conversation.soft_closed",
        payload: { recoverable: true },
      });
      let retainedForLongTerm = false;
      if (this.sessionMemoryClient.enabled()) {
        try {
          const memory = await this.sessionMemoryClient.status(
            this.memoryScope(row)
          );
          if (memory?.character_memory?.mode === "persistent") {
            const archived = await this.sessionMemoryClient.archiveLongTerm({
              ...this.memoryScope(row),
              contextRef: memory.context_ref,
              reason: "soft_closed",
            });
            retainedForLongTerm = archived?.archived === true;
          }
        } catch (error) {
          await this.repository.appendEvent({
            conversationId: row.id,
            eventType: "character.long_term_memory.archive_pending",
            payload: {
              retryable: true,
              error: error.code || error.message,
            },
          });
        }
      }
      if (!retainedForLongTerm)
        try {
          await this.gatewayContextClient.invalidate({ session_id: row.id });
        } catch {}
      await this.repository.appendEvent({
        conversationId: row.id,
        eventType: "character.activity.ambient.requested",
        payload: { activity: row.previousActivity || "ambient_idle" },
      });
      closed.push(row.id);
    }
    return {
      inspected: due.length,
      softClosed: closed.length,
      conversationIds: closed,
      memoryReconciled: memoryReconciled.length,
      memoryPending: memoryPending.length,
      memoryReconciledTurnIds: memoryReconciled,
      memoryPendingTurnIds: memoryPending,
    };
  }
}

module.exports = {
  CharacterConversationRuntime,
  publicConversation,
  publicTurn,
  scopeFromAthena,
};
