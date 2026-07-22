const fs = require("fs");
const path = require("path");

describe("AI Operations NATS provisioning", () => {
  test("allows the operations client to acknowledge JetStream deliveries", () => {
    const script = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docker/scripts/provision-ai-operations-secrets.sh"
      ),
      "utf8"
    );

    expect(script).toContain('"\\$JS.ACK.>"');
  });

  test("creates a private Prometheus-owned metrics credential", () => {
    const script = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docker/scripts/provision-ai-operations-secrets.sh"
      ),
      "utf8"
    );
    const compose = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docker/docker-compose.ai-operations.production.yml"
      ),
      "utf8"
    );

    expect(script).toContain('chown 65534:65534 "${secret_dir}/metrics-token.prometheus"');
    expect(script).toContain("ATHENA_METRICS_PROMETHEUS_TOKEN_FILE=");
    expect(compose).toContain("athena_metrics_token_prometheus:");
    expect(compose).toContain("source: athena_metrics_token_prometheus");
  });
});
