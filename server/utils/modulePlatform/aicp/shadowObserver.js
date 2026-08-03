const crypto = require("crypto");
const {
  currentOperationContext,
} = require("../../observability/operationContext");
const { metrics } = require("../../observability/metrics");
const { loadManifests } = require("../manifestRegistry");
const {
  buildDeclaredLinks,
  buildRuntimeTopology,
  patternMatches,
  stableLinkId,
} = require("./links");

const DEFAULT_MAX_EVENTS = 5_000;
const DEFAULT_MAX_TRACES = 1_000;
const DEFAULT_MAX_TRACE_ENTRIES = 100;
const FAILURE_OUTCOMES = new Set([
  "denied",
  "error",
  "failed",
  "failure",
  "rejected",
  "timeout",
]);
const CATEGORY_MODULES = Object.freeze({
  agent: "agent-runtime",
  agent_tool: "tool-runtime",
  browser: "browser-plane",
  "browser-plane": "browser-plane",
  chat: "chat-runtime",
  chat_client: "chat-runtime",
  "crypto-account-access": "crypto-account-access",
  crypto_forecasting: "crypto-forecast",
  crypto_market: "crypto-market",
  database: "athena-api",
  knowledge: "rag",
  model: "model-gateway",
  scheduler: "scheduler",
});
const GENERIC_LIFECYCLE_PATHS = new Set([
  "/accepts",
  "/health",
  "/internal/drain",
  "/live",
  "/metrics",
  "/process",
  "/ready",
  "/snapshot",
]);

function enabled(env = process.env) {
  return (
    String(env.ATHENA_AICP_SHADOW_OBSERVATION_ENABLED || "true")
      .trim()
      .toLowerCase() !== "false"
  );
}

function compact(value, max = 160) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function safeCode(value) {
  const candidate = compact(value, 160);
  return candidate && /^[A-Za-z0-9_.:-]+$/.test(candidate) ? candidate : null;
}

function routeMatches(route, pathname) {
  const prefix = String(route || "").replace(/\/+$/, "");
  if (!prefix) return false;
  const pattern = prefix
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/");
  return new RegExp(`^${pattern}(?:/|$)`).test(String(pathname || ""));
}

function runtimeLink({ type, from, to, capability, transport }) {
  const identity = { type, from, to, capability, transport };
  return {
    schema: "athena.aicp.link",
    schemaVersion: "1.0",
    id: stableLinkId(identity),
    type,
    from,
    to,
    capability,
    transport,
    direction: "outbound",
    source: "runtime-observation",
    metadata: { observationMode: "metadata-only" },
    state: {
      status: "observed",
      lastObservedAt: null,
      latencyMs: null,
      errorRate: null,
      evidence: [],
    },
  };
}

class AicpShadowObserver {
  constructor({
    env = process.env,
    manifests = loadManifests,
    maxEvents = DEFAULT_MAX_EVENTS,
    maxTraces = DEFAULT_MAX_TRACES,
    maxTraceEntries = DEFAULT_MAX_TRACE_ENTRIES,
  } = {}) {
    this.enabled = enabled(env);
    this.sampleRate = Math.max(
      0,
      Math.min(Number(env.ATHENA_AICP_SHADOW_SAMPLE_RATE ?? 0.1), 1)
    );
    this.manifests = manifests();
    this.maxEvents = Math.max(100, Number(maxEvents) || DEFAULT_MAX_EVENTS);
    this.maxTraces = Math.max(10, Number(maxTraces) || DEFAULT_MAX_TRACES);
    this.maxTraceEntries = Math.max(
      10,
      Number(maxTraceEntries) || DEFAULT_MAX_TRACE_ENTRIES
    );
    this.byId = new Map(
      this.manifests.map((manifest) => [manifest.id, manifest])
    );
    this.byRuntimeRole = new Map(
      this.manifests.map((manifest) => [manifest.runtimeRole, manifest.id])
    );
    this.declaredLinks = buildDeclaredLinks({ manifests: this.manifests });
    this.seenEventIds = new Set();
    this.eventOrder = [];
    this.linkAggregates = new Map();
    this.runtimeLinks = new Map();
    this.traces = new Map();
    this.stats = {
      semanticEvents: 0,
      duplicateEvents: 0,
      mappedEvents: 0,
      unmappedEvents: 0,
      contractDriftEvents: 0,
      rpcCalls: 0,
      duplicateRpcCalls: 0,
      rpcFailures: 0,
      rpcContractDriftCalls: 0,
      tracesObserved: 0,
    };
  }

