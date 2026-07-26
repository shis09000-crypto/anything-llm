const { semanticEvent } = require("../observability/semanticEvents");
const { validateRegistered } = require("./schemaRegistry");
const { runShadowAgents } = require("./shadowAgents/analyzers");

function pqResilienceSemanticEvent(report, factory = semanticEvent) {
  const success = report?.success === true;
  const failingScenarios = Object.entries(report?.scenarios || {})
    .filter(([, result]) => result?.success !== true)
    .map(([name]) => name);
  return factory({
    eventType: success
      ? "security.crypto.pq_resilience.completed"
      : "security.crypto.pq_resilience.failed",
    category: "security",
    severity: success ? "info" : "critical",
    outcome: success ? "passed" : "failed",
    subject: {
      type: "security-control",
      id: "post-quantum-resilience",
      component: "post-quantum-security",
      operation: "validate",
    },
    correlation: { operationId: report?.runId },
    impact: {
      userEffect: success ? "none" : "pq_control_not_proven",
      slo: "cryptographic_resilience",
      scope: failingScenarios.join(",") || "all",
      status: success ? "healthy" : "degraded",
    },
    evidence: [
      {
        type: "metric",
        ref: "metric:athena_crypto_runtime_pq_capability",
      },
      {
        type: "artifact",
        ref: `pq-resilience:${String(report?.runId || "unknown").slice(0, 64)}`,
      },
    ],
    recommendation: success
      ? {}
      : {
          actionId: "investigate:post-quantum-security",
          risk: "none",
          permission: "human_review",
        },
    metadata: {
      durationMs: String(Math.max(Number(report?.durationMs) || 0, 0)),
      backend: "node-openssl-provider",
      errorCode: success
        ? undefined
        : String(report?.findings?.[0] || "pq_resilience_failed"),
    },
    sensitivity: "metadata_only",
    retentionClass: "security_1y",
  });
}

function validatePQOperationsIntegration(report) {
  const event = pqResilienceSemanticEvent(report);
  const schema = validateRegistered(event);
  const shadow = runShadowAgents({ events: [event] });
  const executable = shadow.findings.some(
    (finding) =>
      finding.canExecuteActions === true ||
      finding.advisory?.executable === true
  );
  const securityFindings = shadow.byAgent["ops-security-agent"] || [];
  const failureDetected = securityFindings.length > 0;
  const classificationCorrect =
    report?.success === true ? !failureDetected : failureDetected;
  return {
    success: schema.valid && !executable && classificationCorrect,
    event,
    schemaValid: schema.valid,
    schemaErrors: schema.errors,
    classificationCorrect,
    failureDetected,
    automaticActionPossible: executable,
    securityFindingCount: securityFindings.length,
  };
}

async function publishPQOperationsReport(
  report,
  { plane = null, manageLifecycle = true } = {}
) {
  const targetPlane = plane || require("./operationsPlane").operationsPlane;
  let started = false;
  try {
    if (manageLifecycle) {
      const health = await targetPlane.start();
      started = true;
      if (health?.ready !== true) {
        const error = new Error("pq_resilience_operations_plane_not_ready");
        error.code = "PQ_RESILIENCE_OPERATIONS_PLANE_NOT_READY";
        error.health = health;
        throw error;
      }
    }
    const event = pqResilienceSemanticEvent(report);
    const result = await targetPlane.ingest(event);
    if (result?.accepted === false || result?.queued === true) {
      const error = new Error("pq_resilience_operations_event_not_durable");
      error.code = "PQ_RESILIENCE_OPERATIONS_EVENT_NOT_DURABLE";
      throw error;
    }
    return {
      success: true,
      eventId: event.eventId,
      eventType: event.eventType,
    };
  } finally {
    if (started) await targetPlane.stop();
  }
}

module.exports = {
  pqResilienceSemanticEvent,
  publishPQOperationsReport,
  validatePQOperationsIntegration,
};
