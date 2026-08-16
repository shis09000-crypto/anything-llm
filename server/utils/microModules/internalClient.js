const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { loadServiceIdentity } = require("../security/serviceIdentity");
const { distributedTopology } = require("./serviceHost");
const {
  currentOperationContext,
} = require("../observability/operationContext");
const { aicpShadowObserver } = require("../modulePlatform/aicp/shadowObserver");
const { emitSemanticEvent } = require("../observability/semanticEvents");
const {
  AicpContractRegistry,
  aicpEnforcementMode,
  aicpLinkEnforcementMode,
  encodeAicpHeader,
  validateCoordinationContext,
} = require("../modulePlatform/aicp/contractRegistry");

function inheritedCoordinationContext(explicitContext = null) {
  if (explicitContext) return explicitContext;
  const context = currentOperationContext() || {};
  if (
    !context.coordinationRunId ||
    !context.stepId ||
    !context.correlationId ||
    !context.coordinationCenter ||
    !context.taskPriority ||
    !context.coordinationDeadlineAt
  )
    return null;
  return {
    coordinationRunId: context.coordinationRunId,
    stepId: context.stepId,
    correlationId: context.correlationId,
    center: context.coordinationCenter,
    priority: context.taskPriority,
    deadlineAt: context.coordinationDeadlineAt,
    causationId: context.coordinationCausationId || context.operationId || null,
  };
}

function aicpRequestHeaders({
  callerRole,
  targetModule,
  capability,
  contractVersion = null,
  coordinationContext = null,
  principalAssertion = null,
  approvalId = null,
  env = process.env,
} = {}) {
  const hasExplicitCoordinationContext = Boolean(coordinationContext);
  coordinationContext = inheritedCoordinationContext(coordinationContext);
  const mode =
    capability && targetModule
      ? aicpLinkEnforcementMode({
          callerModule: callerRole,
          targetModule,
          capability,
          env,
        })
      : aicpEnforcementMode(env);
  if (!capability || !targetModule) {
    if (mode === "enforce") {
      const error = new Error("aicp_contract_context_required");
      error.code = "AICP_CONTRACT_CONTEXT_REQUIRED";
      error.httpStatus = 409;
      throw error;
    }
    return {};
  }
  const registry = new AicpContractRegistry();
  const negotiation = registry.negotiate({
    callerModule: callerRole,
    targetModule,
    capability,
    version: contractVersion,
  });
  if (coordinationContext) {
    const validation = validateCoordinationContext(coordinationContext, {
      required: true,
    });
    if (!validation.valid) {
      if (hasExplicitCoordinationContext) {
        const error = new Error("aicp_coordination_context_invalid");
        error.code = "AICP_COORDINATION_CONTEXT_INVALID";
        error.findings = validation.findings;
        throw error;
      }
      // A normal request may outlive the optional coordination deadline while
      // it waits on other services. Do not fail an unrelated RPC because an
      // inherited context became stale; explicit contexts remain fail-closed.
      coordinationContext = null;
    }
  }
  return {
    "x-athena-aicp-link-id": negotiation.linkId,
    "x-athena-aicp-capability": negotiation.capability,
    "x-athena-aicp-contract-version": negotiation.version,
    "x-athena-aicp-contract-fingerprint": negotiation.contractFingerprint,
    "x-athena-aicp-caller": negotiation.callerModule,
    "x-athena-aicp-target": negotiation.targetModule,
    ...(coordinationContext
      ? {
          "x-athena-aicp-coordination": encodeAicpHeader(coordinationContext),
        }
      : {}),
    ...(principalAssertion
      ? {
          "x-athena-principal-assertion": encodeAicpHeader(principalAssertion),
        }
      : {}),
    ...(approvalId
      ? { "x-athena-operations-approval": String(approvalId) }
      : {}),
  };
}

function shadowSampled(observationId, env = process.env) {
  const rate = Math.max(
    0,
    Math.min(Number(env.ATHENA_AICP_SHADOW_SAMPLE_RATE ?? 0.1), 1)
  );
  if (rate === 0) return false;
  if (rate === 1) return true;
  const bucket = Number.parseInt(
    crypto.createHash("sha256").update(observationId).digest("hex").slice(0, 8),
    16
  );
  return bucket / 0xffffffff < rate;
}

function rpcShadowObservation({ callerRole, url, method, env }) {
  const startedAt = Date.now();
  const context = currentOperationContext() || {};
  const observationId = crypto.randomUUID();
  let recorded = false;
  return ({ outcome, statusCode = null, errorCode = null }) => {
    if (recorded) return;
    recorded = true;
    try {
      const observation = aicpShadowObserver.observeRpcCall({
        observationId,
        callerRole,
        url,
        method,
        outcome,
        statusCode,
        errorCode,
        durationMs: Date.now() - startedAt,
        context,
      });
      if (
        observation.accepted &&
        (outcome !== "success" || shadowSampled(observationId, env))
      )
        emitSemanticEvent({
          eventId: observationId,
          eventType: "aicp.rpc.observed",
          category: "aicp_shadow",
          severity: outcome === "success" ? "info" : "warning",
          outcome,
          subject: {
            type: "module-link",
            id: observationId,
            component: observation.from,
            operation: observation.capability,
          },
          correlation: context,
          impact: { scope: observation.to, status: outcome },
          metadata: {
            backend: observation.transport,
            durationMs: Date.now() - startedAt,
            statusCode,
            errorCode,
            validationStatus: observation.contractConformant
              ? "declared"
              : "contract_drift",
          },
          sensitivity: "metadata_only",
        });
    } catch {
      // Shadow observation must never alter the internal call result.
    }
  };
}