  moduleForEvent(event = {}) {
    const component = compact(event.subject?.component);
    if (component && this.byId.has(component)) return component;

    const eventType = compact(event.eventType, 128);
    const matchingPublishers = this.manifests.filter((manifest) =>
      manifest.events.publishes.some((pattern) =>
        patternMatches(pattern, eventType)
      )
    );
    if (matchingPublishers.length === 1) return matchingPublishers[0].id;

    const categoryModule = CATEGORY_MODULES[String(event.category || "")];
    if (categoryModule && this.byId.has(categoryModule)) return categoryModule;

    const runtimeRole = compact(event.producer?.runtimeRole, 96);
    if (runtimeRole && this.byRuntimeRole.has(runtimeRole))
      return this.byRuntimeRole.get(runtimeRole);

    const service = compact(event.producer?.service);
    if (service && this.byId.has(service)) return service;
    if (service && this.byRuntimeRole.has(service))
      return this.byRuntimeRole.get(service);
    return null;
  }

  moduleForCaller(callerRole) {
    const role = compact(callerRole, 96);
    if (!role) return null;
    if (this.byId.has(role)) return role;
    return this.byRuntimeRole.get(role) || null;
  }

  targetForUrl(value) {
    let target;
    try {
      target = new URL(value);
    } catch {
      return null;
    }
    const hostname = String(target.hostname || "").toLowerCase();
    const hostModule = this.manifests.find(
      (manifest) =>
        manifest.id === hostname || manifest.runtimeRole === hostname
    );
    if (hostModule) {
      const route = hostModule.routes.internal
        .filter((candidate) => routeMatches(candidate, target.pathname))
        .sort((left, right) => right.length - left.length)[0];
      return {
        moduleId: hostModule.id,
        route: route || "undeclared-internal-route",
        contractConformant: Boolean(route),
      };
    }
    if (GENERIC_LIFECYCLE_PATHS.has(target.pathname)) return null;
    const candidates = this.manifests
      .flatMap((manifest) =>
        manifest.routes.internal
          .filter((route) => routeMatches(route, target.pathname))
          .map((route) => ({ moduleId: manifest.id, route }))
      )
      .sort((left, right) => right.route.length - left.route.length);
    return candidates[0]
      ? { ...candidates[0], contractConformant: true }
      : null;
  }

  rememberEvent(eventId) {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    this.eventOrder.push(eventId);
    while (this.eventOrder.length > this.maxEvents) {
      const expired = this.eventOrder.shift();
      this.seenEventIds.delete(expired);
    }
    return true;
  }

  recordLink(
    link,
    { observedAt, latencyMs = null, failed = false, evidence = [] }
  ) {
    const current = this.linkAggregates.get(link.id) || {
      linkId: link.id,
      count: 0,
      failures: 0,
      latencyTotalMs: 0,
      latencySamples: 0,
      observedAt: null,
      evidence: [],
    };
    current.count += 1;
    if (failed) current.failures += 1;
    if (Number.isFinite(latencyMs)) {
      current.latencyTotalMs += latencyMs;
      current.latencySamples += 1;
    }
    current.observedAt = observedAt;
    current.evidence = [...current.evidence, ...evidence]
      .filter((item) => item?.type && item?.ref)
      .slice(-20);
    this.linkAggregates.set(link.id, current);
    if (link.source === "runtime-observation")
      this.runtimeLinks.set(link.id, link);
  }

  recordTrace(traceId, entry) {
    const id = compact(traceId, 64);
    if (!id) return;
    if (!this.traces.has(id)) {
      this.traces.set(id, []);
      this.stats.tracesObserved += 1;
    }
    const entries = this.traces.get(id);
    entries.push(entry);
    if (entries.length > this.maxTraceEntries)
      entries.splice(0, entries.length - this.maxTraceEntries);
    this.traces.delete(id);
    this.traces.set(id, entries);
    while (this.traces.size > this.maxTraces)
      this.traces.delete(this.traces.keys().next().value);
  }

