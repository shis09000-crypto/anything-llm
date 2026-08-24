const express = require("express");
const http = require("http");
const https = require("https");
const { moduleManifest } = require("../modulePlatform/manifestRegistry");
const {
  expectedServiceId,
  loadServiceIdentity,
  serviceIdentitySummary,
} = require("../security/serviceIdentity");
const { metricsEndpoint } = require("../observability/metrics");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const { ModuleLifecycle } = require("./lifecycle");
const {
  AicpContractRegistry,
  aicpEnforcementMode,
  aicpLinkEnforcementMode,
  decodeAicpHeader,
  validateCoordinationContext,
} = require("../modulePlatform/aicp/contractRegistry");
const {
  AICP_CONTEXT_HEADER,
  AICP_RESULT_HEADER,
  createAicpResult,
  decodeAicpContext,
  encodeAicpContext,
  validateAicpContext,
} = require("../modulePlatform/aicp/context");

const LIFECYCLE_CAPABILITIES = Object.freeze({
  "/internal/v1/describe": "module.describe",
  "/internal/v1/self-test": "module.self-test",
  "/internal/v1/lifecycle": "module.lifecycle.query",
  "/internal/drain": "module.drain",
  "/internal/v1/quiesce": "module.quiesce",
  "/internal/v1/resume": "module.resume",
});

function distributedTopology(env = process.env) {
  return ["distributed", "micro-modules"].includes(
    String(env.ATHENA_RUNTIME_TOPOLOGY || "")
      .trim()
      .toLowerCase()
  );
}

function peerServiceIds(request) {
  const certificate = request.socket?.getPeerCertificate?.();
  return String(
    certificate?.subjectaltname || certificate?.subjectAltName || ""
  )
    .split(/,\s*/)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));
}

function routePatternMatches(pattern, requestPath) {
  const patternSegments = String(pattern || "").split("/");
  const requestSegments = String(requestPath || "").split("/");
  if (patternSegments.length !== requestSegments.length) return false;
  return patternSegments.every(
    (segment, index) =>
      segment.startsWith(":") || segment === requestSegments[index]
  );
}

function internalRouteCapability(capabilities, method, requestPath) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const direct =
    capabilities[`${normalizedMethod} ${requestPath}`] ||
    capabilities[requestPath];
  if (direct) return direct;
  for (const [route, capability] of Object.entries(capabilities)) {
    const methodMatch = route.match(/^([A-Z]+)\s+(.+)$/);
    const routeMethod = methodMatch?.[1] || null;
    const routePath = methodMatch?.[2] || route;
    if (routeMethod && routeMethod !== normalizedMethod) continue;
    if (routePatternMatches(routePath, requestPath)) return capability;
  }
  return null;
}

function aicpRequestPayload(request) {
  const hasBody =
    Number(request.get?.("content-length") || 0) > 0 ||
    Boolean(request.get?.("transfer-encoding"));
  return hasBody ? request.body ?? null : null;
}

function internalPeerAuthorized(request, manifest, env = process.env) {
  if (!distributedTopology(env)) return { authorized: true, caller: "local" };
  if (!request.socket?.authorized)
    return {
      authorized: false,
      reason: request.socket?.authorizationError || "mtls_peer_unverified",
    };
  const allowed = new Set(
    manifest.security.allowedCallers.map((caller) => {
      const callerManifest = moduleManifest(caller);
      return expectedServiceId(callerManifest?.runtimeRole || caller, env);
    })
  );
  const caller = peerServiceIds(request).find((serviceId) =>
    allowed.has(serviceId)
  );
  return caller
    ? { authorized: true, caller }
    : { authorized: false, reason: "mtls_caller_not_allowed" };
}

