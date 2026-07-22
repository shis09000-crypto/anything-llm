CREATE DATABASE IF NOT EXISTS athena_operations;

CREATE TABLE IF NOT EXISTS athena_operations.semantic_events_v1
(
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
)
ENGINE = ReplacingMergeTree(observed_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY event_id
TTL occurred_at + INTERVAL 180 DAY DELETE
SETTINGS index_granularity = 8192;