function requestInternalService({
  callerRole,
  callerModule = callerRole,
  url,
  method = "POST",
  body = null,
  idempotencyKey = null,
  targetModule = null,
  capability = null,
  contractVersion = null,
  coordinationContext = null,
  principalAssertion = null,
  approvalId = null,
  env = process.env,
  timeoutMs = 10_000,
} = {}) {
  const observe = rpcShadowObservation({ callerRole, url, method, env });
  const target = new URL(url);
  const secure = target.protocol === "https:";
  if (distributedTopology(env) && !secure) {
    observe({ outcome: "failed", errorCode: "INTERNAL_SERVICE_TLS_REQUIRED" });
    return Promise.reject(
      Object.assign(new Error("internal_service_tls_required"), {
        code: "INTERNAL_SERVICE_TLS_REQUIRED",
      })
    );
  }
  const identity = secure
    ? loadServiceIdentity(callerRole, {
        env,
        required: distributedTopology(env),
      })
    : null;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  let aicpHeaders;
  try {
    aicpHeaders = aicpRequestHeaders({
      callerRole: callerModule,
      targetModule,
      capability,
      contractVersion,
      coordinationContext,
      principalAssertion,
      approvalId,
      env,
    });
  } catch (error) {
    observe({ outcome: "failed", errorCode: error.code || error.message });
    return Promise.reject(error);
  }
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method,
        cert: identity?.cert,
        key: identity?.key,
        ca: identity?.ca,
        servername: identity?.serverName || target.hostname,
        minVersion: secure ? "TLSv1.3" : undefined,
        headers: {
          accept: "application/json",
          ...aicpHeaders,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": payload.length,
              }
            : {}),
          ...(idempotencyKey
            ? { "idempotency-key": String(idempotencyKey) }
            : {}),
        },
        timeout: Math.max(1_000, Number(timeoutMs) || 0),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            parsed = { success: false, error: "internal_response_invalid" };
          }
          if (
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            parsed?.success !== false
          ) {
            observe({ outcome: "success", statusCode: response.statusCode });
            return resolve(parsed);
          }
          const error = new Error(
            parsed?.error || `internal_service_http_${response.statusCode}`
          );
          error.code = String(parsed?.error || "INTERNAL_SERVICE_FAILED");
          error.httpStatus = response.statusCode;
          error.reasonCode = parsed?.reasonCode || null;
          observe({
            outcome: "failed",
            statusCode: response.statusCode,
            errorCode: error.code,
          });
          reject(error);
        });
      }
    );
    request.once("timeout", () => {
      request.destroy(
        Object.assign(new Error("internal_service_timeout"), {
          code: "INTERNAL_SERVICE_TIMEOUT",
        })
      );
    });
    request.once("error", (error) => {
      observe({ outcome: "failed", errorCode: error?.code || error?.message });
      reject(error);
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function requestInternalStream({
  callerRole,
  callerModule = callerRole,
  url,
  method = "POST",
  body = null,
  idempotencyKey = null,
  targetModule = null,
  capability = null,
  contractVersion = null,
  coordinationContext = null,
  principalAssertion = null,
  approvalId = null,
  env = process.env,
  timeoutMs = 120_000,
} = {}) {
  const observe = rpcShadowObservation({ callerRole, url, method, env });
  const target = new URL(url);
  const secure = target.protocol === "https:";
  if (distributedTopology(env) && !secure) {
    observe({ outcome: "failed", errorCode: "INTERNAL_SERVICE_TLS_REQUIRED" });
    return Promise.reject(
      Object.assign(new Error("internal_service_tls_required"), {
        code: "INTERNAL_SERVICE_TLS_REQUIRED",
      })
    );
  }
  const identity = secure
    ? loadServiceIdentity(callerRole, {
        env,
        required: distributedTopology(env),
      })
    : null;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  let aicpHeaders;
  try {
    aicpHeaders = aicpRequestHeaders({
      callerRole: callerModule,
      targetModule,
      capability,
      contractVersion,
      coordinationContext,
      principalAssertion,
      approvalId,
      env,
    });
  } catch (error) {
    observe({ outcome: "failed", errorCode: error.code || error.message });
    return Promise.reject(error);
  }
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method,
        cert: identity?.cert,
        key: identity?.key,
        ca: identity?.ca,
        servername: identity?.serverName || target.hostname,
        minVersion: secure ? "TLSv1.3" : undefined,
        headers: {
          accept: "application/x-ndjson",
          ...aicpHeaders,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": payload.length,
              }
            : {}),
          ...(idempotencyKey
            ? { "idempotency-key": String(idempotencyKey) }
            : {}),
        },
        timeout: Math.max(1_000, Number(timeoutMs) || 0),
      },
      (response) => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          observe({ outcome: "success", statusCode: response.statusCode });
          return resolve(response);
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            parsed = {};
          }
          const error = new Error(
            parsed?.error || `internal_service_http_${response.statusCode}`
          );
          error.code = String(parsed?.error || "INTERNAL_SERVICE_FAILED");
          error.httpStatus = response.statusCode;
          observe({
            outcome: "failed",
            statusCode: response.statusCode,
            errorCode: error.code,
          });
          reject(error);
        });
      }
    );
    request.once("timeout", () => {
      request.destroy(
        Object.assign(new Error("internal_service_timeout"), {
          code: "INTERNAL_SERVICE_TIMEOUT",
        })
      );
    });
    request.once("error", (error) => {
      observe({ outcome: "failed", errorCode: error?.code || error?.message });
      reject(error);
    });
    if (payload) request.write(payload);
    request.end();
  });
}

module.exports = {
  aicpRequestHeaders,
  inheritedCoordinationContext,
  requestInternalService,
  requestInternalStream,
};
