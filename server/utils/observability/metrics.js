const client = require("prom-client");
const fs = require("fs");

const registry = new client.Registry();
registry.setDefaultLabels({
  service: process.env.OTEL_SERVICE_NAME || "athena-server",
  runtime_role: process.env.ATHENA_RUNTIME_ROLE || "api",
  app_env:
    process.env.APP_ENV ||
    (process.env.NODE_ENV === "production" ? "production" : "development"),
});
client.collectDefaultMetrics({ register: registry, prefix: "athena_node_" });

const httpRequests = new client.Counter({
  name: "athena_http_requests_total",
  help: "HTTP requests completed by the Athena API.",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});
const httpDuration = new client.Histogram({
  name: "athena_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
const httpBytes = new client.Counter({
  name: "athena_http_bytes_total",
  help: "HTTP request and response bytes.",
  labelNames: ["direction"],
  registers: [registry],
});
const syncOutboxEvents = new client.Counter({
  name: "athena_sync_outbox_events_total",
  help: "Sync V2 Outbox lifecycle transitions.",
  labelNames: ["action"],
  registers: [registry],
});
const syncOutboxPending = new client.Gauge({
  name: "athena_sync_outbox_pending",
  help: "Current number of pending Sync V2 Outbox events.",
  registers: [registry],
});
const syncOutboxOldestAge = new client.Gauge({
  name: "athena_sync_outbox_oldest_age_seconds",
  help: "Age of the oldest pending Sync V2 Outbox event.",
  registers: [registry],
});
const syncOutboxRetrying = new client.Gauge({
  name: "athena_sync_outbox_retrying",
  help: "Current number of retrying Sync V2 Outbox events.",
  registers: [registry],
});
const syncOutboxDeadLetters = new client.Gauge({
  name: "athena_sync_outbox_dead_letters",
  help: "Current number of Sync V2 Outbox dead-letter events.",
  registers: [registry],
});
const syncReceiptEvents = new client.Counter({
  name: "athena_sync_mutation_receipts_total",
  help: "Mutation receipt recovery lifecycle transitions.",
  labelNames: ["action"],
  registers: [registry],
});
const syncReceiptPending = new client.Gauge({
  name: "athena_sync_mutation_receipts_pending",
  help: "Current mutation receipt count by recoverability state.",
  labelNames: ["status"],
  registers: [registry],
});
const syncCursorLag = new client.Histogram({
  name: "athena_sync_cursor_lag_events",
  help: "Client ACK cursor lag behind the current Outbox checkpoint.",
  labelNames: ["platform"],
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 5000],
  registers: [registry],
});
const securityAuditEvents = new client.Counter({
  name: "athena_security_audit_events_total",
  help: "Security audit ledger append outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const securityAuditChainValid = new client.Gauge({
  name: "athena_security_audit_chain_valid",
  help: "Whether the most recent security audit chain verification passed.",
  registers: [registry],
});
const securityAuditArchiveHealthy = new client.Gauge({
  name: "athena_security_audit_archive_healthy",
  help: "Whether immutable archive and SIEM delivery last completed successfully.",
  registers: [registry],
});
const deviceAttestationOperations = new client.Counter({
  name: "athena_device_attestation_operations_total",
  help: "Device attestation challenge and verification outcomes.",
  labelNames: ["operation", "outcome", "provider"],
  registers: [registry],
});
const keyRotationOperations = new client.Counter({
  name: "athena_key_rotation_operations_total",
  help: "Key rotation maker-checker and execution outcomes.",
  labelNames: ["operation", "outcome"],
  registers: [registry],
});
const keyCustodyOperations = new client.Counter({
  name: "athena_key_custody_operations_total",
  help: "Remote and local Key Custody operations without key material labels.",
  labelNames: ["operation", "outcome", "runtime_role"],
  registers: [registry],
});
const keyCustodyLocalMaterialReads = new client.Counter({
  name: "athena_key_custody_local_material_reads_total",
  help: "Local platform-key material resolution attempts outside Key Custody.",
  labelNames: ["outcome", "runtime_role"],
  registers: [registry],
});
const decryptOnlyKeyReads = new client.Counter({
  name: "athena_decrypt_only_key_reads_total",
  help: "Successful reads served by legacy decrypt-only data keys.",
  labelNames: ["key_id", "domain", "runtime_role"],
  registers: [registry],
});
const cryptoSuiteOperations = new client.Counter({
  name: "athena_crypto_suite_operations_total",
  help: "Cryptographic operations by registered suite and purpose.",
  labelNames: ["purpose", "suite", "operation", "outcome"],
  registers: [registry],
});
const cryptoSignatureVerificationDuration = new client.Histogram({
  name: "athena_crypto_signature_verification_duration_seconds",
  help: "Classical and post-quantum signature verification duration.",
  labelNames: ["family", "suite", "outcome"],
  buckets: [
    0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25,
    0.5, 1,
  ],
  registers: [registry],
});
const cryptoVerificationFailures = new client.Counter({
  name: "athena_crypto_verification_failures_total",
  help: "Cryptographic verification failures grouped by bounded reason.",
  labelNames: ["reason", "family"],
  registers: [registry],
});
const cryptoTlsNegotiations = new client.Counter({
  name: "athena_crypto_tls_negotiations_total",
  help: "Observed hybrid and classical TLS negotiation outcomes.",
  labelNames: ["channel", "outcome"],
  registers: [registry],
});
const cryptoTlsHandshakeDuration = new client.Histogram({
  name: "athena_crypto_tls_handshake_duration_seconds",
  help: "Observed edge TLS handshake duration for bounded rollout cohorts.",
  labelNames: ["cohort", "outcome"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});
const cryptoTlsTtfbDuration = new client.Histogram({
  name: "athena_crypto_tls_ttfb_duration_seconds",
  help: "Observed edge TLS time to first byte for bounded rollout cohorts.",
  labelNames: ["cohort", "outcome"],
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});
const cryptoTlsClientCompatibility = new client.Counter({
  name: "athena_crypto_tls_client_compatibility_total",
  help: "Bounded client compatibility outcomes for hybrid edge TLS.",
  labelNames: ["client_class", "outcome", "reason"],
  registers: [registry],
});
const cryptoTlsEdgeCpuUtilization = new client.Gauge({
  name: "athena_crypto_tls_edge_cpu_utilization_ratio",
  help: "Provider-reported edge CPU utilization for a rollout cohort.",
  labelNames: ["cohort"],
  registers: [registry],
});
const cryptoTlsRolloutPercent = new client.Gauge({
  name: "athena_crypto_tls_rollout_percent",
  help: "Desired strict hybrid TLS cohort percentage owned by the edge.",
  registers: [registry],
});
const cryptoVaultKemOperations = new client.Counter({
  name: "athena_crypto_vault_kem_operations_total",
  help: "Vault hybrid KEM lifecycle and client unseal outcomes.",
  labelNames: ["operation", "outcome"],
  registers: [registry],
});
const cryptoCertificateRemaining = new client.Gauge({
  name: "athena_crypto_certificate_remaining_seconds",
  help: "Remaining validity of workload identity certificates.",
  labelNames: ["role", "slot"],
  registers: [registry],
});
const cryptoDeviceEpochConflicts = new client.Counter({
  name: "athena_crypto_device_epoch_conflicts_total",
  help: "Rejected device key epochs grouped by bounded conflict kind.",
  labelNames: ["kind"],
  registers: [registry],
});
const cryptoRuntimePqCapability = new client.Gauge({
  name: "athena_crypto_runtime_pq_capability",
  help: "Current Node runtime post-quantum capability availability.",
  labelNames: ["capability"],
  registers: [registry],
});
const cryptoRuntimePqCapabilityExpected = new client.Gauge({
  name: "athena_crypto_runtime_pq_capability_expected",
  help: "Policy baseline for Node runtime post-quantum capabilities.",
  labelNames: ["capability"],
  registers: [registry],
});
const cryptoRuntimePqCapabilityDrift = new client.Gauge({
  name: "athena_crypto_runtime_pq_capability_drift",
  help: "Whether a Node runtime post-quantum capability differs from policy.",
  labelNames: ["capability"],
  registers: [registry],
});
const pluginPolicyDecisions = new client.Counter({
  name: "athena_plugin_policy_decisions_total",
  help: "Plugin and scheduled tool capability decisions.",
  labelNames: ["kind", "decision"],
  registers: [registry],
});
const cryptoAccountReads = new client.Counter({
  name: "athena_crypto_account_reads_total",
  help: "Private crypto account reads grouped by bounded function and outcome.",
  labelNames: ["function", "outcome"],
  registers: [registry],
});
const cryptoAccountApprovals = new client.Counter({
  name: "athena_crypto_account_approvals_total",
  help: "Private crypto account approval outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const cryptoAccountReadDuration = new client.Histogram({
  name: "athena_crypto_account_read_duration_seconds",
  help: "Private crypto account read latency grouped by bounded function and outcome.",
  labelNames: ["function", "outcome"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
const cryptoAccountEquitySamples = new client.Counter({
  name: "athena_crypto_account_equity_samples_total",
  help: "Protected private-account equity sampling outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const cryptoForecastEvents = new client.Counter({
  name: "athena_crypto_forecast_events_total",
  help: "Public crypto forecasting lifecycle events.",
  labelNames: ["action", "symbol", "horizon", "status"],
  registers: [registry],
});
const cryptoForecastCollectorLag = new client.Gauge({
  name: "athena_crypto_forecast_collector_lag_seconds",
  help: "Age of the newest persisted public market bar.",
  labelNames: ["symbol"],
  registers: [registry],
});
const cryptoForecastStoreBytes = new client.Gauge({
  name: "athena_crypto_forecast_store_bytes",
  help: "Bytes used by the isolated crypto forecasting store.",
  registers: [registry],
});
const cryptoForecastModelAvailable = new client.Gauge({
  name: "athena_crypto_forecast_model_available",
  help: "Whether a verified crypto forecast model is loaded.",
  registers: [registry],
});
const cryptoForecastInferenceDuration = new client.Histogram({
  name: "athena_crypto_forecast_inference_duration_seconds",
  help: "Crypto forecast feature extraction and inference duration.",
  labelNames: ["horizon", "status"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});
const cryptoForecastContractStatus = new client.Gauge({
  name: "athena_crypto_forecast_contract_status",
  help: "Whether a bounded crypto forecast evidence contract is valid.",
  labelNames: ["contract"],
  registers: [registry],
});
const cryptoForecastPassportEvents = new client.Counter({
  name: "athena_crypto_forecast_passport_events_total",
  help: "Prediction Passport generation and replay outcomes.",
  labelNames: ["action", "outcome"],
  registers: [registry],
});
const cryptoForecastMicrostructureEvents = new client.Counter({
  name: "athena_crypto_forecast_microstructure_events_total",
  help: "Bounded Binance microstructure gap, resync, and failure events.",
  labelNames: ["action", "symbol"],
  registers: [registry],
});
const cryptoForecastMicrostructureFreshness = new client.Gauge({
  name: "athena_crypto_forecast_microstructure_freshness_seconds",
  help: "Age of the latest Binance public microstructure event.",
  labelNames: ["symbol"],
  registers: [registry],
});
const cryptoForecastMicrostructureCoverage = new client.Gauge({
  name: "athena_crypto_forecast_microstructure_sampling_coverage",
  help: "Fraction of seconds sampled in the current minute.",
  labelNames: ["symbol"],
  registers: [registry],
});
const cryptoForecastAnomalyArchiveBytes = new client.Gauge({
  name: "athena_crypto_forecast_anomaly_archive_bytes",
  help: "Bytes retained in bounded raw anomaly windows.",
  registers: [registry],
});
const goldAnalysisRuns = new client.Counter({
  name: "athena_gold_analysis_runs_total",
  help: "GQSS gold analysis executions grouped by bounded outcome.",
  labelNames: ["outcome"],
  registers: [registry],
});
const goldAnalysisDuration = new client.Histogram({
  name: "athena_gold_analysis_duration_seconds",
  help: "End-to-end GQSS gold analysis duration.",
  labelNames: ["outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 8, 15, 30],
  registers: [registry],
});
const goldAnalysisSourceAvailable = new client.Gauge({
  name: "athena_gold_analysis_source_available",
  help: "Whether a bounded public gold-analysis source succeeded in the latest run.",
  labelNames: ["source"],
  registers: [registry],
});
const goldAnalysisStoreBytes = new client.Gauge({
  name: "athena_gold_analysis_store_bytes",
  help: "Bytes used by the isolated GQSS gold analysis store.",
  registers: [registry],
});
const goldAnalysisShadowEvents = new client.Counter({
  name: "athena_gold_analysis_shadow_events_total",
  help: "Gold shadow-research lifecycle events.",
  labelNames: ["action", "status"],
  registers: [registry],
});
const browserSessions = new client.Counter({
  name: "athena_browser_sessions_total",
  help: "Browser Plane session lifecycle events by bounded driver and outcome.",
  labelNames: ["driver", "action", "outcome"],
  registers: [registry],
});
const browserActions = new client.Counter({
  name: "athena_browser_actions_total",
  help: "Browser actions by bounded action category, driver and outcome.",
  labelNames: ["action", "driver", "outcome"],
  registers: [registry],
});
const browserActionDuration = new client.Histogram({
  name: "athena_browser_action_duration_seconds",
  help: "Browser action latency by bounded action category and driver.",
  labelNames: ["action", "driver", "outcome"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 6, 10, 30],
  registers: [registry],
});
const browserActiveSessions = new client.Gauge({
  name: "athena_browser_active_sessions",
  help: "Current active browser sessions by driver.",
  labelNames: ["driver"],
  registers: [registry],
});
const browserWorkerAvailableMemory = new client.Gauge({
  name: "athena_browser_worker_available_memory_bytes",
  help: "Memory available to the Browser Worker resource guard.",
  registers: [registry],
});
const browserApprovals = new client.Counter({
  name: "athena_browser_approvals_total",
  help: "Browser action approval decisions by bounded risk and outcome.",
  labelNames: ["risk", "outcome"],
  registers: [registry],
});
const browserEgressGrants = new client.Counter({
  name: "athena_browser_egress_grants_total",
  help: "Browser egress grant lifecycle outcomes.",
  labelNames: ["action", "outcome"],
  registers: [registry],
});
const browserEgressGatewayReady = new client.Gauge({
  name: "athena_browser_egress_gateway_ready",
  help: "Whether the Browser Egress Gateway passed its bounded health contract.",
  registers: [registry],
});
const browserEgressEnabled = new client.Gauge({
  name: "athena_browser_egress_enabled",
  help: "Whether Browser Egress is explicitly enabled for production grants.",
  registers: [registry],
});
const browserEgressHandshakeLatency = new client.Histogram({
  name: "athena_browser_egress_handshake_duration_seconds",
  help: "Last observed Browser Egress handshake duration.",
  labelNames: ["outcome"],
  buckets: [0.01, 0.03, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
const browserEgressFailures = new client.Counter({
  name: "athena_browser_egress_failures_total",
  help: "Browser Egress failures by bounded operation and error code.",
  labelNames: ["operation", "code"],
  registers: [registry],
});
const browserCrashes = new client.Counter({
  name: "athena_browser_crashes_total",
  help: "Unexpected Browser driver exits by bounded driver and failure class.",
  labelNames: ["driver", "failure_class"],
  registers: [registry],
});
const runtimeShutdowns = new client.Counter({
  name: "athena_runtime_shutdowns_total",
  help: "Runtime shutdown outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const realtimeMessages = new client.Counter({
  name: "athena_realtime_messages_total",
  help: "Realtime WebSocket and SSE control messages.",
  labelNames: ["transport", "direction", "type"],
  registers: [registry],
});
const authSessionReconciles = new client.Counter({
  name: "athena_auth_session_reconcile_total",
  help: "Auth DB to Sync V2 authority reconciliation outcomes.",
  labelNames: ["outcome"],
  registers: [registry],
});
const authSessionRecoveryAttempts = new client.Counter({
  name: "athena_auth_session_recovery_total",
  help: "Device-bound auth session recovery outcomes.",
  labelNames: ["stage", "outcome", "reason"],
  registers: [registry],
});
const authSessionRecoveryDuration = new client.Histogram({
  name: "athena_auth_session_recovery_duration_seconds",
  help: "Device-bound auth session recovery duration.",
  labelNames: ["outcome"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});
const authClientIdentityRecoveryRequired = new client.Counter({
  name: "athena_auth_client_identity_recovery_required_total",
  help: "Requests requiring explicit client identity recovery.",
  labelNames: ["reason"],
  registers: [registry],
});
const authRouteGuardRecovery = new client.Counter({
  name: "athena_auth_route_guard_recovery_total",
  help: "Route guard recovery starts and login fallbacks.",
  labelNames: ["outcome", "reason"],
  registers: [registry],
});
const authActiveSessionsPerClient = new client.Histogram({
  name: "athena_auth_active_sessions_per_client",
  help: "Active session count observed for one account client after login.",
  labelNames: [],
  buckets: [1, 2, 3, 4, 5, 8, 13, 21],
  registers: [registry],
});
const natsEvents = new client.Counter({
  name: "athena_nats_events_total",
  help: "NATS JetStream transport outcomes.",
  labelNames: ["action", "outcome"],
  registers: [registry],
});
const natsConsumerLag = new client.Gauge({
  name: "athena_nats_consumer_lag",
  help: "Pending JetStream messages for the local durable consumer.",
  labelNames: ["consumer"],
  registers: [registry],
});
const contentObjectOperations = new client.Counter({
  name: "athena_content_object_operations_total",
  help: "Encrypted content object lifecycle outcomes.",
  labelNames: ["operation", "outcome", "provider"],
  registers: [registry],
});
const contentObjectBytes = new client.Counter({
  name: "athena_content_object_bytes_total",
  help: "Plaintext bytes moved through the encrypted content object plane.",
  labelNames: ["direction", "domain"],
  registers: [registry],
});
const aiExecutions = new client.Counter({
  name: "athena_ai_executions_total",
  help: "Governed model execution outcomes.",
  labelNames: ["task", "provider", "outcome"],
  registers: [registry],
});
const aiTokens = new client.Counter({
  name: "athena_ai_tokens_total",
  help: "Provider-reported AI token usage.",
  labelNames: ["provider", "direction"],
  registers: [registry],
});
const aiCostMicros = new client.Counter({
  name: "athena_ai_cost_micros_total",
  help: "Catalog-derived AI cost in millionths of the configured currency.",
  labelNames: ["provider"],
  registers: [registry],
});
const semanticEvents = new client.Counter({
  name: "athena_semantic_events_total",
  help: "Semantic Event v1 records emitted by category and severity.",
  labelNames: ["category", "severity"],
  registers: [registry],
});
const aicpShadowObservations = new client.Counter({
  name: "athena_aicp_shadow_observations_total",
  help: "Metadata-only AICP shadow observations by kind and outcome.",
  labelNames: ["kind", "outcome"],
  registers: [registry],
});
const aicpShadowTraceCoverage = new client.Counter({
  name: "athena_aicp_shadow_trace_coverage_total",
  help: "Trace correlation coverage for AICP shadow observations.",
  labelNames: ["kind", "coverage"],
  registers: [registry],
});
const operationsEvents = new client.Counter({
  name: "athena_operations_events_total",
  help: "AI Operations Plane event lifecycle outcomes.",
  labelNames: ["stage", "outcome"],
  registers: [registry],
});
const operationsRetryQueue = new client.Gauge({
  name: "athena_operations_retry_queue",
  help: "Semantic events waiting for Operations Plane delivery.",
  registers: [registry],
});
const operationsConsumerLag = new client.Gauge({
  name: "athena_operations_consumer_lag",
  help: "Pending Operations JetStream events for the ClickHouse consumer.",
  registers: [registry],
});
const operationsConsumerStreamSequence = new client.Gauge({
  name: "athena_operations_consumer_stream_sequence",
  help: "Latest stream sequence delivered to the Operations consumer.",
  registers: [registry],
});
const operationsConsumerAckFloor = new client.Gauge({
  name: "athena_operations_consumer_ack_floor_stream_sequence",
  help: "Latest stream sequence acknowledged by the Operations consumer.",
  registers: [registry],
});
const operationsConsumerAckPending = new client.Gauge({
  name: "athena_operations_consumer_ack_pending",
  help: "Operations consumer messages delivered but not yet acknowledged.",
  registers: [registry],
});
const operationsConsumerRedeliveries = new client.Gauge({
  name: "athena_operations_consumer_redeliveries",
  help: "Operations consumer messages currently marked as redelivered.",
  registers: [registry],
});
const operationsClickHouseLastSuccess = new client.Gauge({
  name: "athena_operations_clickhouse_last_success_timestamp_seconds",
  help: "Unix timestamp of the latest successful ClickHouse event batch.",
  registers: [registry],
});
const operationsClickHouseBatchSize = new client.Histogram({
  name: "athena_operations_clickhouse_batch_size",
  help: "Number of semantic events in a ClickHouse insert batch.",
  buckets: [1, 4, 16, 32, 64, 128, 256],
  registers: [registry],
});
const operationsClickHouseWriteDuration = new client.Histogram({
  name: "athena_operations_clickhouse_write_duration_seconds",
  help: "Duration of confirmed ClickHouse semantic event batch writes.",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
const operationsCircuitBreakerOpen = new client.Gauge({
  name: "athena_operations_clickhouse_circuit_breaker_open",
  help: "Whether the Operations ClickHouse consumer circuit is open.",
  registers: [registry],
});
const operationsConsecutiveFailures = new client.Gauge({
  name: "athena_operations_clickhouse_consecutive_failures",
  help: "Consecutive failed Operations ClickHouse batch attempts.",
  registers: [registry],
});
const operationsDlqEvents = new client.Counter({
  name: "athena_operations_dlq_events_total",
  help: "Permanently invalid Operations messages persisted to the DLQ.",
  labelNames: ["reason"],
  registers: [registry],
});
const operationsDlqMessages = new client.Gauge({
  name: "athena_operations_dlq_messages",
  help: "Current number of retained Operations DLQ messages.",
  registers: [registry],
});
const operationsShadowAgentRuns = new client.Counter({
  name: "athena_operations_shadow_agent_runs_total",
  help: "Read-only Operations Agent shadow evaluation and scan outcomes.",
  labelNames: ["agent", "outcome"],
  registers: [registry],
});
const operationsShadowFindings = new client.Counter({
  name: "athena_operations_shadow_findings_total",
  help: "Advisory-only findings produced by Operations Agents in shadow mode.",
  labelNames: ["agent", "severity"],
  registers: [registry],
});
const operationsShadowEvaluation = new client.Gauge({
  name: "athena_operations_shadow_evaluation",
  help: "Versioned incident-corpus evaluation scores for shadow Operations Agents.",
  labelNames: ["metric", "agent"],
  registers: [registry],
});
const operationsActionStages = new client.Counter({
  name: "athena_operations_action_stages_total",
  help: "Controlled Operations Action lifecycle stages and outcomes.",
  labelNames: ["action", "stage", "outcome"],
  registers: [registry],
});
const operationsActionDuration = new client.Histogram({
  name: "athena_operations_action_duration_seconds",
  help: "End-to-end duration of approved controlled Operations Actions.",
  labelNames: ["action", "outcome"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900],
  registers: [registry],
});
const operationsActionRollbacks = new client.Counter({
  name: "athena_operations_action_rollbacks_total",
  help: "Automatic rollback outcomes for controlled Operations Actions.",
  labelNames: ["action", "outcome"],
  registers: [registry],
});
const operationCorrelation = new client.Counter({
  name: "athena_operation_context_total",
  help: "Instrumented operations partitioned by correlation coverage.",
  labelNames: ["component", "journey", "coverage"],
  registers: [registry],
});
const dataAccessOperations = new client.Counter({
  name: "athena_data_access_operations_total",
  help: "DataAccessCenter operation outcomes.",
  labelNames: ["domain", "access_type", "outcome"],
  registers: [registry],
});
const dataAccessDuration = new client.Histogram({
  name: "athena_data_access_duration_seconds",
  help: "DataAccessCenter operation duration in seconds.",
  labelNames: ["domain", "access_type", "outcome"],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
const databaseOperations = new client.Counter({
  name: "athena_database_operations_total",
  help: "Prisma database operation outcomes.",
  labelNames: ["system", "operation", "outcome"],
  registers: [registry],
});
const databaseDuration = new client.Histogram({
  name: "athena_database_operation_duration_seconds",
  help: "Prisma database operation duration in seconds.",
  labelNames: ["system", "operation", "outcome"],
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
const modelOperations = new client.Counter({
  name: "athena_model_operations_total",
  help: "LLM and Agent model invocation outcomes.",
  labelNames: ["task", "provider", "outcome"],
  registers: [registry],
});
const modelDuration = new client.Histogram({
  name: "athena_model_operation_duration_seconds",
  help: "LLM and Agent model invocation duration in seconds.",
  labelNames: ["task", "provider", "outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [registry],
});
const ragOperations = new client.Counter({
  name: "athena_rag_operations_total",
  help: "RAG retrieval and index operation outcomes.",
  labelNames: ["operation", "backend", "outcome"],
  registers: [registry],
});
const ragDuration = new client.Histogram({
  name: "athena_rag_operation_duration_seconds",
  help: "RAG retrieval and index operation duration in seconds.",
  labelNames: ["operation", "backend", "outcome"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});
const agentToolOperations = new client.Counter({
  name: "athena_agent_tool_operations_total",
  help: "Agent tool execution outcomes.",
  labelNames: ["tool", "outcome"],
  registers: [registry],
});
const agentToolDuration = new client.Histogram({
  name: "athena_agent_tool_duration_seconds",
  help: "Agent tool execution duration in seconds.",
  labelNames: ["tool", "outcome"],
  buckets: [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
  ],
  registers: [registry],
});
const goldenJourneyOperations = new client.Counter({
  name: "athena_golden_journey_operations_total",
  help: "Golden journey completion outcomes.",
  labelNames: ["journey", "outcome"],
  registers: [registry],
});
const goldenJourneyDuration = new client.Histogram({
  name: "athena_golden_journey_duration_seconds",
  help: "Golden journey end-to-end duration in seconds.",
  labelNames: ["journey", "outcome"],
  buckets: [
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600,
  ],
  registers: [registry],
});
const goldenJourneyMilestones = new client.Histogram({
  name: "athena_golden_journey_milestone_seconds",
  help: "Time from journey start to a named user-visible milestone.",
  labelNames: ["journey", "milestone"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [registry],
});
const chatClientStreamEvents = new client.Counter({
  name: "athena_chat_client_stream_events_total",
  help: "Metadata-only client chat stream lifecycle and rendering events.",
  labelNames: ["event", "platform", "visibility", "outcome"],
  registers: [registry],
});
const chatClientReceiveToPaint = new client.Histogram({
  name: "athena_chat_client_receive_to_paint_seconds",
  help: "Client delay from receiving a chat revision to painting it.",
  labelNames: ["platform", "visibility"],
  buckets: [0.016, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});
const chatClientBacklog = new client.Histogram({
  name: "athena_chat_client_unpainted_backlog_seconds",
  help: "Maximum age of received but not yet painted chat revisions.",
  labelNames: ["platform", "visibility"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
const chatClientLongTasks = new client.Histogram({
  name: "athena_chat_client_long_task_seconds",
  help: "Browser main-thread long tasks observed during chat generation.",
  labelNames: ["platform"],
  buckets: [0.05, 0.08, 0.12, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
const clientUiEvents = new client.Counter({
  name: "athena_client_ui_events_total",
  help: "Metadata-only client UI lifecycle and recovery events.",
  labelNames: ["event", "surface", "platform", "visibility", "outcome"],
  registers: [registry],
});

function routeLabel(request) {
  const route = request.route?.path;
  if (route) return `${request.baseUrl || ""}${route}`.slice(0, 180);
  // Do not turn arbitrary user-controlled slugs or unknown paths into metric
  // labels. Exact route templates are available once Express matched a route;
  // everything else shares a bounded fallback label.
  return "unmatched";
}

function observeHttp({
  request,
  statusCode,
  durationMs,
  requestBytes,
  responseBytes,
}) {
  const labels = {
    method: String(request.method || "UNKNOWN").toUpperCase(),
    route: routeLabel(request),
    status_code: String(statusCode || 0),
  };
  httpRequests.inc(labels);
  httpDuration.observe(labels, Math.max(Number(durationMs) || 0, 0) / 1000);
  httpBytes.inc(
    { direction: "request" },
    Math.max(Number(requestBytes) || 0, 0)
  );
  httpBytes.inc(
    { direction: "response" },
    Math.max(Number(responseBytes) || 0, 0)
  );
}

function isLoopback(address = "") {
  const normalized = String(address || "").replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function metricsRequestAuthorized(request) {
  let configured = String(process.env.ATHENA_METRICS_TOKEN || "").trim();
  const tokenFile = String(process.env.ATHENA_METRICS_TOKEN_FILE || "").trim();
  if (!configured && tokenFile) {
    try {
      configured = fs.readFileSync(tokenFile, "utf8").trim();
    } catch {
      configured = "";
    }
  }
  if (!configured) {
    if (process.env.NODE_ENV !== "production") return true;
    return (
      process.env.ATHENA_METRICS_ALLOW_LOOPBACK === "true" &&
      isLoopback(request.socket?.remoteAddress)
    );
  }
  const header = String(request.headers.authorization || "");
  const candidate = header.startsWith("Bearer ")
    ? header.slice(7)
    : String(request.headers["x-athena-metrics-token"] || "");
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return (
    left.length === right.length &&
    left.length > 0 &&
    require("crypto").timingSafeEqual(left, right)
  );
}

async function metricsEndpoint(request, response) {
  if (!metricsRequestAuthorized(request)) {
    return response
      .status(403)
      .json({ success: false, error: "metrics_forbidden" });
  }
  // These refreshers are deliberately lazy to keep the metrics registry free
  // from a dependency cycle with the crypto suite registry.
  require("../security/cryptoObservability").refreshCryptoObservability();
  response.setHeader("Content-Type", registry.contentType);
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).send(await registry.metrics());
}

module.exports = {
  metricsEndpoint,
  metricsRequestAuthorized,
  observeHttp,
  registry,
  metrics: {
    aicpShadowObservations,
    aicpShadowTraceCoverage,
    aiCostMicros,
    aiExecutions,
    aiTokens,
    agentToolDuration,
    agentToolOperations,
    authActiveSessionsPerClient,
    authClientIdentityRecoveryRequired,
    authRouteGuardRecovery,
    authSessionRecoveryAttempts,
    authSessionRecoveryDuration,
    authSessionReconciles,
    browserActionDuration,
    browserActions,
    browserActiveSessions,
    browserApprovals,
    browserEgressEnabled,
    browserEgressFailures,
    browserEgressGatewayReady,
    browserEgressGrants,
    browserEgressHandshakeLatency,
    browserCrashes,
    browserSessions,
    browserWorkerAvailableMemory,
    chatClientBacklog,
    chatClientLongTasks,
    chatClientReceiveToPaint,
    chatClientStreamEvents,
    clientUiEvents,
    contentObjectBytes,
    contentObjectOperations,
    cryptoCertificateRemaining,
    cryptoAccountApprovals,
    cryptoAccountEquitySamples,
    cryptoAccountReadDuration,
    cryptoAccountReads,
    cryptoForecastCollectorLag,
    cryptoForecastContractStatus,
    cryptoForecastEvents,
    cryptoForecastInferenceDuration,
    cryptoForecastAnomalyArchiveBytes,
    cryptoForecastMicrostructureCoverage,
    cryptoForecastMicrostructureEvents,
    cryptoForecastMicrostructureFreshness,
    cryptoForecastModelAvailable,
    cryptoForecastPassportEvents,
    cryptoForecastStoreBytes,
    cryptoDeviceEpochConflicts,
    cryptoRuntimePqCapability,
    cryptoRuntimePqCapabilityDrift,
    cryptoRuntimePqCapabilityExpected,
    cryptoSignatureVerificationDuration,
    cryptoSuiteOperations,
    cryptoTlsClientCompatibility,
    cryptoTlsEdgeCpuUtilization,
    cryptoTlsHandshakeDuration,
    cryptoTlsNegotiations,
    cryptoTlsRolloutPercent,
    cryptoTlsTtfbDuration,
    cryptoVaultKemOperations,
    cryptoVerificationFailures,
    deviceAttestationOperations,
    dataAccessDuration,
    dataAccessOperations,
    databaseDuration,
    databaseOperations,
    goldenJourneyDuration,
    goldenJourneyMilestones,
    goldenJourneyOperations,
    goldAnalysisDuration,
    goldAnalysisRuns,
    goldAnalysisShadowEvents,
    goldAnalysisSourceAvailable,
    goldAnalysisStoreBytes,
    decryptOnlyKeyReads,
    keyCustodyLocalMaterialReads,
    keyCustodyOperations,
    keyRotationOperations,
    modelDuration,
    modelOperations,
    natsConsumerLag,
    natsEvents,
    pluginPolicyDecisions,
    realtimeMessages,
    ragDuration,
    ragOperations,
    runtimeShutdowns,
    securityAuditEvents,
    semanticEvents,
    securityAuditChainValid,
    securityAuditArchiveHealthy,
    syncCursorLag,
    syncOutboxEvents,
    syncOutboxOldestAge,
    syncOutboxPending,
    syncOutboxRetrying,
    syncOutboxDeadLetters,
    syncReceiptEvents,
    syncReceiptPending,
    operationCorrelation,
    operationsConsumerLag,
    operationsConsumerStreamSequence,
    operationsConsumerAckFloor,
    operationsConsumerAckPending,
    operationsConsumerRedeliveries,
    operationsClickHouseLastSuccess,
    operationsClickHouseBatchSize,
    operationsClickHouseWriteDuration,
    operationsCircuitBreakerOpen,
    operationsConsecutiveFailures,
    operationsDlqEvents,
    operationsDlqMessages,
    operationsEvents,
    operationsRetryQueue,
    operationsShadowAgentRuns,
    operationsShadowEvaluation,
    operationsShadowFindings,
    operationsActionDuration,
    operationsActionRollbacks,
    operationsActionStages,
  },
};
