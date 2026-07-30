const { eventComponent } = require("./stateGraph");

function severityRank(value) {
  return { debug: 0, info: 1, warning: 2, error: 3, critical: 4 }[value] ?? 0;
}

function correlationKey(event = {}) {
  const correlation = event.correlation || {};
  for (const field of [
    "operationId",
    "clientTurnId",
    "invocationId",
    "toolCallId",
    "sourceActionId",
    "requestId",
  ]) {
    if (correlation[field]) return `${field}:${correlation[field]}`;
  }
  return null;
}

function flowKind(events = []) {
  const types = events.map((event) => String(event.eventType || ""));
  const categories = new Set(events.map((event) => event.category));
  if (
    categories.has("crypto-account-access") ||
    types.some((type) => type.startsWith("crypto.account."))
  )
    return "crypto-account";
  if (
    categories.has("agent_tool") ||
    types.some((type) => /tool|approval/.test(type))
  )
    return "tool";
  if (
    categories.has("agent") ||
    types.some((type) => type.startsWith("agent."))
  )
    return "agent";
  if (
    categories.has("chat") ||
    categories.has("chat_client") ||
    types.some((type) => type.startsWith("chat."))
  )
    return "chat";
  if (types.some((type) => /^(login|auth|authentication)\./.test(type)))
    return "authentication";
  if (types.some((type) => /^scheduler\.|^scheduled\./.test(type)))
    return "scheduler";
  if (
    categories.has("knowledge") ||
    types.some((type) => type.startsWith("knowledge."))
  )
    return "knowledge";
  return "system";
}

function terminalEvent(event = {}) {
  return (
    ["completed", "failed", "denied", "timeout", "recovered"].includes(
      event.outcome
    ) ||
    /\.(completed|failed|denied|timed_out|closed|recovered)$/.test(
      String(event.eventType || "")
    )
  );
}

function projectFlow(key, inputEvents = []) {
  const events = [...inputEvents].sort(
    (left, right) =>
      Date.parse(left.occurredAt || 0) - Date.parse(right.occurredAt || 0)
  );
  const first = events[0] || {};
  const last = events.at(-1) || {};
  const failed = events.some(
    (event) =>
      severityRank(event.severity) >= 3 ||
      ["failed", "failure", "timeout", "degraded", "denied"].includes(
        event.outcome
      )
  );
  const terminal = events.some(terminalEvent);
  const startedAt = first.occurredAt || null;
  const endedAt = terminal ? last.occurredAt || null : null;
  const durationMs =
    startedAt && endedAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : null;
  return {
    correlationKey: key,
    kind: flowKind(events),
    status: failed ? "failed" : terminal ? "completed" : "in_progress",
    startedAt,
    endedAt,
    durationMs,
    eventCount: events.length,
    modules: [
      ...new Set(events.map((event) => eventComponent(event)).filter(Boolean)),
    ],
    correlation: first.correlation || {},
    stages: events.map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      outcome: event.outcome,
      severity: event.severity,
      module: eventComponent(event),
    })),
    effectiveness: {
      terminalObserved: terminal,
      successful: terminal && !failed,
      metadataOnly: events.every(
        (event) => event.sensitivity === "metadata_only"
      ),
    },
  };
}

function projectFlows(events = []) {
  const grouped = new Map();
  for (const event of events) {
    const key = correlationKey(event);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  const flows = [...grouped.entries()]
    .map(([key, groupedEvents]) => projectFlow(key, groupedEvents))
    .sort(
      (left, right) =>
        Date.parse(right.startedAt || 0) - Date.parse(left.startedAt || 0)
    );
  return {
    flows,
    summary: {
      total: flows.length,
      completed: flows.filter((flow) => flow.status === "completed").length,
      failed: flows.filter((flow) => flow.status === "failed").length,
      inProgress: flows.filter((flow) => flow.status === "in_progress").length,
      successful: flows.filter((flow) => flow.effectiveness.successful).length,
    },
  };
}

module.exports = {
  correlationKey,
  flowKind,
  projectFlow,
  projectFlows,
  terminalEvent,
};
