const fs = require("fs");
const path = require("path");

const DIRECTORY = path.resolve(__dirname, "../module-manifests");
const LIFECYCLE = [
  ["GET", "/internal/v1/describe", "module.describe"],
  ["GET", "/internal/v1/self-test", "module.self-test"],
  ["GET", "/internal/v1/lifecycle", "module.lifecycle.query"],
  ["POST", "/internal/drain", "module.drain"],
  ["POST", "/internal/v1/quiesce", "module.quiesce"],
  ["POST", "/internal/v1/resume", "module.resume"],
];
const ROUTES = {
  "agent-runtime": [
    ["POST", "/internal/v1/agent/invocations", "agent.submit"],
    ["GET", "/internal/v1/agent/runs/:invocationId", "agent.status"],
  ],
  "athena-api": [
    ["POST", "/internal/v1/workspace/cognition/turn/sync", "workspace.cognition.turn.sync"],
    ["POST", "/internal/v1/workspace/thread-title/claim", "workspace.thread-title.claim"],
    ["POST", "/internal/v1/workspace/thread-title/commit", "workspace.thread-title.commit"],
    ["GET", "/internal/v1/module-readiness/:moduleId", "control.dispatch"],
  ],
  authentication: [
    ["POST", "/internal/v1/principal/assert", "identity.assert"],
    ["POST", "/internal/v1/session/introspect", "identity.introspect"],
    ["POST", "/internal/v1/client-identity/attach", "identity.client.attach"],
    ["POST", "/internal/v1/realtime/tickets/consume", "identity.realtime-ticket.consume"],
    ["POST", "/internal/v1/request-signing/verify", "identity.request-signing.verify"],
    ["POST", "/internal/v1/session/validate", "identity.session.validate"],
    ["POST", "/internal/v1/session/touch", "identity.session.touch"],
    ["POST", "/internal/v1/audit/append", "identity.audit.append"],
    ["POST", "/internal/v1/user-state/read", "identity.user-state.read"],
    ["POST", "/internal/v1/user-state/upsert", "identity.user-state.upsert"],
    ["POST", "/internal/v1/user-state/delete", "identity.user-state.delete"],
    ["POST", "/internal/v1/user-domain-wraps/queue", "identity.user-domain-wrap.queue"],
  ],
  "browser-egress": [
    ["POST", "/internal/v1/browser-egress/dispatch", "browser-egress.route.resolve"],
  ],
  "browser-plane": [
    ["POST", "/internal/v1/browser/dispatch", "browser.task"],
    ["POST", "/internal/v1/browser/sessions", "browser.session"],
    ["GET", "/internal/v1/browser/sessions/:sessionId", "browser.session"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/actions", "browser.task"],
    ["POST", "/internal/v1/browser/nodes/heartbeat", "browser.node"],
    ["GET", "/internal/v1/browser/nodes", "browser.node"],
  ],
  "browser-worker": [
    ["POST", "/internal/v1/browser/sessions", "browser.worker"],
    ["GET", "/internal/v1/browser/sessions/:sessionId", "browser.worker"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/stream-ticket", "browser.worker"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/actions", "browser.worker"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/tabs", "browser.worker"],
    ["DELETE", "/internal/v1/browser/sessions/:sessionId/tabs/:tabId", "browser.worker"],
    ["GET", "/internal/v1/browser/sessions/:sessionId/cookies", "browser.worker"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/risk-inspection", "browser.worker"],
    ["GET", "/internal/v1/browser/sessions/:sessionId/downloads/:downloadId", "browser.worker"],
    ["DELETE", "/internal/v1/browser/sessions/:sessionId/downloads/:downloadId", "browser.worker"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/cookies/clear", "browser.worker"],
    ["POST", "/internal/v1/browser/sessions/:sessionId/close", "browser.worker"],
    ["DELETE", "/internal/v1/browser/profiles/:profileId", "browser.worker"],
  ],
  "chat-runtime": [
    ["POST", "/internal/v1/chat/thread-title/generate", "chat.thread-title.generate"],
    ["POST", "/internal/v1/chat/thread-title/reconcile", "chat.thread-title.reconcile"],
    ["GET", "/internal/v1/chat/runs/:clientTurnId", "chat.status"],
    ["POST", "/internal/v1/chat/memory/status", "chat.memory.status"],
    ["POST", "/internal/v1/chat/memory/compact", "chat.memory.compact"],
    ["POST", "/internal/v1/chat/memory/context/resolve", "chat.memory.context.resolve"],
  ],
  "coordination-plane": [
    ["POST", "/internal/v1/coordination/runs", "coordination.plan"],
    ["POST", "/internal/v1/coordination/runs/:runId/start", "coordination.plan"],
    ["GET", "/internal/v1/coordination/runs/:runId", "coordination.status"],
    ["POST", "/internal/v1/coordination/runs/:runId/autonomy-attempts", "coordination.plan"],
    ["POST", "/internal/v1/coordination/runs/:runId/escalations", "coordination.plan"],
    ["POST", "/internal/v1/coordination/runs/:runId/cancel", "coordination.cancel"],
    ["POST", "/internal/v1/coordination/modules/heartbeat", "coordination.lifecycle.heartbeat"],
    ["POST", "/internal/v1/coordination/modules/lifecycle-events", "coordination.lifecycle.event"],
    ["GET", "/internal/v1/coordination/modules", "coordination.status"],
  ],
  "crypto-account-access": [["POST", "/internal/v1/crypto/account/read", "crypto.account"]],
  "crypto-forecast": [["GET", "/internal/v1/crypto/forecast", "crypto.forecast"]],
  "crypto-market": [["POST", "/internal/v1/crypto/market", "crypto.market"]],
  "key-custody": [
    ["POST", "/internal/v1/keys/wrap", "key-custody.wrap"],
    ["POST", "/internal/v1/keys/unwrap", "key-custody.unwrap"],
    ["POST", "/internal/v1/keys/audit-descriptor", "key-custody.audit-descriptor"],
    ["POST", "/internal/v1/keys/audit-sign", "key-custody.audit-sign"],
    ["GET", "/internal/v1/keys/status", "key-custody.audit-descriptor"],
  ],
  "knowledge-ingest": [
    ["POST", "/internal/v1/knowledge/browser-ingest", "knowledge.ingest"],
    ["POST", "/internal/v1/knowledge/metrics/recompute", "knowledge.metrics.recompute"],
  ],
  "model-gateway": [
    ["GET", "/internal/v1/models/responses/capabilities", "model.responses.capabilities"],
    ["GET", "/internal/v1/models/health", "model.health"],
    ["GET", "/internal/v1/models/catalog", "model.catalog"],
    ["POST", "/internal/v1/models/complete", "model.stream"],
    ["POST", "/internal/v1/models/stream", "model.stream"],
    ["POST", "/internal/v1/models/responses/complete", "model.responses.complete"],
    ["POST", "/internal/v1/models/responses/stream", "model.responses.stream"],
    ["POST", "/internal/v1/models/agent/complete", "model.agent.complete"],
    ["POST", "/internal/v1/models/agent/stream", "model.agent.stream"],
  ],
  "operations-plane": [
    ["POST", "/internal/v1/operations/ingest", "operations.ingest-batch"],
    ["POST", "/internal/v1/operations/ingest-batch", "operations.ingest-batch"],
    ["GET", "/internal/v1/operations/health", "operations.catalog"],
    ["GET", "/internal/v1/operations/services", "operations.catalog"],
    ["GET", "/internal/v1/operations/agents", "operations.catalog"],
    ["GET", "/internal/v1/operations/shadow-agents", "operations.catalog"],
    ["GET", "/internal/v1/operations/evaluations/latest", "operations.catalog"],
    ["GET", "/internal/v1/operations/evaluations/corpus", "operations.catalog"],
    ["GET", "/internal/v1/operations/actions/catalog", "operations.catalog"],
    ["POST", "/internal/v1/operations/actions/runs/query", "operations.guard"],
    ["GET", "/internal/v1/operations/actions/runs/:runId", "operations.guard"],
    ["POST", "/internal/v1/operations/actions/runs", "operations.guard"],
    ["POST", "/internal/v1/operations/actions/runs/:runId/decide", "operations.guard"],
    ["POST", "/internal/v1/operations/actions/runs/:runId/execute", "operations.guard"],
    ["POST", "/internal/v1/operations/actions/runs/:runId/reconcile", "operations.guard"],
    ["POST", "/internal/v1/operations/timeline", "operations.catalog"],
    ["POST", "/internal/v1/operations/state-graph", "operations.catalog"],
    ["POST", "/internal/v1/operations/flows", "operations.catalog"],
    ["POST", "/internal/v1/operations/explain", "operations.catalog"],
    ["POST", "/internal/v1/operations/module-health/refresh", "operations.catalog"],
    ["GET", "/internal/v1/operations/module-health", "operations.catalog"],
    ["GET", "/internal/v1/operations/infrastructure-health", "operations.catalog"],
  ],
  "operations-shadow-agents": [
    ["GET", "/internal/v1/operations/shadow", "operations.shadow.evaluate"],
    ["GET", "/internal/v1/operations/shadow/evaluations/latest", "operations.shadow.evaluate"],
    ["GET", "/internal/v1/operations/shadow/evaluations/corpus", "operations.shadow.evaluate"],
  ],
  rag: [
    ["GET", "/internal/v1/rag/dependencies", "rag.dependencies"],
    ["POST", "/internal/v1/rag/retrieve", "rag.retrieve"],
  ],
  "responses-runtime": [
    ["POST", "/internal/v1/responses/execution-metadata/resolve", "responses.execution-metadata.resolve"],
    ["GET", "/internal/v1/responses/capabilities", "responses.capabilities"],
    ["POST", "/internal/v1/responses", "responses.create"],
    ["POST", "/internal/v1/responses/stream", "responses.stream"],
    ["GET", "/internal/v1/responses/agent-runs/:agentRunId/status", "responses.agent-run.status"],
    ["GET", "/internal/v1/responses/:responseId", "responses.retrieve"],
    ["POST", "/internal/v1/responses/:responseId/cancel", "responses.cancel"],
    ["DELETE", "/internal/v1/responses/:responseId", "responses.delete"],
    ["GET", "/internal/v1/responses/:responseId/input-items", "responses.input-items.list"],
    ["POST", "/internal/v1/responses/conversations", "responses.conversation.create"],
    ["GET", "/internal/v1/responses/conversations/:conversationId", "responses.conversation.retrieve"],
    ["DELETE", "/internal/v1/responses/conversations/:conversationId", "responses.conversation.delete"],
    ["GET", "/internal/v1/responses/conversations/:conversationId/items", "responses.conversation.items"],
    ["POST", "/internal/v1/responses/compact", "responses.compact"],
    ["POST", "/internal/v1/responses/background/claim", "responses.background.claim"],
    ["POST", "/internal/v1/responses/background/:responseId/execute", "responses.background.execute"],
    ["POST", "/internal/v1/responses/maintenance", "responses.maintenance"],
  ],
  scheduler: [
    ["POST", "/internal/v1/scheduler/jobs/:jobId/sync", "scheduler.create"],
    ["DELETE", "/internal/v1/scheduler/jobs/:jobId", "scheduler.create"],
    ["POST", "/internal/v1/scheduler/jobs/:jobId/trigger", "scheduler.status"],
    ["POST", "/internal/v1/scheduler/jobs/:jobId/runs/:runId/kill", "scheduler.status"],
  ],
  "sync-v2": [
    ["POST", "/internal/v1/sync/events/append", "sync.events.append"],
    ["POST", "/internal/v1/sync/security/clients/reconcile", "sync.security.clients.reconcile"],
    ["POST", "/internal/v1/sync/user-state/reconcile", "sync.user-state.reconcile"],
  ],
  "tool-runtime": [
    ["GET", "/internal/v1/tools/catalog", "tool.catalog"],
    ["POST", "/internal/v1/tools/invoke", "tool.invoke"],
  ],
};

const files = fs.readdirSync(DIRECTORY).filter((file) => file.endsWith(".json"));
const manifests = files.map((file) => ({
  file,
  value: JSON.parse(fs.readFileSync(path.join(DIRECTORY, file), "utf8")),
}));
const providers = new Map();
for (const { value } of manifests)
  for (const contract of value.contracts?.provides || []) {
    const list = providers.get(contract.id) || [];
    providers.set(contract.id, [...list, value.id]);
  }

function providedContract(capability, targetModule) {
  const target = manifests.find(({ value }) => value.id === targetModule)?.value;
  const contract = target?.contracts?.provides?.find(
    (entry) => entry.id === capability
  );
  if (!contract)
    throw new Error(`provider_contract_missing:${targetModule}:${capability}`);
  return contract;
}

function ensureDependency(manifest, targetModule) {
  if (!manifest.dependsOn.includes(targetModule))
    manifest.dependsOn.push(targetModule);
}

function ensureConsume(
  manifest,
  capability,
  targetModule,
  { requiredForReadiness = true } = {}
) {
  const existing = manifest.contracts.consumes.find(
    (entry) => entry.id === capability && entry.targetModule === targetModule
  );
  if (existing) {
    existing.requiredForReadiness = requiredForReadiness;
    return;
  }
  manifest.contracts.consumes.push({
    ...providedContract(capability, targetModule),
    targetModule,
    requiredForReadiness,
  });
}

for (const entry of manifests) {
  const manifest = entry.value;
  manifest.schemaVersion = "1.2";
  manifest.version = "2.6.14";
  for (const direction of ["provides", "consumes"])
    manifest.contracts[direction] = manifest.contracts[direction].map(
      (contract) =>
        /(?:stream|subscribe|replay)/.test(contract.id)
          ? { ...contract, callType: "Stream" }
          : contract
    );
  manifest.contracts.consumes = manifest.contracts.consumes.map((contract) => {
    const targets = providers.get(contract.id) || [];
    const targetModule =
      contract.targetModule ||
      targets.find((id) => manifest.dependsOn.includes(id)) ||
      targets[0];
    if (!targetModule)
      throw new Error(`provider_missing:${manifest.id}:${contract.id}`);
    return {
      ...contract,
      targetModule,
      requiredForReadiness: manifest.dependsOn.includes(targetModule),
    };
  });
  if (manifest.id === "athena-api") {
    manifest.contracts.consumes = manifest.contracts.consumes.filter(
      (contract) =>
        !(
          contract.id === "browser.worker" &&
          contract.targetModule === "browser-worker"
        )
    );
    ensureConsume(manifest, "scheduler.create", "scheduler");
    ensureConsume(manifest, "scheduler.status", "scheduler");
  }
  if (manifest.id === "agent-runtime") {
    ensureConsume(manifest, "model.agent.complete", "model-gateway");
    ensureConsume(manifest, "model.agent.stream", "model-gateway");
  }
  if (manifest.id === "coordination-plane")
    ensureConsume(manifest, "operations.catalog", "operations-plane");
  if (manifest.id === "operations-plane") {
    manifest.dependsOn = manifest.dependsOn.filter(
      (dependency) => dependency !== "operations-shadow-agents"
    );
    ensureConsume(
      manifest,
      "operations.shadow.evaluate",
      "operations-shadow-agents",
      { requiredForReadiness: false }
    );
  }
  if (manifest.id === "crypto-market") {
    if (!manifest.security.allowedCallers.includes("crypto-account-access"))
      manifest.security.allowedCallers.push("crypto-account-access");
  }
  if (manifest.id === "tool-runtime") {
    if (!manifest.security.allowedCallers.includes("responses-runtime"))
      manifest.security.allowedCallers.push("responses-runtime");
  }
  if (
    manifest.id !== "key-custody" &&
    [
      "authentication",
      "athena-api",
      "chat-runtime",
      "agent-runtime",
      "model-gateway",
      "responses-runtime",
      "tool-runtime",
      "crypto-account-access",
      "crypto-forecast",
      "knowledge-ingest",
      "rag",
      "browser-plane",
      "browser-worker",
      "browser-egress",
      "background-worker",
      "reader-worker",
      "scheduler",
      "sync-v2",
      "coordination-plane",
    ].includes(manifest.id)
  ) {
    ensureDependency(manifest, "key-custody");
    ensureConsume(
      manifest,
      "key-custody.audit-descriptor",
      "key-custody"
    );
  }
  manifest.rpc.provides = manifest.contracts.provides.map(
    (contract) => contract.id
  );
  manifest.rpc.consumes = manifest.contracts.consumes.map(
    (contract) => contract.id
  );
  const provided = new Set(manifest.contracts.provides.map((value) => value.id));
  const routes = [...LIFECYCLE, ...(ROUTES[manifest.id] || [])]
    .filter(([, , capability]) => provided.has(capability))
    .map(([method, routePath, capability]) => ({
      method,
      path: routePath,
      capability,
    }));
  manifest.routes.bindings = routes;
  manifest.streams = {
    provides: manifest.contracts.provides
      .filter((contract) => contract.callType === "Stream")
      .map((contract) => ({
        capability: contract.id,
        frameSchema: "athena://aicp/stream-frame/1.1",
        heartbeatMs: 25_000,
        terminalRequired: true,
        recovery: "cursor",
      })),
    consumes: manifest.contracts.consumes
      .filter((contract) => contract.callType === "Stream")
      .map((contract) => ({
        capability: contract.id,
        frameSchema: "athena://aicp/stream-frame/1.1",
        heartbeatMs: 25_000,
        terminalRequired: true,
        recovery: "cursor",
      })),
  };
  manifest.eventContracts = {
    publishes: (manifest.events?.publishes || []).map((subject) => ({
      subject,
      payloadSchema: `athena://events/${subject}/payload/1.1`,
      orderingKey: "subject.id",
      delivery: "at-least-once",
      dlq: `${subject}.DLQ`,
    })),
    subscribes: (manifest.events?.subscribes || []).map((subject) => ({
      subject,
      payloadSchema: `athena://events/${subject}/payload/1.1`,
      orderingKey: "subject.id",
      delivery: "at-least-once",
      dlq: `${subject}.DLQ`,
    })),
  };
  fs.writeFileSync(
    path.join(DIRECTORY, entry.file),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

process.stdout.write(`${manifests.length} manifests migrated to 1.2\n`);
