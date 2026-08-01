const http = require("http");
const https = require("https");

const MAX_RESPONSE_BYTES = 64 * 1024;

function safeJson(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}

function requestProbe(url, { timeoutMs = 2_500 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const request = transport.get(
      target,
      { timeout: timeoutMs },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            statusCode: Number(response.statusCode || 0),
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.once("timeout", () =>
      request.destroy(new Error("edge_route_probe_timeout"))
    );
    request.once("error", (error) =>
      resolve({
        statusCode: 0,
        body: "",
        error: String(error.code || error.message || "edge_route_probe_failed"),
      })
    );
  });
}

function edgeRouteTargets({ origin, healthUrl }) {
  return [
    {
      id: "edge-static",
      url: healthUrl,
      validate: ({ statusCode }) => statusCode >= 200 && statusCode < 400,
    },
    {
      id: "api-compatibility-route",
      url: new URL("/api/ready", origin).toString(),
      validate: ({ statusCode, body }) =>
        statusCode === 200 && safeJson(body)?.ready === true,
    },
    {
      id: "identity-public-route",
      url: new URL("/api/auth/registration/config", origin).toString(),
      validate: ({ statusCode, body }) => {
        const payload = safeJson(body);
        return (
          statusCode === 200 &&
          payload?.success === true &&
          typeof payload?.allowPublicRegistration === "boolean"
        );
      },
    },
  ];
}

async function probeEdgeRoutes({ origin, healthUrl, request = requestProbe }) {
  const targets = edgeRouteTargets({ origin, healthUrl });
  const results = await Promise.all(
    targets.map(async (target) => {
      const result = await request(target.url);
      const ready = !result.error && target.validate(result);
      return {
        id: target.id,
        ready,
        statusCode: result.statusCode,
        reasonCode: ready
          ? null
          : result.error || `edge_route_http_${result.statusCode || 0}`,
      };
    })
  );
  return {
    ready: results.every((result) => result.ready),
    probes: Object.fromEntries(results.map((result) => [result.id, result])),
  };
}

module.exports = {
  edgeRouteTargets,
  probeEdgeRoutes,
  requestProbe,
  safeJson,
};
