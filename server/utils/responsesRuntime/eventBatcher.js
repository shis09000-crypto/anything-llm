const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_MAX_EVENTS = 256;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

class DurableEventBatcher {
  constructor({
    responseId,
    persist,
    env = process.env,
    observe = null,
    onError = null,
  } = {}) {
    if (!responseId || typeof persist !== "function")
      throw new Error("response_event_batcher_configuration_invalid");
    this.responseId = responseId;
    this.persist = persist;
    this.observe = typeof observe === "function" ? observe : null;
    this.onError = typeof onError === "function" ? onError : null;
    this.flushIntervalMs = positiveInteger(
      env.ATHENA_RESPONSES_EVENT_BATCH_INTERVAL_MS,
      DEFAULT_FLUSH_INTERVAL_MS
    );
    this.maxBytes = positiveInteger(
      env.ATHENA_RESPONSES_EVENT_BATCH_MAX_BYTES,
      DEFAULT_MAX_BYTES
    );
    this.maxEvents = positiveInteger(
      env.ATHENA_RESPONSES_EVENT_BATCH_MAX_EVENTS,
      DEFAULT_MAX_EVENTS
    );
    this.pending = [];
    this.pendingBytes = 0;
    this.timer = null;
    this.chain = Promise.resolve();
    this.error = null;
    this.closed = false;
  }

  append(event, { boundary = false } = {}) {
    this.throwIfFailed();
    if (this.closed) throw new Error("response_event_batcher_closed");
    this.pending.push(event);
    this.pendingBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
    if (
      boundary ||
      this.pending.length >= this.maxEvents ||
      this.pendingBytes >= this.maxBytes
    ) {
      this.flush();
      return;
    }
    this.schedule();
  }

  schedule() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  flush() {
    if (!this.pending.length) return this.chain;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const events = this.pending;
    const bytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    const startedAt = Date.now();
    const operation = this.chain.then(() =>
      this.persist({ responseId: this.responseId, events })
    );
    this.chain = operation.catch((error) => {
      this.error ||= error;
      this.onError?.(error);
    });
    operation
      .then(() =>
        this.observe?.({
          eventCount: events.length,
          bytes,
          durationMs: Date.now() - startedAt,
        })
      )
      .catch(() => {});
    return operation;
  }

  async drain() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    await this.chain;
    this.throwIfFailed();
  }

  throwIfFailed() {
    if (!this.error) return;
    const failure = new Error("response_event_persist_failed");
    failure.code = "response_event_persist_failed";
    failure.cause = this.error;
    throw failure;
  }
}

module.exports = {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EVENTS,
  DurableEventBatcher,
};