async function validateAicpPeerRequest(
  request,
  manifest,
  {
    callerServiceId = null,
    env = process.env,
    principalAssertionVerifier = null,
    operationsApprovalVerifier = null,
    expectedCapability = null,
    response = null,
  } = {}
) {
  const globalMode = aicpEnforcementMode(env);
  if (globalMode === "off") return { authorized: true, mode: globalMode };
  const registry = new AicpContractRegistry();
  let unifiedContext = null;
  const encodedUnifiedContext = request.get(AICP_CONTEXT_HEADER);
  if (encodedUnifiedContext) {
    try {
      unifiedContext = decodeAicpContext(encodedUnifiedContext);
    } catch (error) {
      return {
        authorized: false,
        mode: globalMode,
        reason: error.code || "aicp_context_invalid",
      };
    }
  }
  const callerRole = String(callerServiceId || "")
    .split("/")
    .filter(Boolean)
    .at(-1);
  const caller = registry.module(
    request.get("x-athena-aicp-caller") || callerRole
  );
  const capability = String(request.get("x-athena-aicp-capability") || "");
  const target = String(request.get("x-athena-aicp-target") || "");
  const requestPath = String(request.originalUrl || request.path || "").split(
    "?"
  )[0];
  const expectedLifecycle = LIFECYCLE_CAPABILITIES[requestPath];
  const expectedContract = expectedLifecycle || expectedCapability;
  const mode = aicpLinkEnforcementMode({
    callerModule: caller?.id || callerRole,
    targetModule: manifest.id,
    capability: capability || expectedContract,
    env,
  });
  if (!caller || !capability || target !== manifest.id) {
    return mode === "enforce"
      ? { authorized: false, mode, reason: "aicp_contract_context_missing" }
      : { authorized: true, mode, observed: false };
  }

  let negotiation;
  if (expectedContract) {
    if (capability !== expectedContract)
      return {
        authorized: false,
        mode,
        reason: "aicp_lifecycle_capability_mismatch",
      };
    try {
      negotiation = registry.negotiate({
        callerModule: caller.id,
        targetModule: manifest.id,
        capability,
        version: request.get("x-athena-aicp-contract-version"),
      });
    } catch (error) {
      return mode === "enforce"
        ? { authorized: false, mode, reason: error.code || error.message }
        : {
            authorized: true,
            mode,
            observed: false,
            reason: error.code || error.message,
          };
    }
  } else {
    try {
      negotiation = registry.negotiate({
        callerModule: caller.id,
        targetModule: manifest.id,
        capability,
        version: request.get("x-athena-aicp-contract-version"),
      });
    } catch (error) {
      return mode === "enforce"
        ? { authorized: false, mode, reason: error.code || error.message }
        : {
            authorized: true,
            mode,
            observed: false,
            reason: error.code || error.message,
          };
    }
  }

  const linkId = request.get("x-athena-aicp-link-id");
  const fingerprint = request.get("x-athena-aicp-contract-fingerprint");
  if (linkId !== negotiation.linkId)
    return { authorized: false, mode, reason: "aicp_link_id_mismatch" };
  if (fingerprint !== negotiation.contractFingerprint)
    return {
      authorized: false,
      mode,
      reason: "aicp_contract_fingerprint_mismatch",
    };

  if (unifiedContext) {
    const validation = validateAicpContext(unifiedContext, {
      payload: aicpRequestPayload(request),
      method: request.method,
      path: request.originalUrl || request.path,
    });
    if (!validation.valid)
      return {
        authorized: false,
        mode,
        reason: validation.findings[0],
      };
    if (
      unifiedContext.source !== caller.id ||
      unifiedContext.target !== manifest.id ||
      unifiedContext.capability?.id !== capability
    )
      return {
        authorized: false,
        mode,
        reason: "aicp_context_contract_mismatch",
      };
  }

  let coordinationContext = unifiedContext
    ? {
        coordinationRunId: unifiedContext.coordination.runId,
        stepId: unifiedContext.coordination.stepId,
        correlationId: unifiedContext.correlation.correlationId,
        center: unifiedContext.coordination.center,
        priority: unifiedContext.coordination.priority,
        deadlineAt: unifiedContext.coordination.deadlineAt,
        causationId: unifiedContext.correlation.causationId || null,
      }
    : null;
  const encodedContext = request.get("x-athena-aicp-coordination");
  if (encodedContext) {
    try {
      coordinationContext = decodeAicpHeader(encodedContext);
    } catch (error) {
      return {
        authorized: false,
        mode,
        reason: error.code || "aicp_context_invalid",
      };
    }
    const validation = validateCoordinationContext(coordinationContext, {
      required: true,
    });
    if (!validation.valid)
      return { authorized: false, mode, reason: validation.findings[0] };
  }
  if (
    ["Task", "Command"].includes(negotiation.callType) &&
    !coordinationContext
  )
    return mode === "enforce"
      ? {
          authorized: false,
          mode,
          reason: "aicp_coordination_context_required",
        }
      : { authorized: true, mode, observed: false };
  const lifecycleCommand =
    Boolean(expectedLifecycle) && negotiation.callType === "Command";
  if (lifecycleCommand) {
    const approvalId = request.get("x-athena-operations-approval");
    if (!approvalId)
      return {
        authorized: false,
        mode,
        reason: "aicp_operations_approval_required",
      };
    if (typeof operationsApprovalVerifier !== "function")
      return {
        authorized: false,
        mode,
        reason: "aicp_operations_approval_verifier_missing",
      };
    try {
      const approval = await operationsApprovalVerifier(approvalId, {
        audience: manifest.id,
        capability,
        coordinationContext,
        callerModule: caller.id,
      });
      if (approval?.valid !== true)
        return {
          authorized: false,
          mode,
          reason: "aicp_operations_approval_invalid",
        };
    } catch {
      return {
        authorized: false,
        mode,
        reason: "aicp_operations_approval_invalid",
      };
    }
  }

  const encodedAssertion = request.get("x-athena-principal-assertion");
  if (encodedAssertion) {
    if (typeof principalAssertionVerifier !== "function")
      return lifecycleCommand || mode === "enforce"
        ? { authorized: false, mode, reason: "aicp_principal_verifier_missing" }
        : { authorized: true, mode, observed: false };
    try {
      const result = await principalAssertionVerifier(
        decodeAicpHeader(encodedAssertion),
        { audience: manifest.id, capability }
      );
      if (result?.valid !== true)
        return { authorized: false, mode, reason: "aicp_principal_invalid" };
    } catch {
      return { authorized: false, mode, reason: "aicp_principal_invalid" };
    }
  } else if (
    lifecycleCommand ||
    (mode === "enforce" &&
      ["confidential", "restricted"].includes(negotiation.dataClassification))
  ) {
    return { authorized: false, mode, reason: "aicp_principal_required" };
  }
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  request.once("aborted", abort);
  response?.once("close", () => {
    if (!response.writableEnded) abort();
  });
  return {
    authorized: true,
    mode,
    observed: true,
    callerModule: caller.id,
    capability,
    linkId: negotiation.linkId,
    coordinationContext,
    context: unifiedContext,
    abortSignal: abortController.signal,
  };
}

