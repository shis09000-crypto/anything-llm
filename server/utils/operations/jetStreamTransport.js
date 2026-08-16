const crypto = require("crypto");
const os = require("os");
const {
  DiscardPolicy,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  connect,
  consumerOpts,
  headers,
} = require("nats");
const { appEnvironment } = require("../environment");
const {
  connectionSecurityOptions,
  settings: sharedNatsSettings,
} = require("../broadcast/transports/natsJetStreamTransport");
const { metrics } = require("../observability/metrics");
const { operationsConfig } = require("./config");
const { validateRegistered } = require("./schemaRegistry");
const {
  AICP_EVENT_SCHEMA,
  validateAicpEvent,
} = require("../modulePlatform/eventEnvelope");

const codec = JSONCodec();
const MAX_TIMELINE_SCAN = 2_000;
const TIMELINE_READ_CONCURRENCY = 25;

function category(value) {
  return String(value || "system")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 48);
}

function subjectRoot(env = process.env) {
  const config = operationsConfig(env);
  return `athena.${appEnvironment()}.${config.subjectPrefix}`;
}

function subjectForSemanticEvent(event, env = process.env) {
  return `${subjectRoot(env)}.${category(event?.category)}`;
}

function dlqSubject(env = process.env) {
  return `athena.${appEnvironment()}.${operationsConfig(env).dlqSubject}`;
}

function deliverySubject(consumer) {
  const stable = String(consumer || "athena-operations")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `_INBOX.ATHENA.OPERATIONS.${stable}`;
}

function boundedReason(value) {
  return String(value || "invalid")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 48);
}

function messageBytes(message) {
  return Number(message?.data?.byteLength || message?.data?.length || 0);
}

class OperationsBatchProcessor {
  constructor({
    config,
    persist,
    publishDlq,
    now = () => Date.now(),
    random = Math.random,
  }) {
    this.config = config;
    this.persist = persist;
    this.publishDlq = publishDlq;
    this.now = now;
    this.random = random;
    this.queue = [];
    this.queueBytes = 0;
    this.activeBatch = [];
    this.flushTimer = null;
    this.workingTimer = null;
    this.flushing = false;
    this.closing = false;
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
    this.nextAttemptAt = null;
    this.lastBatchSuccessAt = null;
    this.lastBatchFailureAt = null;
    this.lastError = null;
  }

  enqueue(message) {
    if (this.closing) return false;
    this.queue.push(message);
    this.queueBytes += messageBytes(message);
    this.startWorkingTimer();
    const full =
      this.queue.length >= this.config.batch.maxMessages ||
      this.queueBytes >= this.config.batch.maxBytes;
    this.schedule(full ? 0 : this.config.batch.maxWaitMs);
    return true;
  }

  startWorkingTimer() {
    if (this.workingTimer) return;
    this.workingTimer = setInterval(
      () => this.extendLeases(),
      this.config.batch.workingIntervalMs
    );
    this.workingTimer.unref?.();
  }

  stopWorkingTimerIfIdle() {
    if (this.queue.length || this.activeBatch.length || this.flushing) return;
    if (this.workingTimer) clearInterval(this.workingTimer);
    this.workingTimer = null;
  }

  extendLeases() {
    const seen = new Set();
    for (const message of [...this.activeBatch, ...this.queue]) {
      if (!message || seen.has(message)) continue;
      seen.add(message);
      try {
        message.working();
      } catch {
        // A later redelivery is safe because ClickHouse is idempotent by event_id.
      }
    }
  }