  observeSemanticEvent(event = {}) {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    const eventId = compact(event.eventId, 128);
    const eventType = compact(event.eventType, 128);
    if (!eventId || !eventType)
      return { accepted: false, reason: "event_identity_missing" };
    if (eventType === "aicp.rpc.observed")
      return this.observeResolvedRpc({
        observationId: event.subject?.id,
        from: event.subject?.component,
        to: event.impact?.scope,
        capability: event.subject?.operation,
        transport: event.metadata?.backend,
        outcome: event.outcome,
        durationMs: Number(event.metadata?.durationMs),
        statusCode: Number(event.metadata?.statusCode),
        errorCode: event.metadata?.errorCode,
        contractConformant:
          event.metadata?.validationStatus !== "contract_drift",
        context: event.correlation || {},
        occurredAt: event.occurredAt,
      });
    if (!this.rememberEvent(eventId)) {
      this.stats.duplicateEvents += 1;
      metrics.aicpShadowObservations.inc({
        kind: "event",
        outcome: "duplicate",
      });
      return { accepted: false, reason: "duplicate" };
    }

    this.stats.semanticEvents += 1;
    const observedAt = new Date().toISOString();
    const moduleId = this.moduleForEvent(event);
    const traceId = compact(event.correlation?.traceId, 64);
    const failed = FAILURE_OUTCOMES.has(
      String(event.outcome || "").toLowerCase()
    );
    const evidence = [
      { type: "event", ref: eventId },
      ...(traceId ? [{ type: "trace", ref: traceId }] : []),
    ];
    const linkIds = [];
    let contractConformant = false;

    if (moduleId) {
      this.stats.mappedEvents += 1;
      const manifest = this.byId.get(moduleId);
      contractConformant = manifest.events.publishes.some((pattern) =>
        patternMatches(pattern, eventType)
      );
      if (!contractConformant) this.stats.contractDriftEvents += 1;

      const declaredOperationsLink = this.declaredLinks.find(
        (link) =>
          link.type === "event" &&
          link.from === moduleId &&
          link.to === "operations-plane" &&
          link.capability === "*"
      );
      if (declaredOperationsLink) {
        this.recordLink(declaredOperationsLink, {
          observedAt,
          failed,
          evidence,
        });
        linkIds.push(declaredOperationsLink.id);
      }

      const observedLink = runtimeLink({
        type: "event",
        from: moduleId,
        to: "operations-plane",
        capability: eventType,
        transport: "operations-jetstream",
      });
      this.recordLink(observedLink, { observedAt, failed, evidence });
      linkIds.push(observedLink.id);
    } else {
      this.stats.unmappedEvents += 1;
    }
    metrics.aicpShadowObservations.inc({
      kind: "event",
      outcome: !moduleId
        ? "unmapped"
        : contractConformant
          ? "observed"
          : "contract_drift",
    });
    metrics.aicpShadowTraceCoverage.inc({
      kind: "event",
      coverage: traceId ? "complete" : "missing",
    });

    this.recordTrace(traceId, {
      observationId: `event:${eventId}`,
      kind: "event",
      eventId,
      eventType,
      moduleId,
      operationId: compact(event.correlation?.operationId),
      occurredAt: event.occurredAt || observedAt,
      observedAt,
      outcome: compact(event.outcome, 48),
      linkIds,
    });
    return { accepted: true, moduleId, contractConformant, linkIds };
  }

  observeRpcCall({
    observationId = crypto.randomUUID(),
    callerRole,
    url,
    method = "POST",
    outcome = "success",
    durationMs = null,
    statusCode = null,
    errorCode = null,
    context = currentOperationContext() || {},
  } = {}) {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    const from = this.moduleForCaller(callerRole);
    const target = this.targetForUrl(url);
    if (!from || !target)
      return { accepted: false, reason: "rpc_route_unresolved" };

    return this.observeResolvedRpc({
      observationId,
      from,
      to: target.moduleId,
      capability: `${String(method || "POST").toUpperCase()} ${target.route}`,
      transport: String(url).startsWith("https:") ? "mtls-https" : "http",
      outcome,
      durationMs,
      statusCode,
      errorCode,
      contractConformant: target.contractConformant,
      context,
    });
  }