function safeError(error) {
  return String(error?.code || error?.message || "internal_service_failed")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 160);
}

function wrapAsyncRouteHandler(handler) {
  if (Array.isArray(handler)) return handler.map(wrapAsyncRouteHandler);
  if (typeof handler !== "function" || handler.length === 4) return handler;
  return function asyncRouteBoundary(request, response, next) {
    try {
      const result = handler.call(this, request, response, next);
      if (result && typeof result.then === "function") result.catch(next);
      return result;
    } catch (error) {
      next(error);
    }
  };
}

function installAsyncRouteBoundary(app) {
  for (const method of [
    "all",
    "delete",
    "get",
    "head",
    "options",
    "patch",
    "post",
    "put",
    "use",
  ]) {
    const original = app[method];
    if (typeof original !== "function") continue;
    app[method] = function boundedRouteRegistration(...args) {
      return original.apply(
        this,
        args.map((argument) => wrapAsyncRouteHandler(argument))
      );
    };
  }
}

class MicroModuleServiceHost {
  constructor({
    manifestId,
    role,
    port,
    env = process.env,
    registerRoutes = () => {},
    enableWebSockets = false,
    parseJson = true,
    jsonLimit = "256kb",
    onStart = async () => {},
    onDrain = async () => {},
    onCheckpoint = async () => ({}),
    onResume = async () => {},
    onStop = async () => {},
    onLifecycleTransition = () => {},
    onHeartbeat = () => {},
    principalAssertionVerifier = null,
    operationsApprovalVerifier = null,
    readiness = null,
    internalRouteCapabilities = {},
  } = {}) {
    this.env = env;
    this.manifest = moduleManifest(manifestId);
    if (!this.manifest)
      throw new Error(`module_manifest_missing:${manifestId}`);
    this.role = role || this.manifest.runtimeRole;
    this.port = Number(port);
    if (!Number.isInteger(this.port) || this.port < 0)
      throw new Error(`module_port_invalid:${manifestId}`);
    this.registerRoutes = registerRoutes;
    this.enableWebSockets = enableWebSockets;
    this.parseJson = parseJson;
    this.jsonLimit = jsonLimit;
    this.onStart = onStart;
    this.onDrain = onDrain;
    this.onCheckpoint = onCheckpoint;
    this.onResume = onResume;
    this.onStop = onStop;
    this.readiness = readiness;
    this.app = express();
    this.server = null;
    this.status = "created";
    this.startedAt = null;
    this.lastError = null;
    this.inflight = 0;
    this.stopping = false;
    this.drainStarted = false;
    this.heartbeatTimer = null;
    this.onHeartbeat = onHeartbeat;
    this.onLifecycleTransition = onLifecycleTransition;
    this.principalAssertionVerifier = principalAssertionVerifier;
    this.operationsApprovalVerifier = operationsApprovalVerifier;
    const manifestRouteCapabilities = Object.fromEntries(
      (this.manifest.routes?.bindings || []).map((binding) => [
        `${String(binding.method || "GET").toUpperCase()} ${binding.path}`,
        binding.capability,
      ])
    );
    this.internalRouteCapabilities = Object.freeze({
      ...LIFECYCLE_CAPABILITIES,
      ...manifestRouteCapabilities,
      ...internalRouteCapabilities,
    });
    this.lifecycle = new ModuleLifecycle({
      moduleId: this.manifest.id,
      version: this.manifest.version,
      manifestFingerprint: this.manifest.fingerprint,
      heartbeatIntervalMs:
        this.manifest.lifecycle?.heartbeatIntervalMs || 30_000,
      leaseTtlMs: this.manifest.lifecycle?.leaseTtlMs || 90_000,
      onTransition: (event) => {
        this.emitLifecycleEvent("module.lifecycle.transitioned", event);
        try {
          this.onLifecycleTransition(event);
        } catch {
          // A lifecycle observer is never allowed to change module state.
        }
      },
    });
  }