  schedule(delayMs) {
    if (this.closing || this.flushing || !this.queue.length) return;
    if (this.flushTimer) {
      if (delayMs !== 0) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        void this.flush();
      },
      Math.max(0, delayMs)
    );
    this.flushTimer.unref?.();
  }

  takeBatch() {
    const batch = [];
    let bytes = 0;
    while (this.queue.length && batch.length < this.config.batch.maxMessages) {
      const next = this.queue[0];
      const nextBytes = messageBytes(next);
      if (batch.length && bytes + nextBytes > this.config.batch.maxBytes) break;
      batch.push(this.queue.shift());
      bytes += nextBytes;
      this.queueBytes -= nextBytes;
    }
    return batch;
  }

  backoffMs() {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    const base = Math.min(
      this.config.circuitBreaker.maxDelayMs,
      this.config.circuitBreaker.baseDelayMs * 2 ** exponent
    );
    const jitter =
      base * this.config.circuitBreaker.jitterRatio * this.random();
    return Math.round(
      Math.min(this.config.circuitBreaker.maxDelayMs, base + jitter)
    );
  }

  openCircuit(error) {
    this.consecutiveFailures += 1;
    this.circuitState = "open";
    this.lastBatchFailureAt = new Date(this.now()).toISOString();
    this.lastError = error?.code || error?.message || String(error);
    this.nextAttemptAt = this.now() + this.backoffMs();
    metrics.operationsCircuitBreakerOpen.set(1);
    metrics.operationsConsecutiveFailures.set(this.consecutiveFailures);
  }

  closeCircuit() {
    this.consecutiveFailures = 0;
    this.circuitState = "closed";
    this.nextAttemptAt = null;
    this.lastError = null;
    metrics.operationsCircuitBreakerOpen.set(0);
    metrics.operationsConsecutiveFailures.set(0);
  }

  async deadLetter(message, reason, detail) {
    const record = {
      schema: "athena.operations.dead-letter",
      schemaVersion: "1.0",
      reason: boundedReason(reason),
      detail: String(detail || "").slice(0, 240),
      sourceStream: message.info?.stream || null,
      sourceConsumer: message.info?.consumer || null,
      sourceStreamSequence: Number(
        message.info?.streamSequence || message.seq || 0
      ),
      sourceSubject: String(message.subject || "").slice(0, 240),
      deliveryCount: Number(message.info?.deliveryCount || 0),
      payloadBytes: messageBytes(message),
      payloadSha256: crypto
        .createHash("sha256")
        .update(Buffer.from(message.data || []))
        .digest("hex"),
      observedAt: new Date(this.now()).toISOString(),
    };
    await this.publishDlq(record);
    message.ack();
    metrics.aicpEventDelivery.inc({
      stage: "consume",
      outcome: "dlq",
    });
    metrics.operationsDlqEvents.inc({ reason: record.reason });
    metrics.operationsEvents.inc({
      stage: "jetstream_consume",
      outcome: "dead_lettered",
    });
  }

  decode(message) {
    let event;
    try {
      event = codec.decode(message.data);
    } catch (error) {
      return {
        valid: false,
        reason: "json_decode_failed",
        detail: error?.message || String(error),
      };
    }
    if (event?.schema === AICP_EVENT_SCHEMA) {
      const aicpValidation = validateAicpEvent(event);
      if (!aicpValidation.valid)
        return {
          valid: false,
          reason: "aicp_contract_validation_failed",
          detail: aicpValidation.findings.join(","),
        };
      event = event.payload;
    }
    const validation = validateRegistered(event);
    if (!validation.valid) {
      return {
        valid: false,
        reason: "schema_validation_failed",
        detail: validation.errors,
      };
    }
    return { valid: true, event };
  }

  async flush() {
    if (this.closing || this.flushing || !this.queue.length) return false;
    if (this.nextAttemptAt && this.now() < this.nextAttemptAt) {
      this.schedule(this.nextAttemptAt - this.now());
      return false;
    }

    this.flushing = true;
    this.circuitState = this.consecutiveFailures ? "half_open" : "closed";
    metrics.operationsCircuitBreakerOpen.set(
      this.circuitState === "closed" ? 0 : 1
    );
    const batch = this.takeBatch();
    this.activeBatch = batch;
    const valid = [];
    try {
      for (const message of batch) {
        const decoded = this.decode(message);
        if (!decoded.valid) {
          await this.deadLetter(message, decoded.reason, decoded.detail);
          continue;
        }
        valid.push({ message, event: decoded.event });
      }
      if (valid.length) {
        await this.persist(valid.map((entry) => entry.event));
        for (const { message } of valid) message.ack();
        metrics.aicpEventDelivery.inc(
          { stage: "consume", outcome: "acked" },
          valid.length
        );
        metrics.operationsEvents.inc(
          { stage: "jetstream_consume", outcome: "acked" },
          valid.length
        );
      }
      this.lastBatchSuccessAt = new Date(this.now()).toISOString();
      this.closeCircuit();
      return true;
    } catch (error) {
      const acknowledged = new Set(
        batch.filter((message) => message?.didAck === true)
      );
      const retry = batch.filter((message) => !acknowledged.has(message));
      this.queue.unshift(...retry);
      this.queueBytes += retry.reduce(
        (total, message) => total + messageBytes(message),
        0
      );
      this.openCircuit(error);
      metrics.operationsEvents.inc({
        stage: "jetstream_consume",
        outcome: "retry_deferred",
      });
      return false;
    } finally {
      this.activeBatch = [];
      this.flushing = false;
      if (this.queue.length) {
        this.schedule(
          this.nextAttemptAt
            ? Math.max(0, this.nextAttemptAt - this.now())
            : this.config.batch.maxWaitMs
        );
      }
      this.stopWorkingTimerIfIdle();
    }
  }

  close() {
    this.closing = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.workingTimer) clearInterval(this.workingTimer);
    this.flushTimer = null;
    this.workingTimer = null;
  }

  health() {
    return {
      queuedMessages: this.queue.length + this.activeBatch.length,
      queuedBytes: this.queueBytes,
      circuitState: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      nextAttemptAt: this.nextAttemptAt
        ? new Date(this.nextAttemptAt).toISOString()
        : null,
      lastBatchSuccessAt: this.lastBatchSuccessAt,
      lastBatchFailureAt: this.lastBatchFailureAt,
      lastError: this.lastError,
    };
  }
}

