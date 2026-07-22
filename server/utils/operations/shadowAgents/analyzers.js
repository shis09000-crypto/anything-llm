const crypto = require("crypto");
const { serviceById } = require("../serviceCatalog");
const { eventComponent } = require("../stateGraph");
const { SHADOW_AGENT_IDS } = require("./definitions");

const ROOT_CAUSE_BY_CATEGORY = Object.freeze({
  database: ["main-database", "athena-api"],
  knowledge: ["vector-database", "embedding-provider", "rag"],
  model: ["model-provider", "chat-runtime"],
  agent: ["agent-runtime", "model-provider"],
  agent_tool: ["tool-runtime", "agent-runtime"],
  performance: ["athena-api", "main-database", "model-provider"],
  security: ["key-custody", "authentication", "main-database"],
  sync: ["nats-jetstream", "main-database", "sync-v2"],
});

function severityRank(value) {
  return { debug: 0, info: 1, warning: 2, error: 3, critical: 4 }[value] ?? 0;
}

function findingId(agentId, parts = []) {
  return crypto
    .createHash("sha256")
    .update([agentId, ...parts].join("\0"))
    .digest("hex")
    .slice(0, 40);
}

function evidenceRefs(event = {}) {
  return [
    ...(event.evidence || []).map((item) => item?.ref).filter(Boolean),
    event.eventId ? `event:${event.eventId}` : null,
    event.correlation?.traceId ? `trace:${event.correlation.traceId}` : null,
  ].filter(Boolean);
}

function advisoryFor(component) {
  const service = serviceById(component);
  return {
    actionId: `investigate:${component || "unknown"}`,
    title: service ? `Inspect ${service.name}` : "Inspect correlated evidence",
    risk: "none",
    permission: "human_review",
    executable: false,
  };
}

function finding({ agentId, event, kind, confidence, hypotheses = [] }) {
  const component =
    eventComponent(event) || event.subject?.component || "unknown";
  return {
    findingId: findingId(agentId, [
      kind,
      event.eventId || event.eventType,
      component,
    ]),
    agentId,
    mode: "shadow",
    canExecuteActions: false,
    kind,
    severity: event.severity || "warning",
    confidence: Math.max(0, Math.min(Number(confidence) || 0, 1)),
    occurredAt: event.occurredAt || new Date().toISOString(),
    subject: {
      type: event.subject?.type || "service",
      id: event.subject?.id || component,
      component,
    },
    eventIds: event.eventId ? [event.eventId] : [],
    evidenceRefs: [...new Set(evidenceRefs(event))],
    hypotheses: hypotheses.slice(0, 3),
    impact: event.impact || {},
    advisory: advisoryFor(component),
  };
}

function incidentCandidates(events = []) {
  return events.filter((event) => {
    if (event.category === "operations_shadow") return false;
    if (event.category === "golden_journey" && severityRank(event.severity) < 3)
      return false;
    return (
      severityRank(event.severity) >= 3 ||
      ["failed", "timeout", "degraded"].includes(event.outcome)
    );
  });
}

function monitoringAgent({ events = [] } = {}) {
  return incidentCandidates(events).map((event) =>
    finding({
      agentId: SHADOW_AGENT_IDS.monitoring,
      event,
      kind: "incident_candidate",
      confidence: severityRank(event.severity) >= 4 ? 0.98 : 0.9,
    })
  );
}

function durationMs(event = {}) {
  const value = Number(event.metadata?.durationMs);
  return Number.isFinite(value) ? value : 0;
}

function performanceAgent({ events = [] } = {}) {
  return events
    .filter(
      (event) =>
        event.category !== "operations_shadow" &&
        (event.eventType?.includes("slow") ||
          event.eventType?.includes("timed_out") ||
          event.outcome === "timeout" ||
          durationMs(event) >= 800)
    )
    .map((event) =>
      finding({
        agentId: SHADOW_AGENT_IDS.performance,
        event,
        kind: "performance_regression",
        confidence: event.outcome === "timeout" ? 0.98 : 0.86,
      })
    );
}

