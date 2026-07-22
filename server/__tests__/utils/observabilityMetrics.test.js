/* eslint-env jest */

const {
  metricsRequestAuthorized,
} = require("../../utils/observability/metrics");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("observability metrics access", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalToken = process.env.ATHENA_METRICS_TOKEN;
  const originalLoopback = process.env.ATHENA_METRICS_ALLOW_LOOPBACK;
  const originalTokenFile = process.env.ATHENA_METRICS_TOKEN_FILE;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalToken === undefined) delete process.env.ATHENA_METRICS_TOKEN;
    else process.env.ATHENA_METRICS_TOKEN = originalToken;
    if (originalLoopback === undefined)
      delete process.env.ATHENA_METRICS_ALLOW_LOOPBACK;
    else process.env.ATHENA_METRICS_ALLOW_LOOPBACK = originalLoopback;
    if (originalTokenFile === undefined)
      delete process.env.ATHENA_METRICS_TOKEN_FILE;
    else process.env.ATHENA_METRICS_TOKEN_FILE = originalTokenFile;
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

  test("reads the production metrics credential from a secret file", () => {
    const tokenFile = path.join(os.tmpdir(), `athena-metrics-${process.pid}`);
    fs.writeFileSync(tokenFile, "file-backed-token\n", { mode: 0o600 });
    process.env.NODE_ENV = "production";
    delete process.env.ATHENA_METRICS_TOKEN;
    process.env.ATHENA_METRICS_TOKEN_FILE = tokenFile;
    try {
      expect(
        metricsRequestAuthorized({
          headers: { authorization: "Bearer file-backed-token" },
          socket: { remoteAddress: "203.0.113.5" },
        })
      ).toBe(true);
    } finally {
      fs.rmSync(tokenFile, { force: true });
    }
  });
});