class OperationsJetStreamTransport {
  constructor(env = process.env) {
    this.env = env;
    this.config = operationsConfig(env);
    this.connection = null;
    this.jetstream = null;
    this.subscription = null;
    this.processor = null;
    this.stateTimer = null;
    this.lastState = null;
    this.lastError = null;
    this.startedAt = null;
    this.published = 0;
    this.received = 0;
    this.pending = 0;
  }

  async connect() {
    if (this.connection && !this.connection.isClosed()) return this.connection;
    if (!this.config.natsServers.length) {
      const error = new Error("operations_nats_servers_missing");
      error.code = "OPERATIONS_NATS_SERVERS_MISSING";
      throw error;
    }
    const shared = sharedNatsSettings(this.env);
    this.connection = await connect({
      servers: this.config.natsServers,
      name: `athena-ops-${os.hostname()}-${process.pid}`,
      token: shared.token,
      user: shared.user,
      pass: shared.pass,
      ...connectionSecurityOptions(shared),
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1_000,
      timeout: 5_000,
    });
    this.jetstream = this.connection.jetstream();
    await this.ensureStreams();
    this.startedAt = new Date().toISOString();
    return this.connection;
  }

  async ensureStreams() {
    const manager = await this.connection.jetstreamManager();
    await this.ensureStream(manager, {
      name: this.config.stream,
      subject: `${subjectRoot(this.env)}.>`,
      maxAge: this.config.maxAgeNs,
      maxBytes: this.config.maxBytes,
    });
    await this.ensureStream(manager, {
      name: this.config.dlqStream,
      subject: dlqSubject(this.env),
      maxAge: this.config.maxAgeNs,
      maxBytes: Math.min(this.config.maxBytes, 512 * 1024 * 1024),
    });
  }

  async ensureStream(manager, { name, subject, maxAge, maxBytes }) {
    try {
      const info = await manager.streams.info(name);
      if (!info.config.subjects?.includes(subject)) {
        await manager.streams.update(name, {
          ...info.config,
          subjects: [...new Set([...(info.config.subjects || []), subject])],
          max_age: maxAge,
          max_bytes: maxBytes,
        });
      }
    } catch (error) {
      if (String(error?.code || error?.api_error?.err_code) !== "404")
        throw error;
      await manager.streams.add({
        name,
        subjects: [subject],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        duplicate_window: 2 * 60 * 1_000_000_000,
        max_age: maxAge,
        max_bytes: maxBytes,
        discard: DiscardPolicy.Old,
      });
    }
  }

