const http = require("http");
const https = require("https");
const { loadServiceIdentity } = require("../security/serviceIdentity");
const { distributedTopology } = require("./serviceHost");

function requestInternalService({
  callerRole,
  url,
  method = "POST",
  body = null,
  idempotencyKey = null,
  env = process.env,
  timeoutMs = 10_000,
} = {}) {
  const target = new URL(url);
  const secure = target.protocol === "https:";
  if (distributedTopology(env) && !secure)
    return Promise.reject(
      Object.assign(new Error("internal_service_tls_required"), {
        code: "INTERNAL_SERVICE_TLS_REQUIRED",
      })
    );
  const identity = secure
    ? loadServiceIdentity(callerRole, {
        env,
        required: distributedTopology(env),
      })
    : null;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
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
          )
            return resolve(parsed);
          const error = new Error(
            parsed?.error || `internal_service_http_${response.statusCode}`
          );
          error.code = String(parsed?.error || "INTERNAL_SERVICE_FAILED");
          error.httpStatus = response.statusCode;
          error.reasonCode = parsed?.reasonCode || null;
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
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function requestInternalStream({
  callerRole,
  url,
  method = "POST",
  body = null,
  idempotencyKey = null,
  env = process.env,
  timeoutMs = 120_000,
} = {}) {
  const target = new URL(url);
  const secure = target.protocol === "https:";
  if (distributedTopology(env) && !secure)
    return Promise.reject(
      Object.assign(new Error("internal_service_tls_required"), {
        code: "INTERNAL_SERVICE_TLS_REQUIRED",
      })
    );
  const identity = secure
    ? loadServiceIdentity(callerRole, {
        env,
        required: distributedTopology(env),
      })
    : null;
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
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
        if (response.statusCode >= 200 && response.statusCode < 300)
          return resolve(response);
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
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

module.exports = {
  requestInternalService,
  requestInternalStream,
};
