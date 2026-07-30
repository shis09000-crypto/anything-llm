const { serviceCatalog } = require("./serviceCatalog");

function severityRank(value) {
  return { debug: 0, info: 1, warning: 2, error: 3, critical: 4 }[value] ?? 0;
}

function eventComponent(event = {}) {
  const direct =
    event.subject?.component ||
    (event.subject?.type === "service" ? event.subject.id : null) ||
    null;
  const known = new Set(serviceCatalog().map((service) => service.id));
  if (known.has(direct)) return direct;
  if (event.category === "database") return "main-database";
  if (event.category === "model") return "model-provider";
  if (event.category === "knowledge") return "rag";
  if (event.category === "chat" || event.category === "chat_client")
    return "chat-runtime";
  if (event.category === "agent_tool") return "tool-runtime";
  if (event.category === "agent") return "agent-runtime";
  if (event.category === "crypto-account-access")
    return "crypto-account-access";
  if (event.category === "crypto_forecasting") return "crypto-forecast";
  if (event.category === "module_health")
    return known.has(event.subject?.id) ? event.subject.id : direct;
  if (
    String(event.eventType || "").startsWith("scheduler.") ||
    String(event.eventType || "").startsWith("scheduled.")
  )
    return "scheduler";
  if (String(event.eventType || "").startsWith("crypto.market."))
    return "crypto-market";
  if (String(event.eventType || "").startsWith("crypto.account."))
    return "crypto-account-access";
  if (String(event.eventType || "").startsWith("model."))
    return "model-gateway";
  if (event.category === "golden_journey") {
    if (String(event.eventType).startsWith("login.")) return "authentication";
    if (String(event.eventType).startsWith("chat.")) return "chat-runtime";
    if (String(event.eventType).startsWith("agent_tool."))
      return "tool-runtime";
    if (String(event.eventType).startsWith("knowledge_ingest."))
      return "knowledge-ingest";
    if (String(event.eventType).startsWith("cross_device_sync."))
      return "sync-v2";
  }
  if (direct === "http") return "athena-api";
  return direct;
}

function stateFromEvents(serviceId, events = []) {
  const related = events.filter((event) => eventComponent(event) === serviceId);
  if (!related.length) return { status: "unknown", lastEventAt: null };
  const latest = [...related].sort(
    (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
  )[0];
  const worst = related.reduce(
    (result, event) =>
      severityRank(event.severity) > severityRank(result.severity)
        ? event
        : result,
    latest
  );
  return {
    status:
      severityRank(worst.severity) >= 3
        ? "degraded"
        : worst.outcome === "failed"
          ? "degraded"
          : "observed",
    severity: worst.severity,
    lastEventAt: latest.occurredAt,
    evidenceEventIds: related.slice(0, 10).map((event) => event.eventId),
  };
}

function reverseDependencies(services) {
  const reverse = new Map();
  for (const service of services) {
    for (const dependency of service.dependsOn || []) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(service.id);
    }
  }
  return reverse;
}

function affectedServices(component, services) {
  if (!component) return [];
  const known = new Set(services.map((service) => service.id));
  if (!known.has(component)) return [];
  const reverse = reverseDependencies(services);
  const visited = new Set([component]);
  const queue = [component];
  while (queue.length) {
    const current = queue.shift();
    for (const dependent of reverse.get(current) || []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      queue.push(dependent);
    }
  }
  return [...visited];
}

function buildStateGraph({
  events = [],
  agents = [],
  syncState = null,
  moduleHealth = null,
} = {}) {
  const services = serviceCatalog();
  const runtimeStates = new Map(
    (moduleHealth?.modules || []).map((state) => [state.moduleId, state])
  );
  const nodes = services.map((service) => ({
    id: service.id,
    type: service.kind,
    label: service.name,
    owner: service.owner,
    criticality: service.criticality,
    capabilities: service.capabilities,
    state: (() => {
      const runtime = runtimeStates.get(service.id);
      if (runtime && runtime.status !== "unmonitored")
        return {
          status: runtime.status,
          ready: runtime.ready,
          reasonCode: runtime.reasonCode,
          checkedAt: runtime.checkedAt,
          durationMs: runtime.durationMs,
          expectedVersion: runtime.expectedVersion,
          observedVersion: runtime.observedVersion,
          source: runtime.source,
        };
      if (service.id === "sync-v2" && syncState)
        return {
          status:
            syncState.ready && Number(syncState.deadLetterOutbox || 0) === 0
              ? "healthy"
              : "degraded",
          pendingOutbox: syncState.pendingOutbox || 0,
          maxCursorLag: syncState.maxCursorLag || 0,
          source: "sync-runtime",
        };
      const eventState = stateFromEvents(service.id, events);
      if (eventState.status !== "unknown") return eventState;
      if (runtime)
        return {
          status: runtime.status,
          ready: runtime.ready,
          reasonCode: runtime.reasonCode,
          checkedAt: runtime.checkedAt,
          source: runtime.source,
        };
      return eventState;
    })(),
  }));
  for (const agent of agents) {
    nodes.push({
      id: `agent:${agent.id}`,
      type: "agent",
      label: agent.name,
      version: agent.version,
      state: { status: agent.status },
      capabilities: agent.capabilities || [],
    });
  }
  const edges = services.flatMap((service) =>
    (service.dependsOn || []).map((dependency) => ({
      from: service.id,
      to: dependency,
      relation: "depends_on",
    }))
  );
  for (const agent of agents)
    edges.push({
      from: `agent:${agent.id}`,
      to: "agent-runtime",
      relation: "runs_on",
    });
  const statuses = nodes.map((node) => node.state?.status || "unknown");
  const unknown = statuses.filter((status) => status === "unknown").length;
  const unmonitored = statuses.filter(
    (status) => status === "unmonitored"
  ).length;
  const monitored = nodes.length - unknown - unmonitored;
  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    summary: {
      nodes: nodes.length,
      edges: edges.length,
      degraded: nodes.filter((node) => node.state?.status === "degraded")
        .length,
      healthy: nodes.filter((node) => node.state?.status === "healthy").length,
      unknown,
      unmonitored,
      monitored,
      coverageRatio: nodes.length ? monitored / nodes.length : 0,
      complete: nodes.length > 0 && unknown === 0 && unmonitored === 0,
    },
  };
}

function explainEvent(event, services = serviceCatalog()) {
  if (!event) return null;
  const component = eventComponent(event);
  const impacted = affectedServices(component, services);
  return {
    eventId: event.eventId,
    whatHappened: {
      eventType: event.eventType,
      outcome: event.outcome,
      severity: event.severity,
      occurredAt: event.occurredAt,
      stateTransition: event.stateTransition || {},
    },
    affectedSubjects: {
      direct: event.subject || {},
      services: impacted,
      declaredImpact: event.impact || {},
    },
    evidence: event.evidence || [],
    possibleCauses: event.hypotheses || [],
    recommendation: event.recommendation || {},
    correlation: event.correlation || {},
  };
}

module.exports = {
  affectedServices,
  buildStateGraph,
  eventComponent,
  explainEvent,
};