  async publish(event) {
    await this.connect();
    const messageHeaders = headers();
    messageHeaders.set("Nats-Msg-Id", String(event.eventId));
    const ack = await this.jetstream.publish(
      subjectForSemanticEvent(event, this.env),
      codec.encode(event),
      { headers: messageHeaders }
    );
    this.published += 1;
    metrics.operationsEvents.inc({
      stage: "jetstream_publish",
      outcome: ack.duplicate ? "duplicate" : "accepted",
    });
    return {
      accepted: true,
      duplicate: Boolean(ack.duplicate),
      sequence: Number(ack.seq || 0),
    };
  }

  async publishDlq(record) {
    const messageHeaders = headers();
    messageHeaders.set(
      "Nats-Msg-Id",
      `operations-dlq-${record.sourceStreamSequence}-${record.payloadSha256}`
    );
    return this.jetstream.publish(dlqSubject(this.env), codec.encode(record), {
      headers: messageHeaders,
    });
  }

  async start(handler) {
    if (this.subscription) return this.health();
    await this.connect();
    await this.ensureConsumerPolicy();
    this.processor = new OperationsBatchProcessor({
      config: this.config,
      persist: async (events) => {
        await handler(events);
        this.received += events.length;
      },
      publishDlq: (record) => this.publishDlq(record),
    });
    const options = consumerOpts();
    options.durable(this.config.consumer);
    options.queue(this.config.consumer);
    options.deliverTo(deliverySubject(this.config.consumer));
    options.manualAck();
    options.ackExplicit();
    options.ackWait(this.config.batch.ackWaitMs);
    options.maxAckPending(this.config.batch.maxMessages);
    options.idleHeartbeat(10_000);
    options.flowControl();
    options.deliverAll();
    options.filterSubject(`${subjectRoot(this.env)}.>`);
    options.callback((error, message) => {
      if (error) {
        this.lastError = error?.code || error?.message || String(error);
        return;
      }
      if (!message) return;
      this.pending = Number(message.info?.pending || 0);
      metrics.operationsConsumerLag.set(this.pending);
      this.processor.enqueue(message);
    });
    this.subscription = await this.jetstream.subscribe(
      `${subjectRoot(this.env)}.>`,
      options
    );
    await this.refreshConsumerState().catch(() => null);
    this.stateTimer = setInterval(
      () => void this.refreshConsumerState().catch(() => null),
      15_000
    );
    this.stateTimer.unref?.();
    return this.health();
  }

  async ensureConsumerPolicy() {
    const manager = await this.connection.jetstreamManager();
    try {
      await manager.consumers.info(this.config.stream, this.config.consumer);
      await manager.consumers.update(this.config.stream, this.config.consumer, {
        ack_wait: this.config.batch.ackWaitMs * 1_000_000,
        max_ack_pending: this.config.batch.maxMessages,
      });
    } catch (error) {
      if (String(error?.code || error?.api_error?.err_code) !== "404")
        throw error;
    }
  }

  async pause(until = new Date(Date.now() + 2 * 60 * 60 * 1_000)) {
    await this.connect();
    const manager = await this.connection.jetstreamManager();
    return manager.consumers.pause(
      this.config.stream,
      this.config.consumer,
      until
    );
  }

  async resume() {
    await this.connect();
    const manager = await this.connection.jetstreamManager();
    return manager.consumers.resume(this.config.stream, this.config.consumer);
  }

  async drain() {
    this.processor?.close();
    this.processor = null;
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = null;
    this.subscription?.unsubscribe?.();
    await this.connection?.drain?.().catch(() => null);
    this.connection = null;
    this.jetstream = null;
    this.subscription = null;
  }

  async refreshConsumerState() {
    const state = await this.consumerState();
    this.lastState = state;
    if (state.streamLastSeq != null)
      metrics.operationsConsumerStreamSequence.set(state.streamLastSeq);
    if (state.ackFloorStreamSeq != null)
      metrics.operationsConsumerAckFloor.set(state.ackFloorStreamSeq);
    if (state.ackPending != null)
      metrics.operationsConsumerAckPending.set(state.ackPending);
    if (state.redelivered != null)
      metrics.operationsConsumerRedeliveries.set(state.redelivered);
    if (state.dlqMessages != null)
      metrics.operationsDlqMessages.set(state.dlqMessages);
    if (state.lag != null) metrics.operationsConsumerLag.set(state.lag);
    return state;
  }

