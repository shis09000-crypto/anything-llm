const crypto = require("crypto");
const {
  baseResponse,
  commonPrefixLength,
  conversationId,
  normalizeUsage,
  responseId,
  sha256,
  validateCreateRequest,
} = require("./contract");
const { ResponsesRepository, mapConcurrent } = require("./repository");
const ModelClient = require("./modelClient");
const { DurableEventBatcher } = require("./eventBatcher");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { requestInternalService } = require("../microModules");
const {
  stripCurrentDateTimePromptBlock,
} = require("../chats/currentDateTimeContext");

function stateInputWithoutDynamicTime(input = []) {
  return input.map((item) => {
    if (
      item?.type === "message" &&
      item?.role === "user" &&
      typeof item.content === "string"
    ) {
      return {
        ...item,
        content: stripCurrentDateTimePromptBlock(item.content),
      };
    }
    return item;
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function emitRuntimeEvent(
  eventType,
  response,
  metadata = {},
  outcome = "success"
) {
  try {
    emitSemanticEvent({
      eventId: crypto.randomUUID(),
      eventType,
      category: "responses_runtime",
      severity: outcome === "success" ? "info" : "warning",
      outcome,
      subject: {
        type: "response",
        id: sha256(response.id).slice(0, 24),
        component: "responses-runtime",
        operation: eventType,
      },
      impact: { scope: "deepseek-v4-flash", status: response.status },
      metadata,
      sensitivity: "metadata_only",
    });
  } catch {
    // Observability is never allowed to alter Response state.
  }
}

function runtimeError(code, status = 500) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  return error;
}

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
  const chatRunId =
    String(athena.chatRunId || athena.clientTurnId || "").trim() || null;
  const agentRunId =
    String(athena.agentRunId || athena.invocationId || "").trim() || null;
  let scopeKey;
  if (workspaceId !== null && threadId !== null)
    scopeKey = `thread:${workspaceId}:${threadId}`;
  else if (agentRunId) scopeKey = `agent:${agentRunId}`;
  else if (chatRunId) scopeKey = `chat:${chatRunId}`;
  else throw runtimeError("response_scope_required", 400);
  return {
    workspaceId,
    threadId,
    ownerUserId,
    chatRunId,
    agentRunId,
    scopeKey,
  };
}

function outputFromProvider(result = {}) {
  const output = Array.isArray(result.output) ? result.output : [];
  const outputText = String(result.output_text || "");
  return { output, outputText };
}

const RETRYABLE_EMPTY_STREAM_ERRORS = new Set([
  "responses_stream_failed",
  "model_responses_stream_failed",
  "INTERNAL_SERVICE_FAILED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

function isNativeWebSearchTool(tool = {}) {
  return ["web_search", "web_search_2025_08_26"].includes(tool?.type);
}

function retryableEmptyStreamError(error) {
  return RETRYABLE_EMPTY_STREAM_ERRORS.has(
    String(error?.code || error?.message || "")
  );
}

function withoutNativeWebSearch(request = {}) {
  const tools = (request.tools || []).filter(
    (tool) => !isNativeWebSearchTool(tool)
  );
  const fallbackInstruction =
    "The provider's native web search is temporarily unavailable. Continue using reliable model knowledge, clearly state that live web results could not be verified, and do not invent current facts or citations.";
  return {
    ...request,
    instructions: [request.instructions, fallbackInstruction]
      .filter(Boolean)
      .join("\n\n"),
    tools,
    toolChoice: tools.length ? "auto" : "none",
  };
}

class ResponsesRuntime {
  constructor({
    repository = new ResponsesRepository(),
    modelClient = ModelClient,
  } = {}) {
    this.repository = repository;
    this.modelClient = modelClient;
    this.accepting = true;
    this.active = new Map();
    this.completed = 0;
    this.failed = 0;
    this.pruned = 0;
    this.persistedEventBatches = 0;
    this.persistedEventCount = 0;
    this.hotResponses = new Map();
    this.hotConversationHeads = new Map();
    this.persistenceChains = new Map();
    this.hotResponseBytes = 0;
    this.maxHotResponses = positiveInteger(
      process.env.ATHENA_HOT_TURN_MAX_TURNS,
      64
    );
    this.maxHotResponseBytes = positiveInteger(
      process.env.ATHENA_HOT_TURN_MAX_BYTES,
      64 * 1024 * 1024
    );
  }

  snapshot() {
    return {
      ready: this.accepting,
      accepting: this.accepting,
      activeResponses: this.active.size,
      completedResponses: this.completed,
      failedResponses: this.failed,
      prunedResponses: this.pruned,
      persistedEventBatches: this.persistedEventBatches,
      persistedEventCount: this.persistedEventCount,
      hotResponses: this.hotResponses.size,
      hotResponseBytes: this.hotResponseBytes,
      pendingPersistenceQueues: this.persistenceChains.size,
      ...(this.repository.snapshot?.() || {}),
    };
  }

  async resolveConversation(request, scope) {
    if (!request.store) return null;
    if (request.conversation) {
      const existing = await this.repository.findConversation(
        request.conversation
      );
      if (!existing || existing.deletedAt)
        throw runtimeError("conversation_not_found", 404);
      if (existing.scopeKey !== scope.scopeKey)
        throw runtimeError("conversation_not_found", 404);
      return existing;
    }
    return this.repository.ensureConversation({
      id: conversationId(),
      scopeKey: scope.scopeKey,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      agentRunId: scope.threadId === null ? scope.agentRunId : null,
      ownerUserId: scope.ownerUserId,
    });
  }

  async authorizeConversation(id, athena, { privileged = false } = {}) {
    const conversation = await this.repository.findConversation(id);
    if (!conversation || conversation.deletedAt)
      throw runtimeError("conversation_not_found", 404);
    if (privileged) return conversation;
    const scope = scopeFromAthena(athena || {});
    if (
      conversation.scopeKey !== scope.scopeKey ||
      (conversation.ownerUserId !== null &&
        conversation.ownerUserId !== scope.ownerUserId)
    )
      throw runtimeError("conversation_not_found", 404);
    return conversation;
  }

  async authorizeResponse(id, athena, { privileged = false } = {}) {
    const row = await this.repository.findResponse(id);
    if (!row) throw runtimeError("response_not_found", 404);
    if (privileged) return row;
    const scope = scopeFromAthena(athena || {});
    if (row.conversationId) {
      const conversation = await this.authorizeConversation(
        row.conversationId,
        athena
      );
      if (conversation.id !== row.conversationId)
        throw runtimeError("response_not_found", 404);
    } else if (
      row.ownerUserId !== scope.ownerUserId ||
      (row.agentRunId && row.agentRunId !== scope.agentRunId) ||
      (row.chatRunId && row.chatRunId !== scope.chatRunId)
    ) {
      throw runtimeError("response_not_found", 404);
    }
    return row;
  }

  async resolveParent(request, conversation) {
    if (!request.store || !conversation)
      return { parent: null, previousInput: [] };
    const parentId =
      request.previousResponseId ||
      this.hotConversationHeads.get(conversation.id) ||
      conversation.currentHeadResponseId;
    if (!parentId) return { parent: null, previousInput: [] };
    const hotParent = this.hotResponses.get(parentId) || null;
    const parent =
      hotParent?.row || (await this.repository.findResponse(parentId));
    if (!parent || parent.conversationId !== conversation.id || !parent.store)
      throw runtimeError("previous_response_mismatch", 409);
    const checkpoint =
      hotParent?.checkpoint ||
      (await this.repository.readCheckpoint(parent.id));
    return { parent, previousInput: checkpoint?.state?.input || [] };
  }

  deferredForeground(request) {
    return (
      request.store &&
      !request.background &&
      request.persistenceMode === "foreground_deferred"
    );
  }

  releaseHotResponse(id) {
    const hot = this.hotResponses.get(id);
    if (!hot) return false;
    this.hotResponses.delete(id);
    this.hotResponseBytes = Math.max(
      0,
      this.hotResponseBytes - Number(hot.bytes || 0)
    );
    if (hot.expiryTimer) clearTimeout(hot.expiryTimer);
    hot.response = null;
    hot.checkpoint = null;
    return true;
  }

  enqueuePersistence(conversationIdValue, operation) {
    const key = String(conversationIdValue || "unscoped");
    const previous = this.persistenceChains.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.persistenceChains.set(key, current);
    current.finally(() => {
      if (this.persistenceChains.get(key) === current)
        this.persistenceChains.delete(key);
    });
    return current;
  }

  async create(body = {}) {
    if (!this.accepting)
      throw runtimeError("responses_runtime_unavailable", 503);
    const request = validateCreateRequest(body);
    const scope = scopeFromAthena(request.athena);
    const conversation = await this.resolveConversation(request, scope);
    const idempotencyKey =
      String(request.athena.idempotencyKey || "").trim() || null;
    const replay =
      await this.repository.findResponseByIdempotencyKey(idempotencyKey);
    if (replay) {
      if (
        replay.ownerUserId !== scope.ownerUserId ||
        replay.conversationId !== (conversation?.id || null)
      )
        throw runtimeError("response_not_found", 404);
      return {
        request,
        scope,
        conversation,
        response: await this.hydrateResponse(replay),
        replay: true,
      };
    }
    let { parent, previousInput } = await this.resolveParent(
      request,
      conversation
    );
    const explicitStateReference = Boolean(
      request.previousResponseId || request.conversation
    );
    let effectiveInput = request.input;
    let prefixLength = commonPrefixLength(previousInput, effectiveInput);
    let historyChanged =
      !explicitStateReference &&
      previousInput.length > 0 &&
      prefixLength < previousInput.length;
    if (explicitStateReference && parent) {
      effectiveInput = [...previousInput, ...request.input];
      prefixLength = previousInput.length;
      historyChanged = false;
    } else if (historyChanged && conversation) {
      const ancestor = await this.repository.findNearestInputAncestor(
        conversation.id,
        effectiveInput
      );
      if (ancestor) {
        parent = await this.repository.findResponse(ancestor.responseId);
        previousInput = ancestor.input;
        prefixLength = ancestor.input.length;
      } else {
        parent = null;
        previousInput = [];
        prefixLength = 0;
      }
    }
    const previousResponseId = parent?.id || null;
    const executionRequest = { ...request, input: effectiveInput };
    const stateInput = stateInputWithoutDynamicTime(effectiveInput);
    const id = responseId();
    const now = new Date();
    const response = baseResponse({
      id,
      conversation: conversation?.id || null,
      previousResponseId,
      background: request.background,
      model: request.model,
      chatRunId: scope.chatRunId,
      agentRunId: scope.agentRunId,
    });
    await this.repository.createResponse({
      id,
      conversationId: conversation?.id || null,
      previousResponseId,
      chatRunId: scope.chatRunId,
      agentRunId: scope.agentRunId,
      ownerUserId: scope.ownerUserId,
      idempotencyKey,
      taskPriority: ["P0", "P1", "P2", "P3", "P4"].includes(
        request.athena.taskPriority
      )
        ? request.athena.taskPriority
        : request.background
          ? "P2"
          : "P0",
      taskIntent: String(request.athena.taskIntent || "").trim() || null,
      provider: request.provider,
      model: request.model,
      requestedProtocol: "responses",
      status: request.background ? "queued" : "in_progress",
      background: request.background,
      store: request.store,
      inputHash: sha256(stateInput),
      branchReason: historyChanged ? "history_diverged" : null,
      expiresAt: request.store
        ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
        : now,
    });
    const hotBytes = Buffer.byteLength(JSON.stringify(stateInput), "utf8");
    const deferredForeground =
      this.deferredForeground(request) &&
      this.hotResponses.size < this.maxHotResponses &&
      hotBytes <= this.maxHotResponseBytes &&
      this.hotResponseBytes + hotBytes <= this.maxHotResponseBytes;
    const checkpointState = {
      input: stateInput,
      instructions: request.instructions,
      tools: request.tools,
      reasoning: request.reasoning,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      inputPrefixLength: prefixLength,
      historyChanged,
    };
    if (request.store && !deferredForeground) {
      const suffix = stateInput.slice(prefixLength);
      const initialPersistence = [
        mapConcurrent(suffix, 4, (item, sequence) =>
          this.repository.appendItem({
            responseId: id,
            sequence,
            itemType: item.type || "message",
            role: item.role || null,
            callId: item.call_id || item.tool_call_id || null,
            status: "completed",
            payload: item,
          })
        ),
        this.repository.writeCheckpoint(id, checkpointState),
        this.persistEvent(id, 0, "response.created", { response }),
      ];
      if (!request.background) {
        response.status = "in_progress";
        initialPersistence.push(
          this.persistEvent(id, 1, "response.in_progress", { response })
        );
      }
      await Promise.all(initialPersistence);
    } else if (!request.background) {
      response.status = "in_progress";
    }
    if (deferredForeground) {
      const hot = {
        row: {
          id,
          conversationId: conversation?.id || null,
          previousResponseId,
          chatRunId: scope.chatRunId,
          agentRunId: scope.agentRunId,
          ownerUserId: scope.ownerUserId,
          model: request.model,
          background: false,
          store: true,
          status: "in_progress",
        },
        response,
        checkpoint: { state: checkpointState },
        bytes: hotBytes,
        expiryTimer: null,
      };
      hot.expiryTimer = setTimeout(
        () => {
          this.releaseHotResponse(id);
          if (this.hotConversationHeads.get(conversation?.id) === id)
            this.hotConversationHeads.delete(conversation.id);
        },
        10 * 60 * 1000
      );
      hot.expiryTimer.unref?.();
      this.hotResponses.set(id, hot);
      this.hotResponseBytes += hotBytes;
    }
    return {
      request: executionRequest,
      scope,
      conversation,
      response,
      persistence: {
        deferredForeground,
        prefixLength,
        checkpointState,
        stateInput,
      },
    };
  }

  async persistEvent(responseIdValue, sequence, eventType, payload) {
    return this.repository.appendEvent({
      responseId: responseIdValue,
      sequence,
      eventType,
      payload: { type: eventType, sequence_number: sequence, ...payload },
    });
  }

  async complete(body = {}) {
    const created = await this.create(body);
    if (created.replay) return created.response;
    if (created.request.background) return created.response;
    return this.executeComplete(created);
  }

  async executeComplete(created) {
    const { request, conversation, response } = created;
    this.active.set(response.id, { cancelled: false, abort: null });
    try {
      const result = await this.modelClient.complete(request);
      const current = this.active.get(response.id);
      if (current?.cancelled) throw runtimeError("response_cancelled", 409);
      const finalized = await this.finalize({
        response,
        request,
        conversation,
        result,
      });
      this.completed += 1;
      return finalized;
    } catch (error) {
      await this.fail(response, request, error);
      this.failed += 1;
      throw error;
    } finally {
      this.active.delete(response.id);
    }
  }

  async executeQueued(responseIdValue) {
    const row = await this.repository.findResponse(responseIdValue);
    if (!row) throw runtimeError("response_not_found", 404);
    if (row.cancelRequestedAt)
      return this.cancel(responseIdValue, null, { privileged: true });
    if (row.status !== "queued")
      return this.retrieve(responseIdValue, null, { privileged: true });
    const checkpoint = await this.repository.readCheckpoint(row.id);
    if (!checkpoint?.state) throw runtimeError("response_state_conflict", 409);
    const conversation = row.conversationId
      ? await this.repository.findConversation(row.conversationId)
      : null;
    const request = {
      provider: row.provider,
      model: row.model,
      input: checkpoint.state.input,
      instructions: checkpoint.state.instructions,
      tools: checkpoint.state.tools || [],
      reasoning: checkpoint.state.reasoning || {},
      temperature: checkpoint.state.temperature,
      maxOutputTokens: checkpoint.state.maxOutputTokens,
      store: row.store,
      background: true,
    };
    await this.repository.updateResponse(row.id, { status: "in_progress" });
    const response = await this.hydrateResponse(row);
    response.status = "in_progress";
    await this.persistEvent(
      row.id,
      await this.nextSequence(row.id),
      "response.in_progress",
      { response }
    );
    return this.executeComplete({ request, conversation, response });
  }

  async *stream(body = {}) {
    const runtimeStartedAt = Date.now();
    const batchesAtStart = this.persistedEventBatches;
    const custodyAtStart = this.repository.snapshot?.() || {};
    const created = await this.create({ ...body, background: false });
    const preprocessingMs = Date.now() - runtimeStartedAt;
    const { request, conversation, response } = created;
    const deferredForeground = created.persistence?.deferredForeground === true;
    if (created.replay) {
      const events = response.conversation
        ? await this.repository.listEvents(response.id, -1)
        : [];
      for (const event of events) yield event.payload;
      return;
    }
    this.active.set(response.id, { cancelled: false, abort: null });
    let sequence = request.store && !deferredForeground ? 2 : 0;
    const deferredEvents = [];
    if (request.store && !deferredForeground) {
      const initial = await this.repository.listEvents(response.id, -1);
      for (const event of initial) yield event.payload;
    } else {
      const createdEvent = {
        type: "response.created",
        sequence_number: sequence++,
        response,
      };
      const inProgressEvent = {
        type: "response.in_progress",
        sequence_number: sequence++,
        response,
      };
      if (deferredForeground)
        deferredEvents.push(createdEvent, inProgressEvent);
      yield createdEvent;
      yield inProgressEvent;
    }
    const collectedOutput = [];
    let outputText = "";
    let usage = {};
    let protocol = "responses";
    let degradedReason = null;
    let providerStatus = "completed";
    let providerStartedAt = null;
    let providerFirstEventAt = null;
    let firstVisibleDeltaAt = null;
    let providerProjectionMs = null;
    let rawStream = null;
    const eventBatcher =
      request.store && !deferredForeground
        ? new DurableEventBatcher({
            responseId: response.id,
            persist: (batch) => this.repository.appendEventBatch(batch),
            observe: ({ eventCount }) => {
              this.persistedEventBatches += 1;
              this.persistedEventCount += eventCount;
            },
            onError: () => rawStream?.destroy?.(),
          })
        : null;
    const activeResponse = this.active.get(response.id);
    if (activeResponse) activeResponse.eventBatcher = eventBatcher;
    try {
      providerStartedAt = Date.now();
      let executionRequest = request;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let providerMaterialEventCount = 0;
        try {
          rawStream = await this.modelClient.stream(executionRequest);
          const active = this.active.get(response.id);
          if (active && typeof rawStream?.destroy === "function")
            active.abort = () => rawStream.destroy();
          for await (const providerEvent of this.modelClient.events(
            rawStream
          )) {
            const providerEventAt = Date.now();
            eventBatcher?.throwIfFailed();
            if (this.active.get(response.id)?.cancelled)
              throw runtimeError("response_cancelled", 409);
            if (
              ["response.created", "response.in_progress"].includes(
                providerEvent.type
              )
            )
              continue;
            providerFirstEventAt ||= providerEventAt;
            const event = {
              ...providerEvent,
              sequence_number: sequence,
              response_id: response.id,
            };
            if (providerEvent.type === "response.output_text.delta")
              outputText += providerEvent.delta || "";
            if (
              providerEvent.type === "response.output_text.delta" &&
              providerEvent.delta &&
              firstVisibleDeltaAt === null
            ) {
              firstVisibleDeltaAt = Date.now();
              providerProjectionMs = firstVisibleDeltaAt - providerEventAt;
            }
            if (
              providerEvent.type === "response.output_item.done" &&
              providerEvent.item
            )
              collectedOutput.push(providerEvent.item);
            if (
              [
                "response.completed",
                "response.incomplete",
                "response.failed",
              ].includes(providerEvent.type)
            ) {
              usage =
                providerEvent.response?.usage || providerEvent.usage || usage;
              protocol =
                providerEvent.response?.effectiveProtocol ||
                providerEvent.athena?.effectiveProtocol ||
                protocol;
              degradedReason =
                providerEvent.response?.degradedReason ||
                providerEvent.athena?.degradedReason ||
                degradedReason;
              if (providerEvent.type === "response.failed") {
                const error = runtimeError(
                  providerEvent.response?.error?.code ||
                    providerEvent.error?.code ||
                    "provider_response_failed",
                  502
                );
                error.providerEvent = providerEvent;
                throw error;
              }
              providerStatus =
                providerEvent.type === "response.incomplete"
                  ? "incomplete"
                  : providerEvent.response?.status || "completed";
              if (providerEvent.response?.output_text && !outputText)
                outputText = providerEvent.response.output_text;
              continue;
            }
            providerMaterialEventCount += 1;
            if (request.store && !deferredForeground)
              eventBatcher.append(event, {
                boundary: [
                  "response.output_item.added",
                  "response.output_item.done",
                  "response.content_part.added",
                  "response.content_part.done",
                  "response.function_call_arguments.done",
                ].includes(event.type),
              });
            if (deferredForeground) deferredEvents.push(event);
            yield event;
            sequence += 1;
          }
          break;
        } catch (error) {
          const canRetry =
            providerMaterialEventCount === 0 &&
            retryableEmptyStreamError(error) &&
            attempt < 2;
          if (!canRetry) throw error;
          if (attempt === 1) {
            executionRequest = withoutNativeWebSearch(request);
            degradedReason = "native_web_search_temporarily_unavailable";
          }
        }
      }
      if (request.store && !deferredForeground) await eventBatcher.drain();
      const result = {
        output: collectedOutput,
        output_text: outputText,
        usage,
        effectiveProtocol: protocol,
        degradedReason,
        status: providerStatus,
        runtimeMetrics: {
          preprocessingMs,
          providerTtftMs:
            providerFirstEventAt === null || providerStartedAt === null
              ? null
              : providerFirstEventAt - providerStartedAt,
          firstVisibleDeltaMs:
            firstVisibleDeltaAt === null
              ? null
              : firstVisibleDeltaAt - runtimeStartedAt,
          providerProjectionMs,
          persistedEventBatches: this.persistedEventBatches - batchesAtStart,
          keyCustodyWrapCalls:
            (this.repository.snapshot?.().keyCustodyWrapCalls || 0) -
            (custodyAtStart.keyCustodyWrapCalls || 0),
        },
      };
      const finalized = deferredForeground
        ? this.buildFinalizedResponse(response, result)
        : await this.finalize({
            response,
            request,
            conversation,
            result,
            sequence,
          });
      if (deferredForeground) finalized.athena.persistenceStatus = "pending";
      const event = {
        type:
          finalized.status === "incomplete"
            ? "response.incomplete"
            : "response.completed",
        sequence_number: sequence,
        response: finalized,
      };
      if (request.store && !deferredForeground)
        await this.persistEvent(response.id, sequence, event.type, {
          response: finalized,
        });
      if (deferredForeground) deferredEvents.push(event);
      yield event;
      this.completed += 1;
      if (deferredForeground) {
        const hot = this.hotResponses.get(response.id);
        if (hot) {
          hot.response = finalized;
          hot.row.status = finalized.status;
          hot.checkpoint = {
            state: {
              ...(created.persistence?.checkpointState || {}),
              output: finalized.output,
              outputText: finalized.output_text,
              usage: finalized.usage,
            },
          };
        }
        if (conversation)
          this.hotConversationHeads.set(conversation.id, response.id);
        const persistOperation = async () => {
          let lastError = null;
          for (const delayMs of [
            0, 250, 1_000, 4_000, 15_000, 30_000, 60_000, 120_000, 240_000,
          ]) {
            if (delayMs)
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            try {
              await this.persistDeferredForeground({
                created,
                finalized,
                events: deferredEvents,
              });
              return;
            } catch (error) {
              lastError = error;
            }
          }
          throw lastError || runtimeError("response_persistence_failed", 503);
        };
        void this.enqueuePersistence(conversation?.id, persistOperation).catch(
          (error) =>
            emitRuntimeEvent(
              "response.persistence.failed",
              finalized,
              { errorCode: error?.code || error?.message },
              "failed"
            )
        );
      }
    } catch (error) {
      let persistenceError = null;
      if (request.store && eventBatcher) {
        try {
          await eventBatcher.drain();
        } catch (batchError) {
          persistenceError = batchError;
        }
      }
      const failureError = this.active.get(response.id)?.cancelled
        ? runtimeError("response_cancelled", 409)
        : persistenceError || error;
      const failed = await this.fail(response, request, failureError, null);
      yield {
        type:
          failed.status === "cancelled"
            ? "response.incomplete"
            : "response.failed",
        sequence_number: sequence,
        response: failed,
        error: {
          code: failureError.code || failureError.message,
        },
      };
      this.failed += 1;
      throw failureError;
    } finally {
      this.active.delete(response.id);
    }
  }

  buildFinalizedResponse(response, result = {}) {
    const { output, outputText } = outputFromProvider(result);
    const usage = normalizeUsage(result.usage || {});
    const finalized = {
      ...response,
      status: result.status === "incomplete" ? "incomplete" : "completed",
      output,
      output_text: outputText,
      usage,
      athena: {
        ...response.athena,
        effectiveProtocol: result.effectiveProtocol || "responses",
        degradedReason: result.degradedReason || null,
      },
    };
    finalized.athena.resultSha256 = sha256({
      output,
      output_text: outputText,
      usage,
    });
    return finalized;
  }

  async persistDeferredForeground({ created, finalized, events = [] } = {}) {
    const { conversation, response, persistence } = created;
    const suffix = persistence.stateInput.slice(persistence.prefixLength || 0);
    await Promise.all([
      mapConcurrent(suffix, 4, (item, sequence) =>
        this.repository.appendItem({
          responseId: response.id,
          sequence,
          itemType: item.type || "message",
          role: item.role || null,
          callId: item.call_id || item.tool_call_id || null,
          status: "completed",
          payload: item,
        })
      ),
      mapConcurrent(finalized.output, 4, (item, index) =>
        this.repository.appendItem({
          responseId: response.id,
          sequence: 10_000 + index,
          itemType: item.type || "message",
          role: item.role || null,
          callId: item.call_id || null,
          status: item.status || "completed",
          payload: item,
        })
      ),
      this.repository.writeCheckpoint(response.id, {
        ...(persistence.checkpointState || {}),
        output: finalized.output,
        outputText: finalized.output_text,
        usage: finalized.usage,
      }),
      this.repository.appendEventBatch({ responseId: response.id, events }),
    ]);
    await this.repository.updateResponse(response.id, {
      status: finalized.status,
      effectiveProtocol: finalized.athena.effectiveProtocol,
      degradedReason: finalized.athena.degradedReason,
      usageJson: JSON.stringify(finalized.usage),
      resultSha256: finalized.athena.resultSha256,
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (conversation)
      await this.repository.advanceConversationHead(
        conversation.id,
        response.id
      );
    this.releaseHotResponse(response.id);
    if (this.hotConversationHeads.get(conversation?.id) === response.id)
      this.hotConversationHeads.delete(conversation.id);
    emitRuntimeEvent("response.persistence.saved", finalized, {
      eventCount: events.length,
    });
  }

  async finalize({ response, request, conversation, result, sequence = null }) {
    const { output, outputText } = outputFromProvider(result);
    const usage = normalizeUsage(result.usage || {});
    let itemSequence = 10_000;
    if (request.store) {
      for (const item of output) {
        await this.repository.appendItem({
          responseId: response.id,
          sequence: itemSequence++,
          itemType: item.type || "message",
          role: item.role || null,
          callId: item.call_id || null,
          status: item.status || "completed",
          payload: item,
        });
      }
    }
    const finalized = {
      ...response,
      status: result.status === "incomplete" ? "incomplete" : "completed",
      output,
      output_text: outputText,
      usage,
      athena: {
        ...response.athena,
        effectiveProtocol: result.effectiveProtocol || "responses",
        degradedReason: result.degradedReason || null,
      },
    };
    finalized.athena.resultSha256 = sha256({
      output: finalized.output,
      output_text: finalized.output_text,
      usage: finalized.usage,
    });
    await this.repository.updateResponse(response.id, {
      status: finalized.status,
      effectiveProtocol: finalized.athena.effectiveProtocol,
      degradedReason: finalized.athena.degradedReason,
      usageJson: JSON.stringify(usage),
      resultSha256: finalized.athena.resultSha256,
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (request.store) {
      const checkpoint = await this.repository.readCheckpoint(response.id);
      await this.repository.writeCheckpoint(response.id, {
        ...(checkpoint?.state || {}),
        output,
        outputText,
        usage,
      });
      if (conversation)
        await this.repository.advanceConversationHead(
          conversation.id,
          response.id
        );
      if (sequence === null) {
        const next = await this.nextSequence(response.id);
        await this.persistEvent(response.id, next, "response.completed", {
          response: finalized,
        });
      }
    }
    emitRuntimeEvent(
      finalized.athena.degradedReason
        ? "response.protocol.degraded"
        : finalized.status === "incomplete"
          ? "response.state.incomplete"
          : "response.state.completed",
      finalized,
      {
        requestedProtocol: "responses",
        effectiveProtocol: finalized.athena.effectiveProtocol,
        degradedReason: finalized.athena.degradedReason,
        cachedTokens: usage.input_tokens_details.cached_tokens,
        cacheMissTokens: usage.input_tokens_details.cache_miss_tokens,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        preprocessingMs: result.runtimeMetrics?.preprocessingMs,
        providerTtftMs: result.runtimeMetrics?.providerTtftMs,
        firstVisibleDeltaMs: result.runtimeMetrics?.firstVisibleDeltaMs,
        providerProjectionMs: result.runtimeMetrics?.providerProjectionMs,
        persistedEventBatches: result.runtimeMetrics?.persistedEventBatches,
        keyCustodyWrapCalls: result.runtimeMetrics?.keyCustodyWrapCalls,
      }
    );
    return finalized;
  }

  async fail(response, request, error, sequence = null) {
    const cancelled = error?.code === "response_cancelled";
    const status = cancelled ? "cancelled" : "failed";
    const failed = { ...response, status };
    await this.repository.updateResponse(response.id, {
      status,
      errorCode: error?.code || error?.message || "response_failed",
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (request.store) {
      const next =
        sequence === null ? await this.nextSequence(response.id) : sequence;
      await this.persistEvent(
        response.id,
        next,
        cancelled ? "response.incomplete" : "response.failed",
        {
          response: failed,
          error: { code: error?.code || error?.message || "response_failed" },
        }
      );
    }
    emitRuntimeEvent(
      cancelled ? "response.state.cancelled" : "response.state.failed",
      failed,
      { errorCode: error?.code || error?.message || "response_failed" },
      cancelled ? "cancelled" : "failed"
    );
    return failed;
  }

  async nextSequence(id) {
    const events = await this.repository.listEvents(id, -1);
    return events.length
      ? Math.max(...events.map((event) => event.sequence)) + 1
      : 0;
  }

  async hydrateResponse(row) {
    if (!row) return null;
    const hot = this.hotResponses.get(row.id);
    if (hot?.response) return hot.response;
    const checkpoint = row.store
      ? await this.repository.readCheckpoint(row.id)
      : null;
    let usage = {};
    try {
      usage = JSON.parse(row.usageJson || "{}");
    } catch {
      usage = {};
    }
    const response = baseResponse({
      id: row.id,
      conversation: row.conversationId,
      previousResponseId: row.previousResponseId,
      status: row.status,
      background: row.background,
      model: row.model,
      chatRunId: row.chatRunId,
      agentRunId: row.agentRunId,
    });
    response.output = checkpoint?.state?.output || [];
    response.output_text = checkpoint?.state?.outputText || "";
    response.usage = normalizeUsage(usage);
    response.athena.effectiveProtocol = row.effectiveProtocol;
    response.athena.degradedReason = row.degradedReason;
    response.athena.resultSha256 = row.resultSha256 || "";
    return response;
  }

  async retrieve(id, athena, options = {}) {
    const row = await this.authorizeResponse(id, athena, options);
    return this.hydrateResponse(row);
  }

  async agentRunStatus(agentRunId) {
    const row =
      await this.repository.findLatestResponseByAgentRunId(agentRunId);
    if (!row) return null;
    return {
      responseId: row.id,
      agentRunId: row.agentRunId,
      status: row.status,
      completedAt: row.completedAt,
      errorCode: row.errorCode,
      resultSha256: row.resultSha256,
    };
  }

  async cancel(id, athena, options = {}) {
    const row = await this.authorizeResponse(id, athena, options);
    if (["completed", "failed", "cancelled", "incomplete"].includes(row.status))
      return this.hydrateResponse(row);
    await this.repository.requestCancel(id);
    const active = this.active.get(id);
    if (active) {
      active.cancelled = true;
      active.abort?.();
    }
    await this.repository.updateResponse(id, {
      status: "cancelled",
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const response = await this.hydrateResponse({
      ...row,
      status: "cancelled",
    });
    if (row.store)
      await this.persistEvent(
        id,
        await this.nextSequence(id),
        "response.incomplete",
        {
          response,
          error: { code: "response_cancelled" },
        }
      );
    return response;
  }

  async claimBackground(ownerId, leaseMs) {
    return this.repository.claimQueued({ ownerId, leaseMs });
  }

  async deleteResponse(id, athena) {
    await this.authorizeResponse(id, athena);
    const deleted = await this.repository.deleteResponse(id);
    if (!deleted) throw runtimeError("response_not_found", 404);
    return { id, deleted: true };
  }

  async createConversation(athena) {
    const scope = scopeFromAthena(athena);
    return this.repository.ensureConversation({
      id: conversationId(),
      scopeKey: scope.scopeKey,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      agentRunId: scope.agentRunId,
      ownerUserId: scope.ownerUserId,
    });
  }

  async retrieveConversation(id, athena, options = {}) {
    return this.authorizeConversation(id, athena, options);
  }

  async deleteConversation(id, athena) {
    await this.retrieveConversation(id, athena);
    await this.repository.deleteConversation(id);
    return { id, deleted: true };
  }

  async conversationItems(id, athena, options = {}) {
    await this.retrieveConversation(id, athena, options);
    const responses = await this.repository.client.responses.findMany({
      where: { conversationId: id, store: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const items = [];
    for (const response of responses)
      items.push(...(await this.repository.listItems(response.id)));
    return items.map(
      ({ payloadCiphertext: _payloadCiphertext, ...item }) => item
    );
  }

  async compact({
    conversationId: id,
    compactionItem = null,
    sourceCapsuleId = null,
    athena = null,
    privileged = false,
  } = {}) {
    const conversation = await this.retrieveConversation(id, athena, {
      privileged,
    });
    if (!conversation.currentHeadResponseId)
      throw runtimeError("response_compaction_unavailable", 409);
    let items = compactionItem;
    if (!items) {
      const responseItems = (
        await this.conversationItems(id, null, { privileged: true })
      ).map((item) => item.payload);
      let memoryContext = null;
      if (conversation.workspaceId !== null && conversation.threadId !== null) {
        const chatRuntimeUrl = String(
          process.env.ATHENA_CHAT_RUNTIME_URL ||
            process.env.ATHENA_CHAT_UPSTREAM ||
            ""
        ).replace(/\/+$/, "");
        if (!chatRuntimeUrl)
          throw runtimeError("response_compaction_unavailable", 503);
        const resolved = await requestInternalService({
          callerRole: "responses-runtime",
          targetModule: "chat-runtime",
          capability: "chat.memory.context.resolve",
          contractVersion: "1.0",
          url: `${chatRuntimeUrl}/internal/v1/chat/memory/context/resolve`,
          body: {
            workspaceId: conversation.workspaceId,
            threadId: conversation.threadId,
            userId: conversation.ownerUserId,
            messageLimit: 100,
          },
          timeoutMs: Number(
            process.env.ATHENA_THREAD_MEMORY_CONTEXT_TIMEOUT_MS || 15_000
          ),
        });
        memoryContext = resolved?.context || null;
        sourceCapsuleId ||= memoryContext?.compaction?.id || null;
      }
      items = {
        conversationCapsule: memoryContext?.compaction || null,
        recentHistory: memoryContext?.rawHistory || [],
        responseState: responseItems,
      };
    }
    const compactionId = `ath_comp_${crypto.randomUUID().replace(/-/g, "")}`;
    const row = await this.repository.createCompaction({
      id: compactionId,
      conversationId: id,
      throughResponseId: conversation.currentHeadResponseId,
      sourceCapsuleId,
      payload: {
        type: "compaction",
        conversation_id: id,
        through_response_id: conversation.currentHeadResponseId,
        item: items,
      },
    });
    return {
      id: row.id,
      object: "response.compaction",
      conversation_id: id,
      through_response_id: conversation.currentHeadResponseId,
      source_capsule_id: sourceCapsuleId,
    };
  }

  async maintain({ limit = 25 } = {}) {
    const conversationIds = await this.repository.expiredConversationIds({
      limit,
    });
    const results = [];
    for (const conversationIdValue of conversationIds) {
      try {
        const compaction = await this.compact({
          conversationId: conversationIdValue,
          privileged: true,
        });
        const pruned =
          await this.repository.pruneExpiredConversation(conversationIdValue);
        this.pruned += pruned.pruned;
        results.push({
          conversationId: conversationIdValue,
          compactionId: compaction.id,
          pruned: pruned.pruned,
        });
      } catch (error) {
        results.push({
          conversationId: conversationIdValue,
          pruned: 0,
          error:
            error?.code || error?.message || "response_compaction_unavailable",
        });
      }
    }
    return {
      taskPriority: "P4",
      inspected: conversationIds.length,
      pruned: results.reduce((sum, result) => sum + result.pruned, 0),
      results,
    };
  }

  async stop() {
    this.accepting = false;
    const drains = [];
    for (const active of this.active.values()) {
      active.cancelled = true;
      active.abort?.();
      if (active.eventBatcher) drains.push(active.eventBatcher.drain());
    }
    await Promise.allSettled(drains);
    await Promise.race([
      Promise.allSettled([...this.persistenceChains.values()]),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]);
    this.repository.clearCheckpointCache?.();
  }
}

module.exports = { ResponsesRuntime, runtimeError, scopeFromAthena };
