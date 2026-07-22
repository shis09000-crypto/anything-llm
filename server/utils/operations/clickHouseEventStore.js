const { operationsConfig } = require("./config");

function assertIdentifier(value, label) {
  const normalized = String(value || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    const error = new Error(`clickhouse_invalid_${label}`);
    error.code = "CLICKHOUSE_INVALID_IDENTIFIER";
    throw error;
  }
  return normalized;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function clickHouseDateTime64(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error("clickhouse_invalid_event_timestamp");
    error.code = "CLICKHOUSE_INVALID_EVENT_TIMESTAMP";
    throw error;
  }
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function eventRow(event) {
  return {
    schema_name: event.schema,
    schema_version: event.schemaVersion,
    event_id: event.eventId,
    event_type: event.eventType,
    category: event.category,
    severity: event.severity,
    outcome: event.outcome,
    occurred_at: clickHouseDateTime64(event.occurredAt),
    observed_at: clickHouseDateTime64(event.observedAt || event.occurredAt),
    producer_service: event.producer?.service || "unknown",
    producer_version: event.producer?.version || "unknown",
    runtime_role: event.producer?.runtimeRole || "unknown",
    subject_type: event.subject?.type || "",
    subject_id: event.subject?.id || "",
    subject_component: event.subject?.component || "",
    actor_type: event.actor?.type || "",
    actor_id: event.actor?.id || "",
    operation_id: event.correlation?.operationId || "",
    interaction_id: event.correlation?.interactionId || "",
    request_id: event.correlation?.requestId || "",
    trace_id: event.correlation?.traceId || "",
    span_id: event.correlation?.spanId || "",
    source_action_id: event.correlation?.sourceActionId || "",
    client_turn_id: event.correlation?.clientTurnId || "",
    invocation_id: event.correlation?.invocationId || "",
    tool_call_id: event.correlation?.toolCallId || "",
    impact_json: json(event.impact || {}),
    evidence_json: json(event.evidence || []),
    hypotheses_json: json(event.hypotheses || []),
    recommendation_json: json(event.recommendation || {}),
    state_transition_json: json(event.stateTransition || {}),
    metadata_json: json(event.metadata || {}),
    sensitivity: event.sensitivity,
    retention_class: event.retentionClass,
  };
}

class ClickHouseEventStore {
  constructor(env = process.env) {
    this.env = env;
    this.config = operationsConfig(env).clickhouse;
    this.lastError = null;
    this.inserted = 0;
    this.startedAt = null;
  }

  database() {
    return assertIdentifier(this.config.database, "database");
  }

  table() {
    return assertIdentifier(this.config.table, "table");
  }

  async request(query, { body = "", params = {}, database = true } = {}) {
    if (!this.config.configured) {
      const error = new Error("clickhouse_not_configured");
      error.code = "CLICKHOUSE_NOT_CONFIGURED";
      throw error;
    }
    const url = new URL(this.config.url);
    url.searchParams.set("query", query);
    if (database) url.searchParams.set("database", this.database());
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(`param_${key}`, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...(this.config.user
            ? {
                Authorization: `Basic ${Buffer.from(
                  `${this.config.user}:${this.config.password}`
                ).toString("base64")}`,
              }
            : {}),
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`clickhouse_http_${response.status}`);
        error.code = "CLICKHOUSE_HTTP_ERROR";
        error.statusCode = response.status;
        error.detail = text.slice(0, 240);
        throw error;
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureSchema() {
    if (!this.config.configured) return false;
    await this.request(`CREATE DATABASE IF NOT EXISTS ${this.database()}`, {
      database: false,
    });
    await this.request(`
      CREATE TABLE IF NOT EXISTS ${this.table()} (
        schema_name LowCardinality(String),
        schema_version LowCardinality(String),
        event_id String,
        event_type LowCardinality(String),
        category LowCardinality(String),
        severity LowCardinality(String),
        outcome LowCardinality(String),
        occurred_at DateTime64(3, 'UTC'),
        observed_at DateTime64(3, 'UTC'),
        producer_service LowCardinality(String),
        producer_version String,
        runtime_role LowCardinality(String),
        subject_type LowCardinality(String),
        subject_id String,
        subject_component LowCardinality(String),
        actor_type LowCardinality(String),
        actor_id String,
        operation_id String,
        interaction_id String,
        request_id String,
        trace_id String,
        span_id String,
        source_action_id String,
        client_turn_id String,
        invocation_id String,
        tool_call_id String,
        impact_json String,
        evidence_json String,
        hypotheses_json String,
        recommendation_json String,
        state_transition_json String,
        metadata_json String,
        sensitivity LowCardinality(String),
        retention_class LowCardinality(String),
        INDEX idx_operation operation_id TYPE bloom_filter GRANULARITY 4,
        INDEX idx_subject subject_id TYPE bloom_filter GRANULARITY 4,
        INDEX idx_trace trace_id TYPE bloom_filter GRANULARITY 4
      ) ENGINE = ReplacingMergeTree(observed_at)
      PARTITION BY toYYYYMM(occurred_at)
      ORDER BY (event_id)
      TTL occurred_at + INTERVAL 180 DAY DELETE
      SETTINGS index_granularity = 8192
    `);
    this.startedAt = new Date().toISOString();
    return true;
  }

  async insert(event) {
    const row = eventRow(event);
    try {
      await this.request(`INSERT INTO ${this.table()} FORMAT JSONEachRow`, {
        body: `${JSON.stringify(row)}\n`,
      });
      this.inserted += 1;
      return true;
    } catch (error) {
      this.lastError = error?.code || error?.message || String(error);
      throw error;
    }
  }

  async timeline({
    after,
    before,
    eventType,
    eventId,
    subjectId,
    operationId,
    limit = 100,
  } = {}) {
    const filters = [];
    const params = {};
    if (after) {
      filters.push("occurred_at >= parseDateTime64BestEffort({after:String})");
      params.after = after;
    }
    if (before) {
      filters.push("occurred_at <= parseDateTime64BestEffort({before:String})");
      params.before = before;
    }
    if (eventType) {
      filters.push("event_type = {eventType:String}");
      params.eventType = eventType;
    }
    if (eventId) {
      filters.push("event_id = {eventId:String}");
      params.eventId = eventId;
    }
    if (subjectId) {
      filters.push("subject_id = {subjectId:String}");
      params.subjectId = subjectId;
    }
    if (operationId) {
      filters.push("operation_id = {operationId:String}");
      params.operationId = operationId;
    }
    const bounded = Math.max(1, Math.min(Number(limit) || 100, 500));
    const query = `
      SELECT * FROM ${this.table()} FINAL
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY occurred_at DESC
      LIMIT ${bounded}
      FORMAT JSONEachRow
    `;
    const text = await this.request(query, { params });
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  health() {
    return {
      configured: this.config.configured,
      ready: Boolean(this.startedAt) && !this.lastError,
      startedAt: this.startedAt,
      inserted: this.inserted,
      lastError: this.lastError,
    };
  }
}

module.exports = { ClickHouseEventStore, clickHouseDateTime64, eventRow };
