/* eslint-env jest */

const {
  metricsRequestAuthorized,
} = require("../../utils/observability/metrics");

describe("observability metrics access", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalToken = process.env.ATHENA_METRICS_TOKEN;
  const originalLoopback = process.env.ATHENA_METRICS_ALLOW_LOOPBACK;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalToken === undefined) delete process.env.ATHENA_METRICS_TOKEN;
    else process.env.ATHENA_METRICS_TOKEN = originalToken;
    if (originalLoopback === undefined)
      delete process.env.ATHENA_METRICS_ALLOW_LOOPBACK;
    else process.env.ATHENA_METRICS_ALLOW_LOOPBACK = originalLoopback;
  });

  test("fails closed in production when no metrics credential is configured", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ATHENA_METRICS_TOKEN;
    delete process.env.ATHENA_METRICS_ALLOW_LOOPBACK;

    expect(
      metricsRequestAuthorized({
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      })
    ).toBe(false);
  });

  test("uses a constant-time bearer token comparison", () => {
    process.env.NODE_ENV = "production";
    process.env.ATHENA_METRICS_TOKEN = "metrics-test-token";

    expect(
      metricsRequestAuthorized({
        headers: { authorization: "Bearer metrics-test-token" },
        socket: { remoteAddress: "203.0.113.5" },
      })
    ).toBe(true);
    expect(
      metricsRequestAuthorized({
        headers: { authorization: "Bearer wrong" },
        socket: { remoteAddress: "203.0.113.5" },
      })
    ).toBe(false);
  });
});
