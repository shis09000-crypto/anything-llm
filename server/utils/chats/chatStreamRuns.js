const { EventEmitter } = require("events");
const { DataAccessCenter } = require("../dataAccess");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { emitSemanticEvent } = require("../observability/semanticEvents");

const CHECKPOINT_INTERVAL_MS = 750;
const CHECKPOINT_BYTES = 1_024;
const PERSISTED_POLL_INTERVAL_MS = 750;
const ORPHANED_RUN_GRACE_MS = 5_000;

function terminalStatus(status) {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

function responseClosed(response) {
  return response.destroyed || response.writableEnded;
}

function emitRunEvent(run, eventType, outcome, extra = {}) {
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
  constructor(run) {
    this.run = run;
    this.revision = Number(run.revision || 0);
    this.partialResponse = String(run.partialResponse || "");
    this.lastCheckpointLength = this.partialResponse.length;
    this.finalChatId = run.finalChatId || null;
    this.finalPublicChatId = run.finalPublicChatId || null;
    this.status = run.status || "running";
    this.errorCode = run.errorCode || null;
    this.cancelRequested = false;
    this.terminalEventType = null;
    this.subscribers = new Map();
    this.checkpointTimer = null;
    this.checkpointChain = Promise.resolve();
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

    const event = {
      ...payload,
      clientTurnId: payload.clientTurnId || this.run.clientTurnId,
      runRevision: this.revision,
    };
    this.broadcast(event);
    this.scheduleCheckpoint();
  }

  broadcast(payload) {
    for (const [response, subscriber] of this.subscribers.entries()) {
      if (responseClosed(response)) {
        this.detach(response);
        continue;
      }
      try {
        writeResponseChunk(response, payload);
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
      writeResponseChunk(response, {
        id: this.run.id,
        type: "fullTextResponse",
        textResponse: this.partialResponse,
        close: false,
        replayed: normalizedAfter > 0,
        clientTurnId: this.run.clientTurnId,
        runRevision: this.revision,
      });
    }
    if (terminalStatus(this.status)) {
      this.writeTerminal(response);
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
      { status }
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
    this.broadcast({
      id: this.run.id,
      type: "stopGeneration",
      close: false,
      clientTurnId: this.run.clientTurnId,
      runRevision: this.revision,
    });
    this.sink.cancel();
    return true;
  }
}

class ChatStreamRunManager {
  constructor() {
    this.runtimes = new Map();
  }

  runtime(clientTurnId) {
    return this.runtimes.get(String(clientTurnId || "").trim()) || null;
  }

  async claim(scope) {
    return DataAccessCenter.chatStreamRun.claim(scope);
  }

  async state(scope) {
    const run = await DataAccessCenter.chatStreamRun.getScoped(scope);
    if (!run) return null;
    return {
      kind: "chat",
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
    const runtime = new ChatStreamRuntime(run);
    this.runtimes.set(run.clientTurnId, runtime);
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
        runtime.acceptPayload({
          id: run.id,
          type: "abort",
          close: true,
          error: error?.message || "Chat generation failed.",
          errorCode: error?.code || "chat_stream_failed",
        });
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
    const attachedAt = Date.now();
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
          const run = await DataAccessCenter.chatStreamRun.getScoped(scope);
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
            Date.now() - attachedAt >= ORPHANED_RUN_GRACE_MS
          ) {
            await DataAccessCenter.chatStreamRun.settle({
              ...scope,
              id: run.id,
              status: "interrupted",
              revision: run.revision,
              partialResponse: run.partialResponse,
              errorCode: "chat_stream_owner_lost",
            });
            run.status = "interrupted";
            run.errorCode = "chat_stream_owner_lost";
          }
          if (run.partialResponse && Number(run.revision) > lastRevision) {
            lastRevision = Number(run.revision);
            writeResponseChunk(response, {
              id: run.id,
              type: "fullTextResponse",
              textResponse: run.partialResponse,
              close: false,
              replayed: true,
              clientTurnId: run.clientTurnId,
              runRevision: lastRevision,
            });
          }
          if (terminalStatus(run.status)) {
            const terminal = new ChatStreamRuntime(run);
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
}

const chatStreamRunManager = new ChatStreamRunManager();

module.exports = {
  CHECKPOINT_BYTES,
  CHECKPOINT_INTERVAL_MS,
  ChatStreamRunManager,
  ChatStreamRuntime,
  DetachedChatResponse,
  chatStreamRunManager,
  parseSsePayloads,
  terminalStatus,
};