  emitLifecycleEvent(eventType, value = {}) {
    try {
      emitSemanticEvent({
        eventId: value.eventId || undefined,
        eventType,
        occurredAt: value.occurredAt || value.heartbeatAt || undefined,
        category: "module_lifecycle",
        severity:
          value.state === "failed" || value.to === "failed"
            ? "warning"
            : "info",
        outcome: value.state || value.to || "observed",
        subject: {
          type: "module-instance",
          id:
            value.instanceId || this.lifecycle?.instanceId || this.manifest.id,
          component: this.manifest.id,
          operation: eventType,
        },
        correlation: {
          operationId: value.eventId || null,
        },
        stateTransition: value.from ? { from: value.from, to: value.to } : {},
        metadata: {
          moduleId: this.manifest.id,
          runtimeRole: this.role,
          version: this.manifest.version,
          manifestFingerprint: this.manifest.fingerprint,
          instanceId:
            value.instanceId || this.lifecycle?.instanceId || this.manifest.id,
          sequence: Number(value.sequence || this.lifecycle?.sequence || 0),
          reasonCode:
            value.reasonCode || this.lifecycle?.lastReasonCode || null,
          ready: value.ready === true,
          heartbeatAt: value.heartbeatAt || null,
          leaseExpiresAt: value.leaseExpiresAt || null,
        },
        sensitivity: "metadata_only",
      });
    } catch {
      // Operations observation must remain fail-open for the business runtime.
    }
  }

