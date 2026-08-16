const { EventEmitter } = require("events");
const crypto = require("crypto");
const os = require("os");
const { DataAccessCenter } = require("../dataAccess");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const CHECKPOINT_INTERVAL_MS = 750;
const CHECKPOINT_BYTES = 1_024;
const PERSISTED_POLL_INTERVAL_MS = 750;
const EVENT_FLUSH_INTERVAL_MS = 100;
const EVENT_FLUSH_MAX = 32;
const LEASE_HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_DURATION_MS = 30_000;

function terminalStatus(status) {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

function responseClosed(response) {
  return response.destroyed || response.writableEnded;
}

function isResponsesEvent(payload = {}) {
  return /^(response\.|athena\.)/.test(String(payload?.type || ""));
}

function writeRunPayload(response, payload = {}) {
  if (!isResponsesEvent(payload)) return writeResponseChunk(response, payload);
  const sequence = Number(payload.sequence_number || payload.runRevision || 0);
  if (sequence > 0) response.write(`id: ${sequence}\n`);
  response.write(`event: ${payload.type}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitRunEvent(run, eventType, outcome, extra = {}) {
  const reasonCode = String(extra.errorCode || "").trim() || null;
  emitSemanticEvent({
    eventType,
    category: "chat",
    severity: outcome === "failed" ? "warning" : "info",
    outcome,
    subject: {
      type: "chat_stream",
      id: run.clientTurnId,
      component: "chat-stream-runtime",
    },
    actor: {
      type: run.userId ? "user" : "system",
      id: run.userId || "system",
    },
    correlation: { clientTurnId: run.clientTurnId },
    impact: {
      scope: "conversation-run",
      status: extra.status || outcome,
    },
    metadata: reasonCode ? { reasonCode } : {},
    sensitivity: "metadata_only",
  });
}

function parseSsePayloads(value = "") {
  return String(value)
    .split(/\n\n+/)
    .map((frame) =>
      frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
    )
    .filter(Boolean)
    .flatMap((data) => {
      try {
        return [JSON.parse(data)];
      } catch {
        return [];
      }
    });
}

class DetachedChatResponse extends EventEmitter {
  constructor(onPayload) {
    super();
    this.onPayload = onPayload;
    this.destroyed = false;
    this.writableEnded = false;
  }

  write(value) {
    if (this.writableEnded) return false;
    for (const payload of parseSsePayloads(value)) this.onPayload(payload);
    return true;
  }

  setHeader() {}
  flushHeaders() {}

  end() {
    this.writableEnded = true;
  }

  cancel() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

class ChatStreamRuntime {
  constructor(run, { ownerId = run.ownerId || null } = {}) {
    this.run = run;
    this.ownerId = ownerId;
    this.revision = Number(run.revision || 0);
    this.partialResponse = String(run.partialResponse || "");
    this.lastCheckpointLength = this.partialResponse.length;
    this.finalChatId = run.finalChatId || null;
    this.finalPublicChatId = run.finalPublicChatId || null;
    this.status = run.status || "running";
    this.errorCode = run.errorCode || null;
    this.cancelRequested = false;
    this.terminalEventType = null;
    this.responsesMode = false;
    this.subscribers = new Map();
    this.checkpointTimer = null;
    this.checkpointChain = Promise.resolve();
    this.eventBuffer = [];
    this.eventTimer = null;
    this.eventChain = Promise.resolve();
    this.heartbeatTimer = null;
    this.sink = new DetachedChatResponse((payload) =>
      this.acceptPayload(payload)
    );
  }

  scope() {
    return {
      id: this.run.id,
      clientTurnId: this.run.clientTurnId,
      workspaceId: this.run.workspaceId,
      threadId: this.run.threadId,
      userId: this.run.userId,
    };
  }

  acceptPayload(payload = {}) {
    if (terminalStatus(this.status)) return;
    if (isResponsesEvent(payload)) this.responsesMode = true;
    this.revision += 1;
    if (
      payload.type === "textResponseChunk" &&
      typeof payload.textResponse === "string"
    ) {
      this.partialResponse += payload.textResponse;
    } else if (
      payload.type === "fullTextResponse" &&
      typeof payload.textResponse === "string"
    ) {
      this.partialResponse = payload.textResponse;
    } else if (
      payload.type === "response.output_text.delta" &&
      typeof payload.delta === "string"
    ) {
      this.partialResponse += payload.delta;
    } else if (
      payload.type === "response.output_text.done" &&
      typeof payload.text === "string"
    ) {
      this.partialResponse = payload.text;
    }
    if (payload.type === "finalizeResponseStream") {
      this.finalChatId = payload.chatId || this.finalChatId;
      this.finalPublicChatId = payload.publicChatId || this.finalPublicChatId;
      this.terminalEventType = payload.type;
    }
    if (payload.type === "abort") {
      this.errorCode =
        payload.errorCode || payload.code || "chat_stream_aborted";
      this.terminalEventType = payload.type;
    }
    if (payload.type === "stopGeneration" && payload.close) {
      this.terminalEventType = payload.type;
    }
    if (payload.type === "response.completed") {
      this.finalChatId = payload.response?.metadata?.chatId || this.finalChatId;
      this.finalPublicChatId =
        payload.response?.metadata?.publicChatId || this.finalPublicChatId;
      this.terminalEventType = payload.type;
    }
    if (
      payload.type === "response.failed" ||
      payload.type === "response.incomplete"
    ) {
      this.errorCode =
        payload.response?.error?.code || payload.type.replace(".", "_");
      this.terminalEventType = payload.type;
    }

    const event = {
      ...payload,
      clientTurnId: payload.clientTurnId || this.run.clientTurnId,
      runRevision: this.revision,
      ...(isResponsesEvent(payload)
        ? { sequence_number: this.revision, response_id: this.run.id }
        : {}),
    };
    this.eventBuffer.push({
      sequence: this.revision,
      payload: event,
    });
    this.broadcast(event);
    this.scheduleEventFlush();
    this.scheduleCheckpoint();
  }

  scheduleEventFlush() {
    if (this.eventBuffer.length >= EVENT_FLUSH_MAX) {
      this.flushEvents();
      return;
    }
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null;
      this.flushEvents();
    }, EVENT_FLUSH_INTERVAL_MS);
    this.eventTimer.unref?.();
  }

  flushEvents() {
    if (this.eventTimer) {
      clearTimeout(this.eventTimer);
      this.eventTimer = null;
    }
    const events = this.eventBuffer.splice(0);
    if (!events.length) return this.eventChain;
    this.eventChain = this.eventChain
      .then(() =>
        DataAccessCenter.chatStreamRun.appendEvents({
          ...this.scope(),
          events,
        })
      )
      .catch((error) =>
        console.warn("[ChatStreamRun] event journal failed", {
          clientTurnId: this.run.clientTurnId,
          code: error?.code || error?.message,
        })
      );
    return this.eventChain;
  }

  startHeartbeat() {
    if (!this.ownerId || this.heartbeatTimer) return;
    const heartbeat = () =>
      DataAccessCenter.chatStreamRun
        .renewLease({
          ...this.scope(),
          ownerId: this.ownerId,
          leaseMs: LEASE_DURATION_MS,
        })
        .catch((error) =>
          console.warn("[ChatStreamRun] lease heartbeat failed", {
            clientTurnId: this.run.clientTurnId,
            code: error?.code || error?.message,
          })
        );
    this.heartbeatTimer = setInterval(heartbeat, LEASE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    void heartbeat();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  broadcast(payload) {
    for (const [response, subscriber] of this.subscribers.entries()) {
      if (responseClosed(response)) {
        this.detach(response);
        continue;
      }
      try {
        writeRunPayload(response, payload);
      } catch {
        this.detach(response);
      }
      subscriber.lastRevision = Number(payload.runRevision || this.revision);
    }
  }

  scheduleCheckpoint() {
    const grewBy = this.partialResponse.length - this.lastCheckpointLength;
    if (grewBy >= CHECKPOINT_BYTES) {
      this.flushCheckpoint();
      return;
    }
    if (this.checkpointTimer) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      this.flushCheckpoint();
    }, CHECKPOINT_INTERVAL_MS);
    this.checkpointTimer.unref?.();
  }

  flushCheckpoint() {
    if (this.checkpointTimer) {
      clearTimeout(this.checkpointTimer);
      this.checkpointTimer = null;
    }
    const snapshot = {
      ...this.scope(),
      revision: this.revision,
      partialResponse: this.partialResponse,
    };
    this.lastCheckpointLength = snapshot.partialResponse.length;
    this.checkpointChain = this.checkpointChain
      .then(() => DataAccessCenter.chatStreamRun.checkpoint(snapshot))
      .catch((error) =>
        console.warn("[ChatStreamRun] checkpoint failed", {
          clientTurnId: this.run.clientTurnId,
          code: error?.code || error?.message,
        })
      );
    return this.checkpointChain;
  }

  attach(response, afterRevision = 0) {
    const normalizedAfter = Math.max(Number(afterRevision) || 0, 0);
    if (normalizedAfter > 0) {
      emitRunEvent(this.run, "chat.run.replayed", "recovered", {
        status: this.status,
      });
    }
    if (this.partialResponse && normalizedAfter < this.revision) {
      writeRunPayload(
        response,
        this.responsesMode
          ? {
              type: "response.output_text.delta",
              response_id: this.run.id,
              delta: this.partialResponse,
              replayed: normalizedAfter > 0,
              clientTurnId: this.run.clientTurnId,
              runRevision: this.revision,
              sequence_number: this.revision,
            }
          : {
              id: this.run.id,
              type: "fullTextResponse",
              textResponse: this.partialResponse,
              close: false,
              replayed: normalizedAfter > 0,
              clientTurnId: this.run.clientTurnId,
              runRevision: this.revision,
            }
      );
    }
    if (terminalStatus(this.status)) {
      if (!this.terminalEventType) this.writeTerminal(response);
      response.end();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const onClose = () => this.detach(response);
      response.once("close", onClose);
      this.subscribers.set(response, {
        resolve,
        onClose,
        lastRevision: Math.max(normalizedAfter, this.revision),
      });
    });
  }

  detach(response) {
    const subscriber = this.subscribers.get(response);
    if (!subscriber) return;
    response.off?.("close", subscriber.onClose);
    this.subscribers.delete(response);
    subscriber.resolve();
  }

  writeTerminal(response) {
    const terminalSequence =
      Number(this.run.revision || this.revision || 0) + 1;
    if (this.responsesMode && this.status === "completed" && this.run?.id) {
      writeRunPayload(response, {
        type: "response.completed",
        response_id: this.run.id,
        sequence_number: terminalSequence,
        response: {
          id: this.run.id,
          object: "response",
          status: "completed",
          completed_at: Math.floor(Date.now() / 1000),
          error: null,
          incomplete_details: null,
          output: [],
          metadata: {
            chatId: this.finalChatId,
            publicChatId: this.finalPublicChatId,
            clientTurnId: this.run.clientTurnId,
          },
        },
      });
      return;
    }
    if (
      this.responsesMode &&
      (this.status === "failed" || this.status === "interrupted") &&
      this.run?.id
    ) {
      writeRunPayload(response, {
        type: "response.failed",
        response_id: this.run.id,
        sequence_number: terminalSequence,
        response: {
          id: this.run.id,
          object: "response",
          status: "failed",
          error: {
            code: this.errorCode || `responses_turn_${this.status}`,
            message:
              this.status === "interrupted"
                ? "Responses turn was interrupted by a server restart."
                : "Responses turn failed.",
          },
        },
      });
      return;
    }
    if (this.responsesMode && this.status === "cancelled" && this.run?.id) {
      writeRunPayload(response, {
        type: "response.incomplete",
        response_id: this.run.id,
        sequence_number: terminalSequence,
        response: {
          id: this.run.id,
          object: "response",
          status: "incomplete",
          incomplete_details: { reason: "cancelled" },
        },
      });
      return;
    }
    if (this.status === "failed" || this.status === "interrupted") {
      writeResponseChunk(response, {
        id: this.run.id,
        type: "abort",
        close: true,
        error:
          this.status === "interrupted"
            ? "Chat generation was interrupted by a server restart."
            : "Chat generation failed.",
        errorCode: this.errorCode || `chat_stream_${this.status}`,
        clientTurnId: this.run.clientTurnId,
        runRevision: this.revision,
      });
      return;
    }
    if (this.status === "cancelled") {
      writeResponseChunk(response, {
        id: this.run.id,
        type: "stopGeneration",
        close: true,
        clientTurnId: this.run.clientTurnId,
        runRevision: this.revision,
      });
      return;
    }
    writeResponseChunk(response, {
      id: this.run.id,
      type: "finalizeResponseStream",
      close: true,
      chatId: this.finalChatId,
      publicChatId: this.finalPublicChatId,
      clientTurnId: this.run.clientTurnId,
      runRevision: this.revision,
      replayed: true,
    });
  }

  async settle(status, errorCode = null) {
    if (terminalStatus(this.status)) return;
    this.status = status;
    this.errorCode = errorCode;
    this.stopHeartbeat();
    await this.flushEvents();
    await this.eventChain;
    await this.flushCheckpoint();
    await this.checkpointChain;
    await DataAccessCenter.chatStreamRun.settle({
      ...this.scope(),
      status,
      revision: this.revision,
      partialResponse: this.partialResponse,
      finalChatId: this.finalChatId,
      finalPublicChatId: this.finalPublicChatId,
      errorCode,
    });
    emitRunEvent(
      this.run,
      `chat.run.${status}`,
      status === "completed" ? "succeeded" : "failed",
      { status, errorCode: this.errorCode }
    );

    for (const response of [...this.subscribers.keys()]) {
      if (!responseClosed(response)) {
        if (!this.terminalEventType) this.writeTerminal(response);
        response.end();
      }
      this.detach(response);
    }
    this.sink.end();
  }

  cancel() {
    if (terminalStatus(this.status) || this.cancelRequested) return false;
    this.cancelRequested = true;
    if (this.responsesMode) {
      this.acceptPayload({
        type: "response.incomplete",
        response_id: this.run.id,
        response: {
          id: this.run.id,
          object: "response",
          status: "incomplete",
          incomplete_details: { reason: "cancelled" },
        },
      });
    } else {
      this.broadcast({
        id: this.run.id,
        type: "stopGeneration",
        close: false,
        clientTurnId: this.run.clientTurnId,
        runRevision: this.revision,
      });
    }
    this.sink.cancel();
    return true;
  }
}

class ChatStreamRunManager {
  constructor() {
    this.runtimes = new Map();
    this.ownerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
    this.accepting = true;
  }

  runtime(clientTurnId) {
    return this.runtimes.get(String(clientTurnId || "").trim()) || null;
  }

  async claim(scope) {
    if (!this.accepting) {
      const error = new Error("chat_runtime_draining");
      error.code = "chat_runtime_draining";
      error.httpStatus = 503;
      throw error;
    }
    return DataAccessCenter.chatStreamRun.claim({
      ...scope,
      ownerId: this.ownerId,
      leaseMs: LEASE_DURATION_MS,
    });
  }

  async state(scope) {
    let run = await DataAccessCenter.chatStreamRun.getScoped(scope);
    if (
      run?.status === "running" &&
      (!run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= Date.now())
    )
      run = await DataAccessCenter.chatStreamRun.reconcileExpired(scope);
    if (!run) return null;
    return {
      kind: "chat",
      responseId: run.id,
      clientTurnId: run.clientTurnId,
      status: run.status,
      revision: Number(run.revision || 0),
      terminal: terminalStatus(run.status),
      retryable: !terminalStatus(run.status),
      finalChatId: run.finalChatId || null,
      finalPublicChatId: run.finalPublicChatId || null,
      errorCode: run.errorCode || null,
      startedAt: run.startedAt || null,
      completedAt: run.completedAt || null,
      lastUpdatedAt: run.lastUpdatedAt || null,
    };
  }

  start(run, execute) {
    const existing = this.runtime(run.clientTurnId);
    if (existing) return existing;
    const runtime = new ChatStreamRuntime(run, { ownerId: this.ownerId });
    this.runtimes.set(run.clientTurnId, runtime);
    runtime.startHeartbeat();
    emitRunEvent(run, "chat.run.started", "started", { status: "running" });
    Promise.resolve()
      .then(() => execute(runtime.sink))
      .then(() =>
        runtime.settle(
          runtime.cancelRequested
            ? "cancelled"
            : runtime.errorCode
              ? "failed"
              : "completed",
          runtime.errorCode
        )
      )
      .catch(async (error) => {
        if (!runtime.terminalEventType) {
          runtime.acceptPayload(
            runtime.responsesMode
              ? {
                  type: "response.failed",
                  response_id: run.id,
                  response: {
                    id: run.id,
                    object: "response",
                    status: "failed",
                    error: {
                      code: error?.code || "responses_turn_failed",
                      message: error?.message || "Responses turn failed.",
                    },
                  },
                }
              : {
                  id: run.id,
                  type: "abort",
                  close: true,
                  error: error?.message || "Chat generation failed.",
                  errorCode: error?.code || "chat_stream_failed",
                }
          );
        }
        await runtime.settle("failed", error?.code || "chat_stream_failed");
      })
      .finally(() => {
        setTimeout(
          () => this.runtimes.delete(run.clientTurnId),
          30_000
        ).unref?.();
      });
    return runtime;
  }

  async attach(response, scope, afterRevision = 0) {
    const runtime = this.runtime(scope.clientTurnId);
    if (runtime) return runtime.attach(response, afterRevision);
    return this.attachPersisted(response, scope, afterRevision);
  }

  async attachPersisted(response, scope, afterRevision = 0) {
    let lastRevision = Math.max(Number(afterRevision) || 0, 0);
    return new Promise((resolve) => {
      let closed = false;
      let timer = null;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        response.off?.("close", finish);
        resolve();
      };
      const poll = async () => {
        try {
          const liveRuntime = this.runtime(scope.clientTurnId);
          if (liveRuntime) {
            closed = true;
            if (timer) clearTimeout(timer);
            response.off?.("close", finish);
            await liveRuntime.attach(response, lastRevision);
            resolve();
            return;
          }
          let run = await DataAccessCenter.chatStreamRun.getScoped(scope);
          if (!run) {
            writeResponseChunk(response, {
              id: scope.clientTurnId,
              type: "abort",
              close: true,
              error: "Chat stream run was not found.",
              errorCode: "chat_stream_run_not_found",
            });
            response.end();
            finish();
            return;
          }
          if (
            run.status === "running" &&
            (!run.leaseExpiresAt ||
              Date.parse(run.leaseExpiresAt) <= Date.now())
          )
            run = await DataAccessCenter.chatStreamRun.reconcileExpired(scope);

          const events = await DataAccessCenter.chatStreamRun.eventsAfter({
            ...scope,
            id: run.id,
            afterSequence: lastRevision,
          });
          for (const event of events) {
            if (closed || responseClosed(response)) break;
            writeRunPayload(response, event.payload);
            lastRevision = Math.max(lastRevision, Number(event.sequence));
          }
          if (
            events.length === 0 &&
            run.partialResponse &&
            Number(run.revision) > lastRevision
          ) {
            lastRevision = Number(run.revision);
            writeRunPayload(response, {
              type: "response.output_text.delta",
              response_id: run.id,
              delta: run.partialResponse,
              replayed: true,
              clientTurnId: run.clientTurnId,
              runRevision: lastRevision,
              sequence_number: lastRevision,
            });
          }
          if (terminalStatus(run.status)) {
            const terminal = new ChatStreamRuntime(run);
            const lastEvent = events[events.length - 1]?.payload;
            terminal.responsesMode = isResponsesEvent(lastEvent);
            terminal.terminalEventType = lastEvent?.type || null;
            if (terminal.terminalEventType) {
              response.end();
              finish();
              return;
            }
            terminal.writeTerminal(response);
            response.end();
            finish();
            return;
          }
        } catch (error) {
          writeResponseChunk(response, {
            id: scope.clientTurnId,
            type: "abort",
            close: true,
            error: error?.message || "Chat stream reconnect failed.",
            errorCode: error?.code || "chat_stream_reconnect_failed",
          });
          response.end();
          finish();
          return;
        }
        if (!closed) timer = setTimeout(poll, PERSISTED_POLL_INTERVAL_MS);
      };
      response.once("close", finish);
      void poll();
    });
  }

  async cancel(scope) {
    const runtime = this.runtime(scope.clientTurnId);
    if (runtime) return runtime.cancel();
    const run = await DataAccessCenter.chatStreamRun.getScoped(scope);
    if (!run || terminalStatus(run.status)) return false;
    await DataAccessCenter.chatStreamRun.settle({
      ...scope,
      id: run.id,
      status: "cancelled",
      revision: run.revision,
      partialResponse: run.partialResponse,
      errorCode: "chat_stream_cancelled",
    });
    return true;
  }

  snapshot() {
    const active = [...this.runtimes.values()].filter(
      (runtime) => !terminalStatus(runtime.status)
    );
    return {
      accepting: this.accepting,
      activeRuns: active.length,
      totalResidentRuns: this.runtimes.size,
    };
  }

  async drain({ timeoutMs = 30_000 } = {}) {
    this.accepting = false;
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 0);
    while (
      [...this.runtimes.values()].some(
        (runtime) => !terminalStatus(runtime.status)
      ) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    return this.snapshot().activeRuns === 0;
  }
}

const chatStreamRunManager = new ChatStreamRunManager();

module.exports = {
  CHECKPOINT_BYTES,
  CHECKPOINT_INTERVAL_MS,
  EVENT_FLUSH_INTERVAL_MS,
  EVENT_FLUSH_MAX,
  LEASE_DURATION_MS,
  LEASE_HEARTBEAT_INTERVAL_MS,
  ChatStreamRunManager,
  ChatStreamRuntime,
  DetachedChatResponse,
  chatStreamRunManager,
  parseSsePayloads,
  terminalStatus,
};
