const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  DiscardPolicy,
  JSONCodec,
  RetentionPolicy,
  StorageType,
  connect,
  consumerOpts,
  credsAuthenticator,
  headers,
  nkeyAuthenticator,
} = require("nats");
const { appEnvironment } = require("../../environment");
const { resolveActiveKey } = require("../../security/keyCustody");
const { metrics } = require("../../observability/metrics");

const STREAM = "ATHENA_BROADCAST";
const DEFAULT_MAX_AGE_NS = 30 * 24 * 60 * 60 * 1_000_000_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
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
    credentialsFile:
      String(env.ATHENA_NATS_CREDENTIALS_FILE || "").trim() || undefined,
    nkeySeedFile:
      String(env.ATHENA_NATS_NKEY_SEED_FILE || "").trim() || undefined,
    tls: {
      caFile: String(env.ATHENA_NATS_TLS_CA_FILE || "").trim() || undefined,
      certFile: String(env.ATHENA_NATS_TLS_CERT_FILE || "").trim() || undefined,
      keyFile: String(env.ATHENA_NATS_TLS_KEY_FILE || "").trim() || undefined,
      serverName:
        String(env.ATHENA_NATS_TLS_SERVER_NAME || "").trim() || undefined,
    },
    stream: String(env.ATHENA_NATS_STREAM || STREAM),
    consumer: instance,
    maxAgeNs: Number(env.ATHENA_NATS_MAX_AGE_NS || DEFAULT_MAX_AGE_NS),
    maxBytes: Math.max(
      64 * 1024 * 1024,
      Number(env.ATHENA_NATS_MAX_BYTES || DEFAULT_MAX_BYTES)
    ),
  };
}

function natsSecurityFindings(env = process.env) {
  if (String(env.ATHENA_BROADCAST_TRANSPORT || "memory") !== "nats") return [];
  const config = settings(env);
  const production = env.NODE_ENV === "production";
  const findings = [];
  if (!config.servers.length) findings.push("ATHENA_NATS_SERVERS is required.");
  if (
    production &&
    config.servers.some((server) => !String(server).startsWith("tls://"))
  )
    findings.push("Production NATS servers must use tls:// endpoints.");
  const workloadIdentities = [
    Boolean(config.credentialsFile),
    Boolean(config.nkeySeedFile),
  ].filter(Boolean).length;
  if (workloadIdentities > 1)
    findings.push("Configure only one NATS workload identity source.");
  if (production && workloadIdentities !== 1)
    findings.push(
      "Production NATS requires exactly one credentials or NKey workload identity file."
    );
  if (production && (config.token || config.user || config.pass))
    findings.push(
      "Production NATS forbids shared token and username/password authentication."
    );
  if (
    production &&
    (!config.tls.caFile || !config.tls.certFile || !config.tls.keyFile)
  )
    findings.push(
      "Production NATS requires CA, client certificate, and client key files for mTLS."
    );
  for (const [label, filePath] of [
    ["credentials", config.credentialsFile],
    ["NKey seed", config.nkeySeedFile],
    ["TLS CA", config.tls.caFile],
    ["TLS certificate", config.tls.certFile],
    ["TLS private key", config.tls.keyFile],
  ]) {
    if (!filePath) continue;
    try {
      const stat = fs.statSync(path.resolve(filePath));
      if (!stat.isFile()) findings.push(`NATS ${label} path is not a file.`);
      if (
        production &&
        [
          config.credentialsFile,
          config.nkeySeedFile,
          config.tls.keyFile,
        ].includes(filePath) &&
        (stat.mode & 0o077) !== 0
      ) {
        findings.push(
          `NATS ${label} file permissions expose private material.`
        );
      }
    } catch {
      findings.push(`NATS ${label} file is missing or unreadable.`);
    }
  }
  return findings;
}

function assertSecureCredentialFile(filePath, label) {
  const target = path.resolve(filePath);
  const stat = fs.statSync(target);
  if ((stat.mode & 0o077) !== 0) {
    const error = new Error(`${label}_permissions_unsafe`);
    error.code = "NATS_CREDENTIAL_FILE_PERMISSIONS_UNSAFE";
    throw error;
  }
  return target;
}

function readNKeySeedFile(filePath) {
  const seed = fs.readFileSync(filePath, "utf8").trim();
  if (!seed) {
    const error = new Error("nats_nkey_seed_file_empty");
    error.code = "NATS_NKEY_SEED_EMPTY";
    throw error;
  }
  return Buffer.from(seed, "ascii");
}

function connectionSecurityOptions(config) {
  let authenticator;
  if (config.credentialsFile) {
    const target = assertSecureCredentialFile(
      config.credentialsFile,
      "nats_credentials_file"
    );
    authenticator = credsAuthenticator(fs.readFileSync(target));
  } else if (config.nkeySeedFile) {
    const target = assertSecureCredentialFile(
      config.nkeySeedFile,
      "nats_nkey_seed_file"
    );
    authenticator = nkeyAuthenticator(readNKeySeedFile(target));
  }
  const tlsConfigured = Object.values(config.tls).some(Boolean);
  const tls = tlsConfigured
    ? {
        ...(config.tls.caFile
          ? { ca: fs.readFileSync(path.resolve(config.tls.caFile), "utf8") }
          : {}),
        ...(config.tls.certFile
          ? { cert: fs.readFileSync(path.resolve(config.tls.certFile), "utf8") }
          : {}),
        ...(config.tls.keyFile
          ? { key: fs.readFileSync(path.resolve(config.tls.keyFile), "utf8") }
          : {}),
        ...(config.tls.serverName ? { servername: config.tls.serverName } : {}),
      }
    : null;
  return {
    ...(authenticator ? { authenticator } : {}),
    ...(tls ? { tls } : {}),
  };
}

function namespace(value) {
  return String(value || "event")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 48);
}

function deliverySubject(consumer) {
  const stable = String(consumer || "athena-broadcast")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `_INBOX.ATHENA.BROADCAST.${stable}`;
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
      const info = await manager.streams.info(config.stream);
      const expectedSubject = `athena.${appEnvironment()}.>`;
      if (
        !info.config.subjects?.includes(expectedSubject) ||
        Number(info.config.max_age) !== config.maxAgeNs ||
        Number(info.config.max_bytes) !== config.maxBytes
      ) {
        await manager.streams.update(config.stream, {
          ...info.config,
          subjects: [
            ...new Set([...(info.config.subjects || []), expectedSubject]),
          ],
          max_age: config.maxAgeNs,
          max_bytes: config.maxBytes,
        });
      }
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
        max_bytes: config.maxBytes,
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
    const securityFindings = natsSecurityFindings(this.env);
    if (securityFindings.length) {
      const error = new Error(
        `nats_security_policy_failed: ${securityFindings.join(" ")}`
      );
      error.code = "NATS_SECURITY_POLICY_FAILED";
      throw error;
    }
    this.connection = await connect({
      servers: config.servers,
      name: `athena-${config.consumer}`,
      token: config.token,
      user: config.user,
      pass: config.pass,
      ...connectionSecurityOptions(config),
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
    options.bindStream(config.stream);
    options.deliverTo(deliverySubject(config.consumer));
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
  connectionSecurityOptions,
  deliverySubject,
  irreversibleScope,
  natsSecurityFindings,
  readNKeySeedFile,
  settings,
  subjectFor,
};
