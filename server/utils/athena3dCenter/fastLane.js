const express = require("express");
const http = require("http");

const FAST_LANE_PROTOCOL = "athena.3d-fast-lane.v1";

function fastLaneError(code, status = 500) {
  const error = new Error(code);
  error.code = code;
  error.httpStatus = status;
  return error;
}

function startFastLaneServer({
  role,
  port,
  host = "127.0.0.1",
  handler,
  jsonLimit = "16mb",
} = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) <= 0)
    throw fastLaneError("athena_3d_fast_lane_port_invalid", 500);
  if (typeof handler !== "function")
    throw fastLaneError("athena_3d_fast_lane_handler_required", 500);
  const normalizedHost = String(host || "").trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(normalizedHost))
    throw fastLaneError("athena_3d_fast_lane_private_bind_required", 500);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: jsonLimit }));
  app.get("/ready", (_request, response) =>
    response.json({
      ready: true,
      protocol: FAST_LANE_PROTOCOL,
      role,
      security_envelope: "none",
    })
  );
  app.post("/v1/dispatch", async (request, response) => {
    try {
      if (request.body?.protocol !== FAST_LANE_PROTOCOL)
        throw fastLaneError("athena_3d_fast_lane_protocol_invalid", 400);
      const operation = String(request.body?.operation || "").trim();
      if (!operation)
        throw fastLaneError("athena_3d_fast_lane_operation_required", 400);
      const result = await handler(operation, request.body?.payload || {});
      response.json({
        ok: true,
        protocol: FAST_LANE_PROTOCOL,
        operation,
        result,
      });
    } catch (error) {
      response.status(Number(error?.httpStatus || 500)).json({
        ok: false,
        protocol: FAST_LANE_PROTOCOL,
        error: error?.code || error?.message || "athena_3d_fast_lane_failed",
      });
    }
  });

  const server = http.createServer(app);
  let closed = false;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, () => {
      server.off("error", reject);
      resolve({
        role,
        host,
        port: Number(port),
        protocol: FAST_LANE_PROTOCOL,
        close: () => {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function requestFastLane({ url, operation, payload, timeoutMs = 10_000 } = {}) {
  const target = new URL(String(url || ""));
  if (target.protocol !== "http:")
    return Promise.reject(
      fastLaneError("athena_3d_fast_lane_plain_http_required", 500)
    );
  const hostname = target.hostname.toLowerCase();
  const privateTarget =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".internal") ||
    hostname.startsWith("anything-llm-");
  if (!privateTarget)
    return Promise.reject(
      fastLaneError("athena_3d_fast_lane_private_target_required", 500)
    );
  const body = Buffer.from(
    JSON.stringify({ protocol: FAST_LANE_PROTOCOL, operation, payload })
  );
  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": body.length,
        },
        timeout: Math.max(250, Number(timeoutMs) || 0),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let decoded = null;
          try {
            decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return reject(
              fastLaneError("athena_3d_fast_lane_response_invalid", 502)
            );
          }
          if (response.statusCode < 200 || response.statusCode >= 300 || !decoded?.ok)
            return reject(
              fastLaneError(
                decoded?.error || "athena_3d_fast_lane_request_failed",
                response.statusCode || 502
              )
            );
          resolve(decoded.result);
        });
      }
    );
    request.on("timeout", () =>
      request.destroy(fastLaneError("athena_3d_fast_lane_timeout", 504))
    );
    request.on("error", reject);
    request.end(body);
  });
}

module.exports = {
  FAST_LANE_PROTOCOL,
  requestFastLane,
  startFastLaneServer,
};
