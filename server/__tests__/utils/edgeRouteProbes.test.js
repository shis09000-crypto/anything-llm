/* global describe, test, expect */

const {
  edgeRouteTargets,
  probeEdgeRoutes,
} = require("../../utils/microModules/edgeRouteProbes");

describe("Edge public route readiness", () => {
  test("covers static, API compatibility and Identity public routes", () => {
    expect(
      edgeRouteTargets({
        origin: "http://anything-llm-web:3000",
        healthUrl: "http://anything-llm-web:3000/health",
      }).map((target) => target.id)
    ).toEqual([
      "edge-static",
      "api-compatibility-route",
      "identity-public-route",
    ]);
  });

  test("fails readiness when Identity routing is unavailable", async () => {
    const request = async (url) => {
      if (url.endsWith("/health")) return { statusCode: 200, body: "{}" };
      if (url.endsWith("/api/ready"))
        return { statusCode: 200, body: '{"ready":true}' };
      return {
        statusCode: 503,
        body: '{"reasonCode":"module_upstream_unavailable"}',
      };
    };
    const result = await probeEdgeRoutes({
      origin: "http://anything-llm-web:3000",
      healthUrl: "http://anything-llm-web:3000/health",
      request,
    });
    expect(result.ready).toBe(false);
    expect(result.probes["identity-public-route"]).toMatchObject({
      ready: false,
      statusCode: 503,
      reasonCode: "edge_route_http_503",
    });
  });

  test("passes only when all public routes satisfy their contracts", async () => {
    const request = async (url) => {
      if (url.endsWith("/api/ready"))
        return { statusCode: 200, body: '{"ready":true}' };
      if (url.includes("auth/bootstrap"))
        return {
          statusCode: 200,
          body: '{"schemaVersion":"athena.auth.bootstrap.v1","serviceStatus":"ready"}',
        };
      return { statusCode: 200, body: "{}" };
    };
    const result = await probeEdgeRoutes({
      origin: "http://anything-llm-web:3000",
      healthUrl: "http://anything-llm-web:3000/health",
      request,
    });
    expect(result.ready).toBe(true);
  });
});