function securityAgent({ events = [] } = {}) {
  const direct = events.filter(
    (event) =>
      event.category !== "operations_shadow" &&
      (event.category === "security" ||
        /key\.custody|checksum\.mismatch|audit\.chain|permission\.denied/.test(
          event.eventType || ""
        )) &&
      severityRank(event.severity) >= 2
  );
  const failedAuth = events.filter(
    (event) =>
      /^(login|authentication)\./.test(event.eventType || "") &&
      event.outcome === "failure"
  );
  if (failedAuth.length >= 3) direct.push(failedAuth[failedAuth.length - 1]);
  return [
    ...new Map(direct.map((event) => [event.eventId, event])).values(),
  ].map((event) =>
    finding({
      agentId: SHADOW_AGENT_IDS.security,
      event,
      kind: "security_anomaly",
      confidence: severityRank(event.severity) >= 3 ? 0.96 : 0.82,
    })
  );
}

function metricEvidence(metric = {}) {
  const labels = Object.entries(metric.labels || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `metric:${metric.name}${labels ? `{${labels}}` : ""}`;
}

function costAgent({ metrics = [] } = {}) {
  return metrics
    .filter(
      (metric) =>
        ["athena_ai_cost_micros_total", "athena_ai_tokens_total"].includes(
          metric.name
        ) &&
        Number.isFinite(Number(metric.delta)) &&
        Number.isFinite(Number(metric.threshold)) &&
        Number(metric.delta) > Number(metric.threshold)
    )
    .map((metric) => {
      const component = "model-provider";
      const event = {
        eventId: metricEvidence(metric),
        eventType: "model.cost.window_exceeded",
        category: "model",
        severity: "warning",
        outcome: "degraded",
        occurredAt: metric.observedAt || new Date().toISOString(),
        subject: { type: "service", id: component, component },
        impact: { userEffect: "model_budget_consumption_increased" },
        evidence: [{ type: "metric", ref: metricEvidence(metric) }],
      };
      return finding({
        agentId: SHADOW_AGENT_IDS.cost,
        event,
        kind: "cost_regression",
        confidence: 0.9,
      });
    });
}

function rootCauseCandidates(event = {}) {
  const candidates = [];
  const append = (component, confidence, reason, counterEvidence = []) => {
    if (!component || candidates.some((item) => item.component === component))
      return;
    candidates.push({ component, confidence, reason, counterEvidence });
  };
  const direct = eventComponent(event);
  if (direct && serviceById(direct))
    append(direct, 0.86, "direct_failure_subject");
  for (const candidate of ROOT_CAUSE_BY_CATEGORY[event.category] || [])
    append(candidate, candidates.length ? 0.72 : 0.82, "category_dependency");
  for (const hypothesis of event.hypotheses || [])
    append(
      hypothesis.component,
      Number(hypothesis.confidence) || 0.7,
      hypothesis.reason || "upstream_hypothesis",
      hypothesis.counterEvidence || []
    );
  return candidates.sort((left, right) => right.confidence - left.confidence);
}

function rcaAgent({ events = [] } = {}) {
  return incidentCandidates(events).map((event) =>
    finding({
      agentId: SHADOW_AGENT_IDS.rca,
      event,
      kind: "root_cause_hypothesis",
      confidence: 0.82,
      hypotheses: rootCauseCandidates(event),
    })
  );
}

function runShadowAgents(input = {}) {
  const byAgent = {
    [SHADOW_AGENT_IDS.monitoring]: monitoringAgent(input),
    [SHADOW_AGENT_IDS.rca]: rcaAgent(input),
    [SHADOW_AGENT_IDS.performance]: performanceAgent(input),
    [SHADOW_AGENT_IDS.security]: securityAgent(input),
    [SHADOW_AGENT_IDS.cost]: costAgent(input),
  };
  return {
    mode: "shadow",
    canExecuteActions: false,
    generatedAt: new Date().toISOString(),
    byAgent,
    findings: Object.values(byAgent).flat(),
  };
}

module.exports = {
  costAgent,
  monitoringAgent,
  performanceAgent,
  rcaAgent,
  rootCauseCandidates,
  runShadowAgents,
  securityAgent,
};