  observeResolvedRpc({
    observationId,
    from,
    to,
    capability,
    transport,
    outcome = "success",
    durationMs = null,
    statusCode = null,
    errorCode = null,
    contractConformant = true,
    context = {},
    occurredAt = null,
  } = {}) {
    if (!this.enabled) return { accepted: false, reason: "disabled" };
    const id = compact(observationId, 128);
    if (
      !id ||
      !this.byId.has(String(from)) ||
      !this.byId.has(String(to)) ||
      !compact(capability) ||
      !compact(transport)
    )
      return { accepted: false, reason: "rpc_metadata_invalid" };
    if (!this.rememberEvent(`rpc:${id}`)) {
      this.stats.duplicateRpcCalls += 1;
      metrics.aicpShadowObservations.inc({
        kind: "rpc",
        outcome: "duplicate",
      });
      return { accepted: false, reason: "duplicate" };
    }

    this.stats.rpcCalls += 1;
    if (!contractConformant) this.stats.rpcContractDriftCalls += 1;
    const failed = String(outcome) !== "success";
    if (failed) this.stats.rpcFailures += 1;
    metrics.aicpShadowObservations.inc({
      kind: "rpc",
      outcome: !contractConformant
        ? "contract_drift"
        : failed
          ? "failed"
          : "observed",
    });
    const observedAt = occurredAt || new Date().toISOString();
    const link = runtimeLink({
      type: "rpc",
      from,
      to,
      capability,
      transport,
    });
    const traceId = compact(context.traceId, 64);
    metrics.aicpShadowTraceCoverage.inc({
      kind: "rpc",
      coverage: traceId ? "complete" : "missing",
    });
    const evidence = traceId ? [{ type: "trace", ref: traceId }] : [];
    this.recordLink(link, {
      observedAt,
      latencyMs: Number.isFinite(durationMs) ? durationMs : null,
      failed,
      evidence,
    });

    const declaredCandidates = this.declaredLinks.filter(
      (candidate) =>
        candidate.type === "rpc" &&
        candidate.from === from &&
        candidate.to === to
    );
    if (declaredCandidates.length === 1)
      this.recordLink(declaredCandidates[0], {
        observedAt,
        latencyMs: Number.isFinite(durationMs) ? durationMs : null,
        failed,
        evidence,
      });

    const linkIds = [
      link.id,
      ...(declaredCandidates.length === 1 ? [declaredCandidates[0].id] : []),
    ];
    this.recordTrace(traceId, {
      observationId: `rpc:${id}`,
      kind: "rpc",
      from,
      to,
      capability,
      operationId: compact(context.operationId),
      occurredAt: observedAt,
      observedAt,
      outcome: failed ? "failed" : "success",
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      errorCode: safeCode(errorCode),
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      contractConformant: Boolean(contractConformant),
      linkIds,
    });
    return {
      accepted: true,
      observationId: id,
      from,
      to,
      capability,
      transport,
      contractConformant: Boolean(contractConformant),
      linkIds,
    };
  }

  observations() {
    return [...this.linkAggregates.values()].map((aggregate) => ({
      linkId: aggregate.linkId,
      status: aggregate.failures > 0 ? "degraded" : "observed",
      observedAt: aggregate.observedAt,
      latencyMs: aggregate.latencySamples
        ? aggregate.latencyTotalMs / aggregate.latencySamples
        : null,
      errorRate: aggregate.count ? aggregate.failures / aggregate.count : null,
      evidence: aggregate.evidence,
    }));
  }

  runtimeLinkSnapshot() {
    const observations = new Map(
      this.observations().map((observation) => [
        observation.linkId,
        observation,
      ])
    );
    return [...this.runtimeLinks.values()].map((link) => {
      const observation = observations.get(link.id);
      return {
        ...link,
        state: {
          status: observation?.status || "observed",
          lastObservedAt: observation?.observedAt || null,
          latencyMs: observation?.latencyMs ?? null,
          errorRate: observation?.errorRate ?? null,
          evidence: observation?.evidence || [],
        },
      };
    });
  }

  topology() {
    return buildRuntimeTopology({
      manifests: this.manifests,
      observations: this.observations(),
      runtimeLinks: this.runtimeLinkSnapshot(),
    });
  }

  trace(traceId) {
    const id = compact(traceId, 64);
    const entries = id ? this.traces.get(id) || [] : [];
    return {
      traceId: id,
      found: entries.length > 0,
      entries: entries.map((entry) => ({
        ...entry,
        linkIds: [...entry.linkIds],
      })),
    };
  }

  health() {
    const observations = this.observations();
    return {
      enabled: this.enabled,
      mode: "shadow-read-only",
      sampleRate: this.sampleRate,
      status: this.enabled ? "observing" : "disabled",
      observedLinks: observations.length,
      runtimeLinks: this.runtimeLinks.size,
      traces: this.traces.size,
      ...this.stats,
    };
  }

  reset() {
    this.seenEventIds.clear();
    this.eventOrder.splice(0);
    this.linkAggregates.clear();
    this.runtimeLinks.clear();
    this.traces.clear();
    for (const key of Object.keys(this.stats)) this.stats[key] = 0;
  }
}

const aicpShadowObserver = new AicpShadowObserver();

module.exports = {
  AicpShadowObserver,
  aicpShadowObservationEnabled: enabled,
  aicpShadowObserver,
};