  snapshot() {
    const component = this.readiness?.() || {};
    const componentReady =
      component.ready === undefined ? true : Boolean(component.ready);
    const enforceContractReadiness =
      String(
        this.env.ATHENA_AICP_READINESS_ENFORCEMENT || "false"
      ).toLowerCase() === "true";
    const contractReady =
      !enforceContractReadiness || this.contractClosure.valid === true;
    return {
      moduleId: this.manifest.id,
      role: this.role,
      version: this.manifest.version,
      manifestFingerprint: this.manifest.fingerprint,
      status: this.status,
      ready: this.status === "running" && componentReady && contractReady,
      inflight: this.inflight,
      startedAt: this.startedAt,
      lastError: this.lastError,
      component,
      lifecycle: this.lifecycle.snapshot(),
      serviceIdentity: serviceIdentitySummary(this.role, {
        env: this.env,
        required: false,
      }),
    };
  }

  configureApp() {
    // Express 4 does not forward rejected async route promises to its error
    // middleware. A rejected module RPC must become a scoped 4xx/5xx response,
    // never an unhandled rejection that restarts the whole runtime.
    installAsyncRouteBoundary(this.app);
    this.app.disable("x-powered-by");
    if (this.parseJson) this.app.use(express.json({ limit: this.jsonLimit }));
    else this.app.use("/internal", express.json({ limit: this.jsonLimit }));
    this.app.use((request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      next();
    });
    this.app.get("/live", (_request, response) => {
      const live = !["failed", "stopped"].includes(this.status);
      response.status(live ? 200 : 503).json({
        success: live,
        ...this.snapshot(),
      });
    });
    this.app.get("/ready", (_request, response) => {
      const snapshot = this.snapshot();
      response.status(snapshot.ready ? 200 : 503).json({
        success: snapshot.ready,
        ...snapshot,
      });
    });
    // Keep the legacy readiness URLs stable while every runtime adopts the
    // same lifecycle host. These routes intentionally sit before the work
    // admission gate so Operations can inspect a drained or failed module.
    this.app.get("/health", (_request, response) => {
      const snapshot = this.snapshot();
      response.status(snapshot.ready ? 200 : 503).json({
        success: snapshot.ready,
        ...snapshot,
      });
    });
    this.app.get("/snapshot", (_request, response) => {
      response.status(200).json(this.snapshot());
    });
    this.app.get("/metrics", metricsEndpoint);
    this.app.use("/internal", async (request, response, next) => {
      const decision = internalPeerAuthorized(request, this.manifest, this.env);
      if (!decision.authorized)
        return response.status(401).json({
          success: false,
          error: "internal_service_identity_rejected",
          reasonCode: decision.reason,
        });
      response.locals.serviceCaller = decision.caller;
      const aicp = await validateAicpPeerRequest(request, this.manifest, {
        callerServiceId: decision.caller,
        env: this.env,
        principalAssertionVerifier: this.principalAssertionVerifier,
        operationsApprovalVerifier: this.operationsApprovalVerifier,
        expectedCapability: internalRouteCapability(
          this.internalRouteCapabilities,
          request.method,
          String(request.originalUrl || request.path || "").split("?")[0]
        ),
        response,
      });
      if (!aicp.authorized)
        return response.status(409).json({
          success: false,
          error: "aicp_link_rejected",
          reasonCode: aicp.reason,
        });
      response.locals.aicp = aicp;
      if (aicp.context) {
        const sendJson = response.json.bind(response);
        response.json = (value) => {
          const failed = response.statusCode >= 400 || value?.success === false;
          const result = createAicpResult({
            context: aicp.context,
            status: failed ? "failed" : "completed",
            payload: value,
            errorCode: failed
              ? value?.error || "internal_service_failed"
              : null,
          });
          response.setHeader(AICP_RESULT_HEADER, encodeAicpContext(result));
          response.setHeader(
            "x-athena-aicp-capability-version",
            aicp.context.capability.version
          );
          try {
            emitSemanticEvent({
              eventId: result.messageId,
              eventType: "aicp.result.projected",
              category: "aicp_runtime",
              severity: result.status === "completed" ? "info" : "warning",
              outcome: result.status,
              subject: {
                type: "module-call",
                id: result.messageId,
                component: this.manifest.id,
                operation: aicp.context.capability.id,
              },
              correlation: {
                traceId: aicp.context.correlation.traceId,
                correlationId: aicp.context.correlation.correlationId,
                operationId: aicp.context.correlation.operationId,
              },
              impact: {
                scope: this.manifest.id,
                status: result.status,
              },
              metadata: {
                source: aicp.context.source,
                target: aicp.context.target,
                capability: aicp.context.capability.id,
                capabilityVersion: aicp.context.capability.version,
                coordinationRunId: aicp.context.coordination.runId,
                taskPriority: aicp.context.coordination.priority,
              },
              sensitivity: "metadata_only",
            });
          } catch {
            // Operations projection must never alter an RPC result.
          }
          return sendJson(value);
        };
      }
      next();
    });
    this.app.post("/internal/drain", async (_request, response) => {
      await this.drain();
      response.status(202).json({ success: true, ...this.snapshot() });
    });
    this.app.get("/internal/v1/describe", (_request, response) => {
      response.json({
        success: true,
        module: {
          id: this.manifest.id,
          name: this.manifest.name,
          version: this.manifest.version,
          domain: this.manifest.domain,
          responsibilities: this.manifest.responsibilities,
          nonResponsibilities: this.manifest.nonResponsibilities,
          manifestFingerprint: this.manifest.fingerprint,
        },
        runtime: this.snapshot(),
      });
    });
    this.app.get("/internal/v1/self-test", (_request, response) => {
      const snapshot = this.snapshot();
      const checks = [
        {
          id: "lifecycle-contract",
          status: this.manifest.lifecycle ? "passed" : "failed",
        },
        {
          id: "manifest-fingerprint",
          status: /^[a-f0-9]{64}$/.test(this.manifest.fingerprint)
            ? "passed"
            : "failed",
        },
        {
          id: "component-readiness",
          status: snapshot.ready ? "passed" : "failed",
        },
      ];
      const passed = checks.every((check) => check.status === "passed");
      response.status(passed ? 200 : 503).json({
        success: passed,
        moduleId: this.manifest.id,
        status: passed ? "passed" : "failed",
        checks,
      });
    });
    this.app.get("/internal/v1/lifecycle", (_request, response) => {
      response.json({ success: true, ...this.snapshot() });
    });
    this.app.post("/internal/v1/quiesce", async (request, response) => {
      const result = await this.quiesce({
        timeoutMs: request.body?.timeoutMs,
        reasonCode: request.body?.reasonCode,
      });
      response.status(202).json({ success: true, ...result });
    });
    this.app.post("/internal/v1/resume", async (request, response) => {
      const result = await this.resume({
        reasonCode: request.body?.reasonCode,
      });
      response.status(202).json({ success: true, ...result });
    });
    this.app.use((request, response, next) => {
      if (this.status !== "running")
        return response.status(503).json({
          success: false,
          error: "module_not_accepting_work",
          status: this.status,
        });
      this.inflight += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.inflight = Math.max(0, this.inflight - 1);
      };
      response.once("finish", release);
      response.once("close", release);
      next();
    });
    this.registerRoutes(this.app, this);
    this.contractClosure = this.auditContractClosure();
    if (!this.contractClosure.valid) {
      console.error(
        `[MicroModuleServiceHost] AICP contract closure invalid for ${this.manifest.id}`,
        this.contractClosure
      );
    }
    this.app.use((error, _request, response, _next) => {
      this.lastError = safeError(error);
      response.status(Number(error?.httpStatus) || 500).json({
        success: false,
        error: this.lastError,
      });
    });
  }

  auditContractClosure() {
    const findings = [];
    const provided = new Set(
      (this.manifest.contracts?.provides || []).map((contract) => contract.id)
    );
    const registered = [];
    for (const layer of this.app._router?.stack || []) {
      if (!layer.route?.path) continue;
      const routePath = String(layer.route.path);
      if (!routePath.startsWith("/internal/")) continue;
      for (const method of Object.keys(layer.route.methods || {}))
        if (layer.route.methods[method])
          registered.push(`${method.toUpperCase()} ${routePath}`);
    }
    for (const identity of registered) {
      const separator = identity.indexOf(" ");
      const method = identity.slice(0, separator);
      const routePath = identity.slice(separator + 1);
      const capability = internalRouteCapability(
        this.internalRouteCapabilities,
        method,
        routePath
      );
      if (!capability) findings.push(`route_unbound:${identity}`);
      else if (!provided.has(capability))
        findings.push(
          `route_capability_not_provided:${identity}:${capability}`
        );
    }
    const registeredSet = new Set(registered);
    for (const binding of this.manifest.routes?.bindings || []) {
      const identity = `${String(binding.method).toUpperCase()} ${binding.path}`;
      if (!registeredSet.has(identity))
        findings.push(`manifest_route_not_registered:${identity}`);
    }
    for (const contract of this.manifest.contracts?.consumes || []) {
      if (!contract.requiredForReadiness) continue;
      try {
        new AicpContractRegistry().negotiate({
          callerModule: this.manifest.id,
          targetModule: contract.targetModule,
          capability: contract.id,
          version: contract.version,
          callType: contract.callType,
          protocolVersion: "1.1",
        });
      } catch (error) {
        findings.push(
          `dependency_contract_incompatible:${contract.id}:${
            error.code || error.message
          }`
        );
      }
    }
    return {
      valid: findings.length === 0,
      findings,
      registeredRoutes: registered.length,
      manifestRouteBindings: (this.manifest.routes?.bindings || []).length,
      boundRoutes:
        registered.length -
        findings.filter((value) => value.startsWith("route_")).length,
      checkedAt: new Date().toISOString(),
    };
  }

  createServer() {
    const required = distributedTopology(this.env);
    const identity = loadServiceIdentity(this.role, {
      env: this.env,
      required,
    });
    if (!identity) return http.createServer(this.app);
    return https.createServer(
      {
        key: identity.key,
        cert: identity.cert,
        ca: identity.ca,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      this.app
    );
  }

  async start() {
    if (this.server) return this.snapshot();
    this.status = "starting";
    this.lifecycle.transition("initializing", { reasonCode: "host_start" });
    try {
      await this.onStart();
      this.server = this.createServer();
      if (this.enableWebSockets)
        require("@mintplex-labs/express-ws").default(this.app, this.server);
      this.configureApp();
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          this.server?.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server?.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(this.port);
      });
      this.status = "running";
      this.startedAt = new Date().toISOString();
      this.port = Number(this.server.address()?.port || this.port);
      const component = this.readiness?.() || {};
      const componentReady =
        component.ready === undefined ? true : Boolean(component.ready);
      this.lifecycle.transition(componentReady ? "ready" : "degraded", {
        reasonCode: componentReady ? "host_ready" : "component_not_ready",
      });
      this.startHeartbeat();
      return this.snapshot();
    } catch (error) {
      this.status = "failed";
      this.lastError = safeError(error);
      if (this.lifecycle.state !== "failed")
        this.lifecycle.transition("failed", {
          reasonCode: this.lastError,
        });
      throw error;
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer) return;
    const beat = () => {
      const component = this.readiness?.() || {};
      const heartbeat = this.lifecycle.heartbeat(component);
      this.emitLifecycleEvent("module.lifecycle.heartbeat", heartbeat);
      try {
        this.onHeartbeat({ ...heartbeat, component });
      } catch {
        // Heartbeat observers are best effort and cannot affect readiness.
      }
    };
    beat();
    this.heartbeatTimer = setInterval(beat, this.lifecycle.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async waitForInflight(timeoutMs = 30_000) {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 0);
    while (this.inflight > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    return this.inflight === 0;
  }

  async runDrain() {
    if (this.drainStarted) return;
    this.drainStarted = true;
    await this.onDrain();
  }

  async drain({ reasonCode = "drain_requested" } = {}) {
    if (!["running", "draining"].includes(this.status)) return this.snapshot();
    if (["ready", "degraded"].includes(this.lifecycle.state))
      this.lifecycle.transition("draining", { reasonCode });
    this.status = "draining";
    await this.runDrain();
    return this.snapshot();
  }

  async quiesce({ timeoutMs = 30_000, reasonCode = "quiesce_requested" } = {}) {
    if (this.lifecycle.state === "quiesced") return this.snapshot();
    await this.drain({ reasonCode });
    const checkpoint = await this.onCheckpoint();
    const drained = await this.waitForInflight(timeoutMs);
    if (!drained) {
      const error = new Error("module_quiesce_inflight_timeout");
      error.code = "MODULE_QUIESCE_INFLIGHT_TIMEOUT";
      error.httpStatus = 409;
      throw error;
    }
    this.status = "quiesced";
    this.lifecycle.transition("quiesced", {
      reasonCode,
      metadata: {
        checkpointed: checkpoint !== false,
      },
    });
    return this.snapshot();
  }

  async resume({ reasonCode = "resume_requested" } = {}) {
    if (this.lifecycle.state === "ready") return this.snapshot();
    if (!["quiesced", "degraded"].includes(this.lifecycle.state)) {
      const error = new Error("module_resume_state_invalid");
      error.code = "MODULE_RESUME_STATE_INVALID";
      error.httpStatus = 409;
      throw error;
    }
    this.lifecycle.transition("initializing", { reasonCode });
    try {
      await this.onResume();
      this.drainStarted = false;
      this.stopping = false;
      this.status = "running";
      this.lifecycle.transition("ready", { reasonCode: "resume_ready" });
      return this.snapshot();
    } catch (error) {
      this.status = "failed";
      this.lastError = safeError(error);
      this.lifecycle.transition("failed", { reasonCode: this.lastError });
      throw error;
    }
  }

  async stop({ timeoutMs = 30_000 } = {}) {
    if (this.stopping || this.status === "stopped") return this.snapshot();
    this.stopping = true;
    if (["running", "draining"].includes(this.status))
      await this.drain({ reasonCode: "host_stop" });
    this.status = "draining";
    await this.runDrain().catch((error) => {
      this.lastError = safeError(error);
    });
    const drained = await this.waitForInflight(timeoutMs);
    if (this.server)
      await new Promise((resolve) => {
        this.server.close(() => resolve());
        if (!drained) this.server.closeAllConnections?.();
      });
    await this.onStop();
    this.stopHeartbeat();
    this.server = null;
    this.status = "stopped";
    if (this.lifecycle.state === "draining")
      this.lifecycle.transition("stopped", { reasonCode: "host_stopped" });
    else if (this.lifecycle.state === "quiesced")
      this.lifecycle.transition("stopped", { reasonCode: "host_stopped" });
    return this.snapshot();
  }
}

module.exports = {
  MicroModuleServiceHost,
  distributedTopology,
  internalPeerAuthorized,
  internalRouteCapability,
  peerServiceIds,
  ModuleLifecycle,
  validateAicpPeerRequest,
};
