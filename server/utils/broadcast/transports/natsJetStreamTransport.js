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
const { appEnvironment } = require("../../environment");
const { resolveActiveKey } = require("../../security/keyCustody");
const { metrics } = require("../../observability/metrics");

const STREAM = "ATHENA_BROADCAST";
const DEFAULT_MAX_AGE_NS = 30 * 24 * 60 * 60 * 1_000_000_000;
const codec = JSONCodec();

function settings(env = process.env) {
  const servers = String(env.ATHENA_NATS_SERVERS || env.NATS_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const instance = String(
    env.ATHENA_NATS_CONSUMER_NAME ||
      `${env.ATHENA_RUNTIME_ROLE || "api"}-${os.hostname()}-${process.pid}`
  )
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return {
    servers,
    token: env.ATHENA_NATS_TOKEN || undefined,
    user: env.ATHENA_NATS_USER || undefined,
    pass: env.ATHENA_NATS_PASSWORD || undefined,
    stream: String(env.ATHENA_NATS_STREAM || STREAM),
    consumer: instance,
    maxAgeNs: Number(env.ATHENA_NATS_MAX_AGE_NS || DEFAULT_MAX_AGE_NS),
  };
}

function namespace(value) {
  return String(value || "event")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 48);
}

function subjectScope(event = {}) {
  const scope = event.scope || {};
  return JSON.stringify({
    userId: scope.userId ?? null,
    workspaceId: scope.workspaceId ?? null,
    threadId: scope.threadId ?? null,
    readerDocumentId: scope.readerDocumentId ?? null,
    clientId: scope.clientId ?? null,
    visibility: event.visibility || null,
  });
}

function irreversibleScope(event = {}) {
  const active = resolveActiveKey();
  if (!active?.material) {
    const error = new Error("nats_subject_key_unavailable");
    error.code = "NATS_SUBJECT_KEY_UNAVAILABLE";
    throw error;
  }
  return crypto
    .createHmac("sha256", active.material)
    .update("athena-nats-subject:v1\0")
    .update(subjectScope(event))
    .digest("hex")
    .slice(0, 32);
}

function subjectFor(event = {}) {
  return [
    "athena",
    appEnvironment(),
    namespace(event.namespace),
    irreversibleScope(event),
  ].join(".");
}

class NatsJetStreamTransport {
  constructor(env = process.env) {
    this.env = env;
    this.connection = null;
    this.jetstream = null;
    this.subscription = null;
    this.consumeTask = null;
    this.handler = null;
    this.lastError = null;
    this.startedAt = null;
    this.published = 0;
    this.received = 0;
    this.redelivered = 0;
    this.pending = 0;
  }

  async ensureStream() {
    const config = settings(this.env);
    const manager = await this.connection.jetstreamManager();
    try {
      await manager.streams.info(config.stream);
    } catch (error) {
      if (String(error?.code || error?.api_error?.err_code) !== "404")
        throw error;
      await manager.streams.add({
        name: config.stream,
        subjects: [`athena.${appEnvironment()}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        duplicate_window: 2 * 60 * 1_000_000_000,
        max_age: config.maxAgeNs,
        discard: DiscardPolicy.Old,
      });
    }
  }

  async connect() {
    if (this.connection && !this.connection.isClosed()) return this.connection;
    const config = settings(this.env);
    if (!config.servers.length) {
      const error = new Error("nats_servers_missing");
      error.code = "NATS_SERVERS_MISSING";
      throw error;
    }
    this.connection = await connect({
      servers: config.servers,
      name: `athena-${config.consumer}`,
      token: config.token,
      user: config.user,
      pass: config.pass,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1_000,
      timeout: 5_000,
    });
    this.jetstream = this.connection.jetstream();
    await this.ensureStream();
    this.startedAt = new Date().toISOString();
    return this.connection;
  }

  async start(handler) {
    if (this.consumeTask) return this.health();
    this.handler = handler;
    await this.connect();
    const config = settings(this.env);
    const options = consumerOpts();
    options.durable(config.consumer);
    options.manualAck();
    options.ackExplicit();
    options.deliverNew();
    options.filterSubject(`athena.${appEnvironment()}.>`);
    this.subscription = await this.jetstream.subscribe(
      `athena.${appEnvironment()}.>`,
      options
    );
    this.consumeTask = (async () => {
      try {
        for await (const message of this.subscription) {
          this.pending = Number(message.info?.pending || 0);
          metrics.natsConsumerLag.set(
            { consumer: config.consumer },
            this.pending
          );
          if (Number(message.info?.redeliveryCount || 1) > 1)
            this.redelivered += 1;
          try {
            const event = codec.decode(message.data);
            await this.handler?.(event);
            this.received += 1;
            metrics.natsEvents.inc({ action: "consume", outcome: "acked" });
            message.ack();
          } catch (error) {
            this.lastError = error?.code || error?.message || String(error);
            metrics.natsEvents.inc({ action: "consume", outcome: "nacked" });
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

  async publish(event) {
    await this.connect();
    const messageHeaders = headers();
    messageHeaders.set("Nats-Msg-Id", String(event.eventId));
    const ack = await this.jetstream.publish(
      subjectFor(event),
      codec.encode(event),
      {
        headers: messageHeaders,
      }
    );
    this.published += 1;
    metrics.natsEvents.inc({
      action: "publish",
      outcome: ack.duplicate ? "duplicate" : "accepted",
    });
    return {
      accepted: true,
      duplicate: Boolean(ack.duplicate),
      seq: Number(ack.seq || 0),
      stream: ack.stream,
    };
  }

  async drain() {
    if (!this.connection) return true;
    await this.subscription?.drain?.().catch(() => null);
    await this.connection.drain();
    this.connection = null;
    this.jetstream = null;
    this.subscription = null;
    this.consumeTask = null;
    return true;
  }

  health() {
    const config = settings(this.env);
    return {
      ready: Boolean(this.connection && !this.connection.isClosed()),
      adapter: "nats",
      multiInstance: true,
      durableReplay: true,
      configured: config.servers.length > 0,
      consumer: config.consumer,
      startedAt: this.startedAt,
      lag: this.pending,
      published: this.published,
      received: this.received,
      redelivered: this.redelivered,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  NatsJetStreamTransport,
  irreversibleScope,
  settings,
  subjectFor,
};
