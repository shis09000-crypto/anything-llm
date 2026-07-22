const { emitSemanticEvent } = require("../../observability/semanticEvents");
const {
  metrics: observabilityMetrics,
  registry,
} = require("../../observability/metrics");
const { operationsPlane } = require("../operationsPlane");
const { runShadowAgents } = require("./analyzers");
const { shadowAgentDefinitions } = require("./definitions");
const { corpusManifest, evaluateIncidentCorpus } = require("./evaluation");

const MAX_FINDINGS = 500;
const MAX_EMITTED_FINDING_IDS = 5_000;
const COST_METRIC_NAMES = new Set([
  "athena_ai_cost_micros_total",
  "athena_ai_tokens_total",
]);

function enabledFromEnv(env = process.env) {
  return (
    String(env.ATHENA_OPERATIONS_SHADOW_AGENTS_ENABLED || "false")
      .trim()
      .toLowerCase() === "true"
  );
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Math.max(
    minimum,
    Math.min(Number.isFinite(parsed) ? parsed : fallback, maximum)
  );
}

function shadowRuntimeConfig(env = process.env) {
  return {
    enabled: enabledFromEnv(env),
    intervalMs: boundedNumber(
      env.ATHENA_OPERATIONS_SHADOW_INTERVAL_MS,
      60_000,
      10_000,
      3_600_000
    ),
    lookbackMs: boundedNumber(
      env.ATHENA_OPERATIONS_SHADOW_LOOKBACK_MS,
      15 * 60_000,
      60_000,
      24 * 60 * 60_000
    ),
    costThresholdMicros: boundedNumber(
      env.ATHENA_OPERATIONS_SHADOW_COST_THRESHOLD_MICROS,
      25_000_000,
      1,
      Number.MAX_SAFE_INTEGER
    ),
    tokenThreshold: boundedNumber(
      env.ATHENA_OPERATIONS_SHADOW_TOKEN_THRESHOLD,
      5_000_000,
      1,
      Number.MAX_SAFE_INTEGER
    ),
  };
}

function metricSeriesKey(name, labels = {}) {
  return `${name}:${Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",")}`;
}

function thresholdForMetric(name, config) {
  return name === "athena_ai_cost_micros_total"
    ? config.costThresholdMicros
    : config.tokenThreshold;
}

function normalizeCounterMetrics(
  metricFamilies = [],
  previous = new Map(),
  config
) {
  const next = new Map(previous);
  const observations = [];
  for (const family of metricFamilies) {
    if (!COST_METRIC_NAMES.has(family.name)) continue;
    for (const sample of family.values || []) {
      const value = Number(sample.value);
      if (!Number.isFinite(value)) continue;
      const labels = sample.labels || {};
      const key = metricSeriesKey(family.name, labels);
      const prior = previous.get(key);
      next.set(key, value);
      if (!Number.isFinite(prior)) continue;
      observations.push({
        name: family.name,
        labels,
        delta: Math.max(0, value - prior),
        threshold: thresholdForMetric(family.name, config),
        observedAt: new Date().toISOString(),
      });
    }
  }
  return { observations, next };
}

function shadowFindingEvent(finding) {
  return {
    eventId: finding.findingId,
    eventType: "operations.shadow.finding",
    category: "operations_shadow",
    severity: finding.severity,
    outcome: "observed",
    occurredAt: finding.occurredAt,
    subject: {
      type: finding.subject.type,
      id: finding.subject.id,
      component: finding.subject.component,
      operation: finding.kind,
    },
    impact: finding.impact,
    evidence: finding.evidenceRefs.map((ref) => ({ type: "reference", ref })),
    hypotheses: finding.hypotheses,
    recommendation: {
      actionId: finding.advisory.actionId,
      risk: "none",
      permission: "human_review",
    },
    metadata: { backend: finding.agentId },
    sensitivity: "metadata_only",
    retentionClass: "operations_180d",
  };
}

function recordEvaluationMetrics(report) {
  for (const [metric, value] of Object.entries(report.metrics)) {
    if (value !== null)
      observabilityMetrics.operationsShadowEvaluation.set(
        { metric, agent: "all" },
        value
      );
  }
  for (const entry of report.agentMetrics) {
    for (const metric of ["recall", "falsePositiveRate"]) {
      if (entry[metric] !== null)
        observabilityMetrics.operationsShadowEvaluation.set(
          { metric, agent: entry.agentId },
          entry[metric]
        );
    }
  }
}

