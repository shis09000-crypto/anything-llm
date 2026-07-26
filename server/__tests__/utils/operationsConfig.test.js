/* eslint-env jest */

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  operationsConfig,
  operationsSecurityFindings,
} = require("../../utils/operations/config");

describe("Operations Plane production configuration", () => {
  let temporaryDirectory;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "athena-operations-config-")
    );
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function secretFile(mode = 0o600) {
    const target = path.join(temporaryDirectory, "clickhouse-password");
    fs.writeFileSync(target, "not-a-production-secret", { mode });
    fs.chmodSync(target, mode);
    return target;
  }

  test("accepts a TLS JetStream endpoint and private ClickHouse secret", () => {
    const env = {
      NODE_ENV: "production",
      ATHENA_OPERATIONS_ENABLED: "true",
      ATHENA_NATS_SERVERS: "tls://nats.internal:4222",
      ATHENA_CLICKHOUSE_URL: "http://clickhouse:8123",
      ATHENA_CLICKHOUSE_PASSWORD_FILE: secretFile(),
    };

    expect(operationsSecurityFindings(env)).toEqual([]);
    expect(operationsConfig(env)).toMatchObject({
      enabled: true,
      natsServers: ["tls://nats.internal:4222"],
      maxBytes: 4 * 1024 * 1024 * 1024,
      clickhouse: {
        configured: true,
        password: "not-a-production-secret",
      },
    });
  });

  test("rejects plaintext NATS and group-readable ClickHouse material", () => {
    const findings = operationsSecurityFindings({
      NODE_ENV: "production",
      ATHENA_OPERATIONS_ENABLED: "true",
      ATHENA_NATS_SERVERS: "nats://nats.internal:4222",
      ATHENA_CLICKHOUSE_URL: "http://clickhouse:8123",
      ATHENA_CLICKHOUSE_PASSWORD_FILE: secretFile(0o640),
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        "Production Operations JetStream requires tls:// endpoints.",
        "Production ClickHouse credential file must be a private regular file.",
      ])
    );
  });

  test("never reads a plaintext ClickHouse password in production", () => {
    const config = operationsConfig({
      NODE_ENV: "production",
      ATHENA_OPERATIONS_ENABLED: "true",
      ATHENA_CLICKHOUSE_URL: "http://clickhouse:8123",
      ATHENA_CLICKHOUSE_PASSWORD: "must-be-ignored",
    });

    expect(config.clickhouse.password).toBe("");
  });
});
