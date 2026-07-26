const fs = require("fs");

function readSecret(filePath, fallback = "") {
  const target = String(filePath || "").trim();
  if (!target) return fallback;
  try {
    return fs.readFileSync(target, "utf8").trim();
  } catch {
    return fallback;
  }
}

function operationsConfig(env = process.env) {
  const natsServers = String(env.ATHENA_NATS_SERVERS || env.NATS_URL || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const clickhouseUrl = String(env.ATHENA_CLICKHOUSE_URL || "").replace(
    /\/$/,
    ""
  );
  return {
    enabled:
      String(env.ATHENA_OPERATIONS_ENABLED || "false").toLowerCase() === "true",
    natsServers,
    stream: String(env.ATHENA_OPERATIONS_NATS_STREAM || "ATHENA_OPERATIONS"),
    subjectPrefix: String(
      env.ATHENA_OPERATIONS_NATS_SUBJECT || "operations.semantic.v1"
    ),
    consumer: String(
      env.ATHENA_OPERATIONS_NATS_CONSUMER || "athena-operations-clickhouse"
    )
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 96),
    dlqStream: String(
      env.ATHENA_OPERATIONS_NATS_DLQ_STREAM || "ATHENA_OPERATIONS_DLQ"
    )
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 96),
    dlqSubject: String(
      env.ATHENA_OPERATIONS_NATS_DLQ_SUBJECT || "operations.dead-letter.v1"
    )
      .replace(/^\.+|\.+$/g, "")
      .replace(/[^A-Za-z0-9_.-]/g, "-")
      .slice(0, 160),
    batch: {
      maxMessages: Math.max(
        1,
        Math.min(Number(env.ATHENA_OPERATIONS_BATCH_MAX_MESSAGES || 256), 256)
      ),
      maxBytes: Math.max(
        1_024,
        Math.min(
          Number(env.ATHENA_OPERATIONS_BATCH_MAX_BYTES || 1024 * 1024),
          1024 * 1024
        )
      ),
      maxWaitMs: Math.max(
        50,
        Math.min(
          Number(env.ATHENA_OPERATIONS_BATCH_MAX_WAIT_MS || 1_000),
          5_000
        )
      ),
      ackWaitMs: Math.max(
        10_000,
        Number(env.ATHENA_OPERATIONS_ACK_WAIT_MS || 60_000)
      ),
      workingIntervalMs: Math.max(
        5_000,
        Number(env.ATHENA_OPERATIONS_WORKING_INTERVAL_MS || 20_000)
      ),
    },
    circuitBreaker: {
      baseDelayMs: Math.max(
        100,
        Number(env.ATHENA_OPERATIONS_CIRCUIT_BASE_DELAY_MS || 5_000)
      ),
      maxDelayMs: Math.max(
        1_000,
        Number(env.ATHENA_OPERATIONS_CIRCUIT_MAX_DELAY_MS || 120_000)
      ),
      jitterRatio: Math.max(
        0,
        Math.min(Number(env.ATHENA_OPERATIONS_CIRCUIT_JITTER_RATIO || 0.2), 0.5)
      ),
    },
    maxAgeNs: Number(
      env.ATHENA_OPERATIONS_NATS_MAX_AGE_NS || 7 * 24 * 60 * 60 * 1_000_000_000
    ),
    maxBytes: Math.max(
      64 * 1024 * 1024,
      Number(env.ATHENA_OPERATIONS_NATS_MAX_BYTES || 4 * 1024 * 1024 * 1024)
    ),
    clickhouse: {
      configured: Boolean(clickhouseUrl),
      url: clickhouseUrl,
      database: String(env.ATHENA_CLICKHOUSE_DATABASE || "athena_operations"),
      user: String(env.ATHENA_CLICKHOUSE_USER || "athena_ops"),
      password: readSecret(
        env.ATHENA_CLICKHOUSE_PASSWORD_FILE,
        env.NODE_ENV === "production"
          ? ""
          : String(env.ATHENA_CLICKHOUSE_PASSWORD || "")
      ),
      table: String(env.ATHENA_CLICKHOUSE_EVENTS_TABLE || "semantic_events_v1"),
      timeoutMs: Math.max(
        500,
        Number(env.ATHENA_CLICKHOUSE_TIMEOUT_MS || 5_000)
      ),
      asyncInsertBusyTimeoutMs: Math.max(
        50,
        Number(env.ATHENA_CLICKHOUSE_ASYNC_INSERT_BUSY_TIMEOUT_MS || 250)
      ),
    },
  };
}

function operationsSecurityFindings(env = process.env) {
  const config = operationsConfig(env);
  if (!config.enabled) return [];
  const findings = [];
  if (!config.natsServers.length)
    findings.push("Operations Plane requires ATHENA_NATS_SERVERS.");
  if (!config.clickhouse.configured)
    findings.push("Operations Plane requires ATHENA_CLICKHOUSE_URL.");
  if (
    env.NODE_ENV === "production" &&
    config.natsServers.some((server) => !server.startsWith("tls://"))
  )
    findings.push("Production Operations JetStream requires tls:// endpoints.");
  if (
    env.NODE_ENV === "production" &&
    !String(env.ATHENA_CLICKHOUSE_PASSWORD_FILE || "").trim()
  )
    findings.push(
      "Production ClickHouse credentials must come from ATHENA_CLICKHOUSE_PASSWORD_FILE."
    );
  if (
    env.NODE_ENV === "production" &&
    String(env.ATHENA_CLICKHOUSE_PASSWORD_FILE || "").trim()
  ) {
    try {
      const stat = fs.statSync(env.ATHENA_CLICKHOUSE_PASSWORD_FILE);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0)
        findings.push(
          "Production ClickHouse credential file must be a private regular file."
        );
    } catch {
      findings.push(
        "Production ClickHouse credential file is missing or unreadable."
      );
    }
  }
  return findings;
}

module.exports = { operationsConfig, operationsSecurityFindings, readSecret };