class OperationsShadowRuntime {
  constructor({
    env = process.env,
    plane = operationsPlane,
    metricsRegistry = registry,
    emit = emitSemanticEvent,
    analyze = runShadowAgents,
    evaluate = evaluateIncidentCorpus,
  } = {}) {
    this.env = env;
    this.config = shadowRuntimeConfig(env);
    this.plane = plane;
    this.metricsRegistry = metricsRegistry;
    this.emit = emit;
    this.analyze = analyze;
    this.evaluate = evaluate;
    this.timer = null;
    this.running = null;
    this.status = this.config.enabled ? "created" : "disabled";
    this.lastScanAt = null;
    this.lastError = null;
    this.findings = [];
    this.emittedFindingIds = new Set();
    this.emittedFindingOrder = [];
    this.counterValues = new Map();
    this.latestEvaluation = this.evaluate();
    recordEvaluationMetrics(this.latestEvaluation);
  }

  async start() {
    if (!this.config.enabled) return this.snapshot();
    if (this.status === "running") return this.snapshot();
    this.status = "starting";
    await this.scan().catch((error) => this.captureError(error));
    this.status = this.lastError ? "degraded" : "running";
    this.schedule();
    return this.snapshot();
  }

  schedule() {
    if (this.timer || !this.config.enabled) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.scan().catch((error) => this.captureError(error));
      this.schedule();
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  captureError(error) {
    this.lastError = error?.code || error?.message || String(error);
    observabilityMetrics.operationsShadowAgentRuns.inc({
      agent: "runtime",
      outcome: "failure",
    });
  }

  async metricObservations() {
    const families = await this.metricsRegistry.getMetricsAsJSON();
    const normalized = normalizeCounterMetrics(
      families,
      this.counterValues,
      this.config
    );
    this.counterValues = normalized.next;
    return normalized.observations;
  }

  async scan() {
    if (this.running) return this.running;
    this.running = this.performScan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async performScan() {
    const scanStartedAt = new Date();
    const after = this.lastScanAt
      ? this.lastScanAt
      : new Date(
          scanStartedAt.getTime() - this.config.lookbackMs
        ).toISOString();
    const [events, metricObservations] = await Promise.all([
      this.plane.timeline({ after, limit: 500 }),
      this.metricObservations(),
    ]);
    const result = this.analyze({ events, metrics: metricObservations });
    this.lastScanAt = scanStartedAt.toISOString();
    this.lastError = null;
    if (this.config.enabled) this.status = "running";
    this.findings = [...result.findings, ...this.findings]
      .filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) => candidate.findingId === item.findingId
          ) === index
      )
      .slice(0, MAX_FINDINGS);

    for (const definition of shadowAgentDefinitions()) {
      const agentFindings = result.byAgent[definition.id] || [];
      observabilityMetrics.operationsShadowAgentRuns.inc({
        agent: definition.id,
        outcome: "success",
      });
      for (const finding of agentFindings) {
        observabilityMetrics.operationsShadowFindings.inc({
          agent: definition.id,
          severity: finding.severity,
        });
        if (this.emittedFindingIds.has(finding.findingId)) continue;
        this.emit(shadowFindingEvent(finding));
        this.emittedFindingIds.add(finding.findingId);
        this.emittedFindingOrder.push(finding.findingId);
        if (this.emittedFindingOrder.length > MAX_EMITTED_FINDING_IDS) {
          const expired = this.emittedFindingOrder.shift();
          this.emittedFindingIds.delete(expired);
        }
      }
    }
    return result;
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => null);
    this.status = this.config.enabled ? "stopped" : "disabled";
  }

  evaluation() {
    return this.latestEvaluation;
  }

  corpus() {
    return corpusManifest();
  }

  snapshot() {
    return {
      enabled: this.config.enabled,
      status: this.status,
      mode: "shadow",
      actionPolicy: "observe_only",
      canExecuteActions: false,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      agents: shadowAgentDefinitions(),
      findings: this.findings.map((finding) => ({ ...finding })),
      evaluation: this.latestEvaluation,
    };
  }
}

const operationsShadowRuntime = new OperationsShadowRuntime();

module.exports = {
  OperationsShadowRuntime,
  enabledFromEnv,
  normalizeCounterMetrics,
  operationsShadowRuntime,
  shadowFindingEvent,
  shadowRuntimeConfig,
};
