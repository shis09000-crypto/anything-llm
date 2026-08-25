const UNKNOWN_EXECUTION_SOURCE = "unknown";

function nonEmpty(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function executionMetadata({
  metrics = {},
  model = null,
  provider = null,
  requestedProtocol = null,
  effectiveProtocol = null,
  responseId = null,
  source = null,
  requestedModel = null,
  effectiveModel = null,
  turnMode = null,
  goalId = null,
  planId = null,
  planAction = null,
} = {}) {
  const resolvedModel = nonEmpty(model || metrics.model);
  const resolvedProvider = nonEmpty(provider || metrics.provider);
  const resolvedRequestedProtocol = nonEmpty(
    requestedProtocol || metrics.requested_protocol
  );
  const resolvedEffectiveProtocol = nonEmpty(
    effectiveProtocol || metrics.effective_protocol
  );
  const resolvedResponseId = nonEmpty(responseId || metrics.response_id);
  const resolvedSource = nonEmpty(
    source ||
      metrics.execution_source ||
      (resolvedResponseId ? "responses_runtime" : "provider")
  );

  return {
    model: resolvedModel,
    provider: resolvedProvider,
    requestedProtocol: resolvedRequestedProtocol,
    effectiveProtocol: resolvedEffectiveProtocol,
    responseId: resolvedResponseId,
    source: resolvedSource || UNKNOWN_EXECUTION_SOURCE,
    ...(nonEmpty(requestedModel)
      ? { requestedModel: nonEmpty(requestedModel) }
      : {}),
    ...(nonEmpty(effectiveModel)
      ? { effectiveModel: nonEmpty(effectiveModel) }
      : {}),
    ...(nonEmpty(turnMode) ? { turnMode: nonEmpty(turnMode) } : {}),
    ...(nonEmpty(goalId) ? { goalId: nonEmpty(goalId) } : {}),
    ...(nonEmpty(planId) ? { planId: nonEmpty(planId) } : {}),
    ...(nonEmpty(planAction) ? { planAction: nonEmpty(planAction) } : {}),
  };
}

function unknownExecutionMetadata() {
  return {
    model: null,
    provider: null,
    requestedProtocol: null,
    effectiveProtocol: null,
    responseId: null,
    source: UNKNOWN_EXECUTION_SOURCE,
  };
}

module.exports = {
  executionMetadata,
  unknownExecutionMetadata,
};
