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
const { operationsConfig } = require("./config");
const { metrics } = require("../observability/metrics");

const codec = JSONCodec();

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

function deliverySubject(consumer) {
  const stable = String(consumer || "athena-operations")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `_INBOX.ATHENA.OPERATIONS.${stable}`;
}

class OperationsJetStreamTransport {
  constructor(env = process.env) {
    this.env = env;
    this.config = operationsConfig(env);
    this.connection = null;
    this.jetstream = null;
    this.subscription = null;
    this.consumeTask = null;
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
    await this.ensureStream();
    this.startedAt = new Date().toISOString();
    return this.connection;
  }

  async ensureStream() {
    const manager = await this.connection.jetstreamManager();
    try {
      const info = await manager.streams.info(this.config.stream);
      const expected = `${subjectRoot(this.env)}.>`;
      if (
        !info.config.subjects?.includes(expected) ||
        Number(info.config.max_age) !== this.config.maxAgeNs ||
        Number(info.config.max_bytes) !== this.config.maxBytes
      ) {
        await manager.streams.update(this.config.stream, {
          ...info.config,
          subjects: [...new Set([...(info.config.subjects || []), expected])],
          max_age: this.config.maxAgeNs,
          max_bytes: this.config.maxBytes,
        });
      }
    } catch (error) {
      if (String(error?.code || error?.api_error?.err_code) !== "404")
        throw error;
      await manager.streams.add({
        name: this.config.stream,
        subjects: [`${subjectRoot(this.env)}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        duplicate_window: 2 * 60 * 1_000_000_000,
        max_age: this.config.maxAgeNs,
        max_bytes: this.config.maxBytes,
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

  async start(handler) {
    if (this.consumeTask) return this.health();
    await this.connect();
    const options = consumerOpts();
    options.durable(this.config.consumer);
    options.bindStream(this.config.stream);
    options.queue(this.config.consumer);
    options.deliverTo(deliverySubject(this.config.consumer));
    options.manualAck();
    options.ackExplicit();
    options.deliverAll();
    options.filterSubject(`${subjectRoot(this.env)}.>`);
    this.subscription = await this.jetstream.subscribe(
      `${subjectRoot(this.env)}.>`,
      options
    );
    this.consumeTask = (async () => {
      try {
        for await (const message of this.subscription) {
          this.pending = Number(message.info?.pending || 0);
          metrics.operationsConsumerLag.set(this.pending);
          try {
            await handler(codec.decode(message.data));
            this.received += 1;
            metrics.operationsEvents.inc({
              stage: "jetstream_consume",
              outcome: "acked",
            });
            message.ack();
          } catch (error) {
            this.lastError = error?.code || error?.message || String(error);
            metrics.operationsEvents.inc({
              stage: "jetstream_consume",
              outcome: "nacked",
            });
            message.nak(1_000);
          }
        }
      } catch (error) {
        this.lastError = error?.code || error?.message || String(error);
      } finally {
        this.consumeTask = null;
      }
    })();
    return this.health();
  }

  async drain() {
    await this.subscription?.drain?.().catch(() => null);
    await this.connection?.drain?.().catch(() => null);
    this.connection = null;
    this.jetstream = null;
    this.subscription = null;
    this.consumeTask = null;
  }

  async deleteConsumer() {
    if (!this.connection || this.connection.isClosed()) return false;
    await this.subscription?.drain?.().catch(() => null);
    this.subscription = null;
    const manager = await this.connection.jetstreamManager();
    try {
      return await manager.consumers.delete(
        this.config.stream,
        this.config.consumer
      );
    } catch (error) {
      if (String(error?.code || error?.api_error?.err_code) === "404")
        return false;
      throw error;
    }
  }

  async consumerState() {
    if (!this.connection || this.connection.isClosed())
      return { pending: null, ackPending: null, redelivered: null };
    const manager = await this.connection.jetstreamManager();
    const info = await manager.consumers.info(
      this.config.stream,
      this.config.consumer
    );
    return {
      pending: Number(info.num_pending || 0),
      ackPending: Number(info.num_ack_pending || 0),
      redelivered: Number(info.num_redelivered || 0),
    };
  }

  health() {
    return {
      configured: this.config.natsServers.length > 0,
      ready: Boolean(this.connection && !this.connection.isClosed()),
      stream: this.config.stream,
      consumer: this.config.consumer,
      startedAt: this.startedAt,
      published: this.published,
      received: this.received,
      pending: this.pending,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  OperationsJetStreamTransport,
  deliverySubject,
  subjectForSemanticEvent,
  subjectRoot,
};
