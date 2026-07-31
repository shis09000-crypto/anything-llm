#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

function assert(condition, code) {
  if (condition) return;
  const error = new Error(code);
  error.code = code;
  throw error;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(
  predicate,
  { timeoutMs = 15_000, intervalMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function bodyOf(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function startOtlpReceiver() {
  const received = { logs: 0, traces: 0 };
  const server = http.createServer(async (request, response) => {
    const body = await bodyOf(request);
    const payload = body ? JSON.parse(body) : {};
    if (request.url === "/v1/logs")
      received.logs += (payload.resourceLogs || []).reduce(
        (count, resource) =>
          count +
          (resource.scopeLogs || []).reduce(
            (nested, scope) => nested + (scope.logRecords || []).length,
            0
          ),
        0
      );
    if (request.url === "/v1/traces")
      received.traces += (payload.resourceSpans || []).reduce(
        (count, resource) =>
          count +
          (resource.scopeSpans || []).reduce(
            (nested, scope) => nested + (scope.spans || []).length,
            0
          ),
        0
      );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  const address = await listen(server);
  return { server, received, url: `http://127.0.0.1:${address.port}` };
}

function filterRows(rows, url) {
  const value = (name) => url.searchParams.get(`param_${name}`);
  return rows
    .filter((row) => !value("eventId") || row.event_id === value("eventId"))
    .filter(
      (row) => !value("eventType") || row.event_type === value("eventType")
    )
    .filter(
      (row) => !value("subjectId") || row.subject_id === value("subjectId")
    )
    .filter(
      (row) =>
        !value("operationId") || row.operation_id === value("operationId")
    )
    .filter(
      (row) =>
        !value("after") ||
        Date.parse(row.occurred_at) >= Date.parse(value("after"))
    )
    .filter(
      (row) =>
        !value("before") ||
        Date.parse(row.occurred_at) <= Date.parse(value("before"))
    )
    .sort(
      (left, right) =>
        Date.parse(right.occurred_at) - Date.parse(left.occurred_at)
    );
}

async function startClickHouseContractServer({ user, password }) {
  const rows = new Map();
  let schemaRequests = 0;
  const expectedAuthorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    const url = new URL(request.url, "http://127.0.0.1");
    const query = url.searchParams.get("query") || "";
    const body = await bodyOf(request);
    if (/^\s*CREATE\s+/i.test(query)) schemaRequests += 1;
    if (/^\s*INSERT\s+/i.test(query)) {
      for (const line of body.split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        rows.set(row.event_id, row);
      }
    }
    if (/^\s*SELECT\s+/i.test(query)) {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.end(
        filterRows([...rows.values()], url)
          .map((row) => JSON.stringify(row))
          .join("\n")
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("");
  });
  const address = await listen(server);
  return {
    server,
    rows,
    schemaRequests: () => schemaRequests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

class LoopbackJetStreamContract {
  constructor() {
    this.handler = null;
    this.ready = false;
    this.published = 0;
    this.received = 0;
    this.ids = new Set();
  }

  async start(handler) {
    this.handler = handler;
    this.ready = true;
  }

  async publish(event) {
    if (this.ids.has(event.eventId)) return { duplicate: true };
    this.ids.add(event.eventId);
    this.published += 1;
    await this.handler(event);
    this.received += 1;
    return { accepted: true };
  }

  async drain() {
    this.ready = false;
  }

  health() {
    return {
      configured: true,
      ready: this.ready,
      mode: "isolated-loopback-contract",
      published: this.published,
      received: this.received,
      pending: 0,
    };
  }
}

function initializeActionDatabase(root) {
  const Database = require("better-sqlite3");
  const storage = path.join(root, "development");
  fs.mkdirSync(storage, { recursive: true });
  const databasePath = path.join(storage, "anythingllm.db");
  const migration = fs.readFileSync(
    path.resolve(
      __dirname,
      "../prisma/migrations/20260722100000_add_operations_action_control/migration.sql"
    ),
    "utf8"
  );
  const database = new Database(databasePath);
  database.exec(migration);
  database.exec(`
    CREATE TABLE IF NOT EXISTS "system_settings" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "label" TEXT NOT NULL UNIQUE,
      "value" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  database.close();
  return databasePath;
}

function actionFixtures() {
  const outbox = new Map(
    [41, 42, 43].map((seq) => [
      seq,
      {
        seq,
        status: "dead_letter",
        attemptCount: 5,
        lastErrorCode: "acceptance_fixture",
        deadLetteredAt: new Date(),
      },
    ])
  );
  const cache = { refreshes: 0 };
  const worker = {
    running: true,
    generation: 1,
    snapshot() {
      return {
        running: this.running,
        healthy: this.running,
        generation: this.generation,
      };
    },
    async stop() {
      this.running = false;
    },
    async start() {
      this.running = true;
      this.generation += 1;
    },
  };
  const workspace = { id: 901, slug: "ops-acceptance" };
  const documents = [{ docId: "ops-doc-a" }, { docId: "ops-doc-b" }];
  const indexed = new Set();
  const requeueData = {
    syncV2: {
      async deadLetterOutbox({ seqs }) {
        return seqs
          .map((seq) => outbox.get(seq))
          .filter((row) => row?.status === "dead_letter");
      },
      async requeueDeadLetters(seqs) {
        let count = 0;
        for (const seq of seqs) {
          const row = outbox.get(seq);
          if (!row || row.status !== "dead_letter") continue;
          outbox.set(seq, {
            ...row,
            status: "retry",
            attemptCount: 0,
            lastErrorCode: null,
            deadLetteredAt: null,
          });
          count += 1;
        }
        return { count };
      },
      async outboxRows(seqs) {
        return seqs.map((seq) => outbox.get(seq)).filter(Boolean);
      },
      async restoreDeadLetters(snapshots) {
        for (const snapshot of snapshots)
          outbox.set(snapshot.seq, { ...snapshot, status: "dead_letter" });
        return { restored: snapshots.length, skipped: 0 };
      },
    },
  };
  const securityData = {
    adminSystem: {
      authSession: {
        cacheSnapshot: () => ({ sessionEntries: 2, lastSeenEntries: 2 }),
        refreshCache: ({ sessionIds = [] } = {}) => {
          cache.refreshes += 1;
          return {
            scope: sessionIds.length ? "selected" : "all",
            selected: sessionIds.length,
          };
        },
      },
    },
  };
  const knowledgeData = {
    workspace: {
      get: async ({ id }) => (Number(id) === workspace.id ? workspace : null),
    },
    document: {
      forWorkspace: async () => documents,
      reindexDocuments: async (_workspace, docIds) => {
        docIds.forEach((docId) => indexed.add(docId));
        return { rebuilt: [...docIds], failed: [] };
      },
    },
    documentVector: {
      where: async ({ docId }) =>
        docId.in.filter((id) => indexed.has(id)).map((id) => ({ docId: id })),
    },
  };
  const consistency = {
    workspaceRobustnessDiagnostics: async () => ({
      fileHealth: documents.map((document) => ({
        docpath: document.docId,
        exists: true,
        readableJson: true,
      })),
      issues: { dbWithoutVector: [] },
      summary: { documents: documents.length, healthy: true },
    }),
  };
  return {
    cache,
    consistency,
    indexed,
    knowledgeData,
    outbox,
    requeueData,
    securityData,
    worker,
  };
}

async function main() {
  const originalConsoleInfo = console.info;
  console.info = (...args) => {
    if (args[0] === "[semantic-event:v1]") return;
    originalConsoleInfo(...args);
  };
  const liveInfrastructure =
    process.env.ATHENA_OPERATIONS_VERIFY_LIVE === "true";
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "athena-aiops-"));
  process.env.NODE_ENV = "test";
  process.env.APP_ENV = "development";
  process.env.ANYTHINGLLM_STORAGE_BASE_DIR = temporaryRoot;
  process.env.ATHENA_OPERATIONS_ENABLED = "true";
  process.env.ATHENA_OPERATIONS_ACTIONS_ENABLED = "true";
  process.env.ATHENA_OPERATIONS_SHADOW_AGENTS_ENABLED = "true";
  if (!liveInfrastructure)
    process.env.ATHENA_NATS_SERVERS = "nats://127.0.0.1:4222";
  initializeActionDatabase(temporaryRoot);

  const otlp = await startOtlpReceiver();
  process.env.ATHENA_OTEL_ENABLED = "true";
  process.env.OTEL_SERVICE_NAME = "athena-operations-acceptance";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otlp.url;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${otlp.url}/v1/traces`;
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${otlp.url}/v1/logs`;

  let clickhouse = null;
  if (liveInfrastructure) {
    assert(process.env.ATHENA_NATS_SERVERS, "live_nats_servers_not_configured");
    assert(process.env.ATHENA_CLICKHOUSE_URL, "live_clickhouse_not_configured");
  } else {
    const clickhouseUser = "athena_ops_acceptance";
    const clickhousePassword = crypto.randomBytes(24).toString("hex");
    clickhouse = await startClickHouseContractServer({
      user: clickhouseUser,
      password: clickhousePassword,
    });
    process.env.ATHENA_CLICKHOUSE_URL = clickhouse.url;
    process.env.ATHENA_CLICKHOUSE_DATABASE = "athena_operations_acceptance";
    process.env.ATHENA_CLICKHOUSE_USER = clickhouseUser;
    process.env.ATHENA_CLICKHOUSE_PASSWORD = clickhousePassword;
  }

  const {
    startOpenTelemetry,
    shutdownOpenTelemetry,
  } = require("../utils/observability");
  startOpenTelemetry();
  const {
    correlationCoverage,
    runWithOperationContext,
    withOperationSpan,
  } = require("../utils/observability/operationContext");
  const {
    emitSemanticEvent,
    flushSemanticEvents,
  } = require("../utils/observability/semanticEvents");
  const {
    GOLDEN_JOURNEYS,
    requirementsForJourney,
  } = require("../utils/observability/goldenJourneys");
  const {
    ClickHouseEventStore,
  } = require("../utils/operations/clickHouseEventStore");
  const {
    OperationsJetStreamTransport,
  } = require("../utils/operations/jetStreamTransport");
  const { OperationsPlane } = require("../utils/operations/operationsPlane");
  const {
    buildStateGraph,
    explainEvent,
  } = require("../utils/operations/stateGraph");
  const {
    ModuleHealthMonitor,
    parseEndpointMap,
  } = require("../utils/operations/moduleHealthMonitor");
  const {
    InfrastructureHealthMonitor,
    infrastructureServices,
  } = require("../utils/operations/infrastructureHealthMonitor");
  const {
    buildInfrastructureProbeProviders,
  } = require("../utils/operations/infrastructureProbes");
  const { projectFlows } = require("../utils/operations/flowProjection");
  const { loadManifests } = require("../utils/modulePlatform/manifestRegistry");
  const { agentDefinitions } = require("../utils/operations/agentRegistry");
  const {
    runShadowAgents,
  } = require("../utils/operations/shadowAgents/analyzers");
  const {
    OperationsActionRepository,
  } = require("../repositories/operationsActionRepository");
  const { ACTION_IDS } = require("../utils/operations/actions/catalog");
  const {
    knowledgeIndexAdapter,
    requeueAdapter,
    securityCacheAdapter,
    workerAdapter,
  } = require("../utils/operations/actions/adapters");
  const {
    OperationsActionOrchestrator,
  } = require("../utils/operations/actions/orchestrator");
  const { DataAccessCenter } = require("../utils/dataAccess");

  const store = new ClickHouseEventStore(process.env);
  const transport = liveInfrastructure
    ? new OperationsJetStreamTransport(process.env)
    : new LoopbackJetStreamContract();
  const plane = new OperationsPlane({ env: process.env, store, transport });
  const report = {
    passed: false,
    infrastructure: {
      mode: liveInfrastructure ? "external-live" : "isolated-contract",
      jetstream: liveInfrastructure
        ? "real external NATS JetStream"
        : "loopback contract; external NATS unavailable on this host",
      clickhouse: liveInfrastructure
        ? "real external ClickHouse HTTP service"
        : "production HTTP adapter against isolated protocol contract",
      otlp: "live local HTTP receiver",
    },
  };
  const audit = [];
  let moduleMonitor = null;
  let infrastructureMonitor = null;
  try {
    const health = await plane.start();
    assert(health.ready, "operations_plane_not_ready");

    const journeyContexts = {
      [GOLDEN_JOURNEYS.login]: {
        requestId: "request-login",
        interactionId: "interaction-login",
      },
      [GOLDEN_JOURNEYS.chat]: {
        requestId: "request-chat",
        clientTurnId: "turn-chat",
      },
      [GOLDEN_JOURNEYS.agentTool]: {
        invocationId: "invocation-tool",
        toolCallId: "tool-call-market",
      },
      [GOLDEN_JOURNEYS.knowledgeIngest]: { requestId: "request-ingest" },
      [GOLDEN_JOURNEYS.crossDeviceSync]: {
        requestId: "request-sync",
        clientId: "client-ios",
      },
    };
    const coverage = [];
    for (const [journey, values] of Object.entries(journeyContexts)) {
      await runWithOperationContext(
        {
          operationId: `acceptance-${journey}`,
          traceId: crypto.randomBytes(16).toString("hex"),
          journey,
          ...values,
        },
        () =>
          withOperationSpan(`acceptance.${journey}`, async () => {
            coverage.push(
              correlationCoverage(requirementsForJourney(journey)).complete
            );
            emitSemanticEvent({
              eventType: `${journey}.completed`,
              category: "golden_journey",
              severity: "info",
              outcome: "success",
              subject: { type: "journey", id: journey },
              evidence: [{ type: "trace", ref: `trace:${journey}` }],
            });
          })
      );
    }
    const incident = emitSemanticEvent({
      eventType: "knowledge.retrieval.degraded",
      category: "knowledge",
      severity: "error",
      outcome: "degraded",
      subject: { type: "service", id: "rag", component: "rag" },
      impact: { userEffect: "answer_quality_decreased", scope: "acceptance" },
      evidence: [{ type: "metric", ref: "metric:retrieval_hit_rate" }],
      hypotheses: [
        {
          reason: "embedding_index_stale",
          component: "embedding-provider",
          confidence: 0.82,
          counterEvidence: ["source_documents_healthy"],
        },
      ],
    });

    const fixtures = actionFixtures();
    const adapters = {
      [ACTION_IDS.REQUEUE_FAILED_TASKS]: requeueAdapter({
        data: fixtures.requeueData,
      }),
      [ACTION_IDS.REFRESH_SECURITY_CACHE]: securityCacheAdapter({
        data: fixtures.securityData,
      }),
      [ACTION_IDS.RESTART_STATELESS_WORKER]: workerAdapter({
        workers: {
          "workspace-cognition": fixtures.worker,
          "sync-v2-outbox": fixtures.worker,
        },
      }),
      [ACTION_IDS.REBUILD_WORKSPACE_INDEX]: knowledgeIndexAdapter({
        data: fixtures.knowledgeData,
        consistency: fixtures.consistency,
      }),
    };
    const orchestrator = new OperationsActionOrchestrator({
      repository: OperationsActionRepository,
      adapters,
      env: process.env,
      emit: emitSemanticEvent,
      audit: async (entry) => audit.push(entry),
    });
    const actor = { type: "human", role: "admin", userId: 1 };
    const execute = async (actionId, parameters, suffix) => {
      const proposed = await orchestrator.propose({
        actionId,
        parameters,
        sourceActionId: `acceptance-${suffix}-${crypto.randomUUID()}`,
        actor,
      });
      assert(
        proposed.status === "awaiting_approval",
        `${suffix}_preflight_failed`
      );
      const approved = await orchestrator.decide({
        runId: proposed.id,
        decision: "approved",
        reasonCode: "isolated_acceptance",
        actor,
      });
      assert(approved.status === "approved", `${suffix}_approval_failed`);
      return orchestrator.execute(proposed.id, actor);
    };
    const actionRuns = [
      await execute(
        ACTION_IDS.REQUEUE_FAILED_TASKS,
        { seqs: [41, 42] },
        "requeue"
      ),
      await execute(
        ACTION_IDS.REFRESH_SECURITY_CACHE,
        { sessionIds: [] },
        "security-cache"
      ),
      await execute(
        ACTION_IDS.RESTART_STATELESS_WORKER,
        { workerId: "workspace-cognition" },
        "worker"
      ),
      await execute(
        ACTION_IDS.REBUILD_WORKSPACE_INDEX,
        { workspaceId: 901 },
        "knowledge"
      ),
    ];
    assert(
      actionRuns.every((run) => run.status === "succeeded"),
      "catalog_action_failed"
    );

    fixtures.outbox.set(43, {
      ...fixtures.outbox.get(43),
      status: "dead_letter",
    });
    const interrupted = await orchestrator.propose({
      actionId: ACTION_IDS.REQUEUE_FAILED_TASKS,
      parameters: { seqs: [43] },
      sourceActionId: `acceptance-interrupted-${crypto.randomUUID()}`,
      actor,
    });
    await orchestrator.decide({
      runId: interrupted.id,
      decision: "approved",
      actor,
    });
    await OperationsActionRepository.transitionRun({
      id: interrupted.id,
      from: ["approved"],
      to: "executing",
      data: {
        leaseOwner: "acceptance-dead-process",
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });
    const interruptedScan =
      await orchestrator.markExpiredRunsForReconciliation();
    assert(
      interruptedScan.marked.includes(interrupted.id),
      "interrupted_run_not_quarantined"
    );
    const reconciled = await orchestrator.reconcile(interrupted.id, actor);
    assert(
      reconciled.status === "rolled_back",
      "interrupted_run_not_rolled_back"
    );

    let agentControlBlocked = false;
    try {
      await orchestrator.reconcile(interrupted.id, {
        type: "agent",
        agentId: "ops.rca",
      });
    } catch (error) {
      agentControlBlocked = error?.code === "operations_human_control_required";
    }
    assert(agentControlBlocked, "agent_control_boundary_failed");

    await flushSemanticEvents();
    if (liveInfrastructure) {
      const drained = await waitFor(
        async () => {
          const health = transport.health();
          if (!(health.published > 0 && health.received >= health.published))
            return false;
          const consumer = await transport.consumerState();
          return (
            consumer.pending === 0 &&
            consumer.ackPending === 0 &&
            consumer.redelivered === 0
          );
        },
        {
          timeoutMs: Math.max(
            15_000,
            Number(process.env.ATHENA_OPERATIONS_VERIFY_TIMEOUT_MS || 60_000)
          ),
        }
      );
      assert(drained, "jetstream_consumer_drain_timeout");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const timeline = await plane.timeline({ limit: 500 });
    const shadow = runShadowAgents({ events: timeline, metrics: [] });
    moduleMonitor = new ModuleHealthMonitor({ env: process.env });
    const localProviders = liveInfrastructure
      ? {
          "operations-plane": () => plane.health(),
        }
      : Object.fromEntries(
          loadManifests().map((manifest) => [
            manifest.id,
            () => ({ ready: true }),
          ])
        );
    moduleMonitor.start({ localProviders });
    const moduleHealth = await moduleMonitor.refresh();
    infrastructureMonitor = new InfrastructureHealthMonitor({
      env: process.env,
    });
    infrastructureMonitor.start({
      providers: liveInfrastructure
        ? buildInfrastructureProbeProviders({
            plane,
            env: process.env,
          })
        : Object.fromEntries(
            infrastructureServices().map((service) => [
              service.id,
              () => ({ ready: true }),
            ])
          ),
    });
    const infrastructureHealth = await infrastructureMonitor.refresh();
    const graph = buildStateGraph({
      events: timeline,
      agents: await agentDefinitions(),
      syncState: { ready: true, deadLetterOutbox: 0 },
      moduleHealth,
      infrastructureHealth,
    });
    const flows = projectFlows(timeline);
    const explanation = explainEvent(
      timeline.find((event) => event.eventId === incident.eventId)
    );
    const correlationRate = coverage.filter(Boolean).length / coverage.length;
    assert(correlationRate >= 0.95, "golden_journey_correlation_below_slo");
    assert(timeline.length >= 6, "semantic_timeline_incomplete");
    assert(graph.summary.nodes > 10, "state_graph_incomplete");
    assert(
      moduleHealth.summary.degraded === 0,
      "module_health_contains_degraded_runtime"
    );
    assert(
      infrastructureHealth.summary.complete,
      "infrastructure_health_contract_incomplete"
    );
    if (liveInfrastructure) {
      const configuredEndpoints = Object.keys(
        parseEndpointMap(process.env)
      ).length;
      assert(configuredEndpoints > 0, "module_health_endpoints_missing");
      assert(
        moduleHealth.modules
          .filter((module) => module.endpointConfigured)
          .every((module) => module.status === "healthy"),
        "configured_module_health_probe_failed"
      );
    } else {
      assert(
        moduleHealth.summary.healthy === loadManifests().length,
        "isolated_module_health_contract_incomplete"
      );
    }
    assert(
      flows.summary.successful >= coverage.length,
      "golden_journey_flow_projection_incomplete"
    );
    assert(shadow.findings.length >= 2, "shadow_agents_found_no_incident");
    assert(explanation?.evidence?.length, "incident_evidence_missing");
    if (!liveInfrastructure)
      assert(
        clickhouse.rows.size >= timeline.length &&
          timeline.every((event) => clickhouse.rows.has(event.eventId)),
        "clickhouse_projection_mismatch"
      );
    if (liveInfrastructure) {
      const transportHealth = transport.health();
      assert(transportHealth.published > 0, "jetstream_publish_missing");
      assert(transportHealth.received > 0, "jetstream_consume_missing");
      assert(transportHealth.pending === 0, "jetstream_consumer_lagged");
    }
    assert(audit.length >= 20, "action_audit_incomplete");

    await shutdownOpenTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(otlp.received.logs > 0, "otlp_logs_missing");
    assert(otlp.received.traces > 0, "otlp_traces_missing");
    report.passed = true;
    report.goldenJourneys = {
      count: coverage.length,
      correlationCoverage: correlationRate,
    };
    report.semanticEvents = {
      persisted: timeline.length,
      clickhouseRows: liveInfrastructure
        ? timeline.length
        : clickhouse.rows.size,
      schemaRequests: liveInfrastructure ? "real" : clickhouse.schemaRequests(),
    };
    report.otel = { ...otlp.received };
    report.stateGraph = graph.summary;
    report.moduleHealth = moduleHealth.summary;
    report.infrastructureHealth = infrastructureHealth.summary;
    report.flows = flows.summary;
    report.shadowAgents = {
      mode: shadow.mode,
      canExecuteActions: shadow.canExecuteActions,
      findings: shadow.findings.length,
      agentsWithFindings: Object.entries(shadow.byAgent)
        .filter(([, findings]) => findings.length)
        .map(([agent]) => agent),
    };
    report.actions = {
      catalogRuns: actionRuns.map((run) => ({
        actionId: run.actionId,
        status: run.status,
      })),
      auditStages: audit.length,
      interruptedRun: reconciled.status,
      agentControlBlocked,
    };
    report.evidence = {
      eventId: explanation.eventId,
      affectedServices: explanation.affectedSubjects.services,
      references: explanation.evidence.map((entry) => entry.ref),
    };
  } finally {
    console.info = originalConsoleInfo;
    await plane.stop().catch(() => null);
    await moduleMonitor?.stop().catch(() => null);
    await infrastructureMonitor?.stop().catch(() => null);
    await shutdownOpenTelemetry().catch(() => null);
    await DataAccessCenter.runtimeLifecycle
      .disconnectDatabases()
      .catch(() => null);
    if (clickhouse?.server) await close(clickhouse.server).catch(() => null);
    await close(otlp.server).catch(() => null);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify(
      {
        passed: false,
        error: error?.code || error?.message || "operations_acceptance_failed",
      },
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