  async consumerState() {
    if (!this.connection || this.connection.isClosed())
      return {
        pending: null,
        ackPending: null,
        redelivered: null,
        streamLastSeq: null,
        ackFloorStreamSeq: null,
        deliveredStreamSeq: null,
        lag: null,
      };
    const manager = await this.connection.jetstreamManager();
    const [stream, consumer, dlq] = await Promise.all([
      manager.streams.info(this.config.stream),
      manager.consumers.info(this.config.stream, this.config.consumer),
      manager.streams.info(this.config.dlqStream),
    ]);
    const streamLastSeq = Number(stream.state?.last_seq || 0);
    const ackFloorStreamSeq = Number(consumer.ack_floor?.stream_seq || 0);
    return {
      pending: Number(consumer.num_pending || 0),
      ackPending: Number(consumer.num_ack_pending || 0),
      redelivered: Number(consumer.num_redelivered || 0),
      streamFirstSeq: Number(stream.state?.first_seq || 0),
      streamLastSeq,
      ackFloorStreamSeq,
      deliveredStreamSeq: Number(consumer.delivered?.stream_seq || 0),
      lag: Math.max(0, streamLastSeq - ackFloorStreamSeq),
      paused: Boolean(consumer.paused),
      pauseUntil: consumer.pause_until || null,
      dlqMessages: Number(dlq.state?.messages || 0),
    };
  }

  async recentEvents({ limit = 100, scanLimit, predicate = () => true } = {}) {
    await this.connect();
    const manager = await this.connection.jetstreamManager();
    const stream = await manager.streams.info(this.config.stream);
    const firstSeq = Number(stream.state?.first_seq || 0);
    const lastSeq = Number(stream.state?.last_seq || 0);
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const boundedScan = Math.max(
      boundedLimit,
      Math.min(
        Number(scanLimit) || Math.max(boundedLimit * 10, 500),
        MAX_TIMELINE_SCAN
      )
    );
    const events = [];
    let scanned = 0;
    let cursor = lastSeq;
    while (
      cursor >= firstSeq &&
      scanned < boundedScan &&
      events.length < boundedLimit
    ) {
      const sequences = [];
      while (
        cursor >= firstSeq &&
        scanned + sequences.length < boundedScan &&
        sequences.length < TIMELINE_READ_CONCURRENCY
      ) {
        sequences.push(cursor);
        cursor -= 1;
      }
      scanned += sequences.length;
      const stored = await Promise.all(
        sequences.map((seq) =>
          manager.streams
            .getMessage(this.config.stream, { seq })
            .catch(() => null)
        )
      );
      for (const message of stored) {
        if (!message) continue;
        try {
          const event = codec.decode(message.data);
          if (validateRegistered(event).valid && predicate(event))
            events.push(event);
        } catch {
          // Invalid retained messages are handled by the durable consumer and DLQ.
        }
        if (events.length >= boundedLimit) break;
      }
    }
    return {
      events,
      scanned,
      completeness:
        cursor < firstSeq || events.length >= boundedLimit
          ? "complete"
          : "partial",
      streamFirstSeq: firstSeq,
      streamLastSeq: lastSeq,
    };
  }

  health() {
    const processor = this.processor?.health() || {
      circuitState: "closed",
      consecutiveFailures: 0,
      queuedMessages: 0,
    };
    const connected = Boolean(this.connection && !this.connection.isClosed());
    return {
      configured: this.config.natsServers.length > 0,
      ready:
        connected &&
        Boolean(this.subscription) &&
        processor.circuitState !== "open",
      connected,
      stream: this.config.stream,
      consumer: this.config.consumer,
      dlqStream: this.config.dlqStream,
      startedAt: this.startedAt,
      published: this.published,
      received: this.received,
      pending: this.pending,
      lastError: processor.lastError || this.lastError,
      ...this.lastState,
      ...processor,
    };
  }
}

module.exports = {
  OperationsBatchProcessor,
  OperationsJetStreamTransport,
  deliverySubject,
  dlqSubject,
  subjectForSemanticEvent,
  subjectRoot,
};
