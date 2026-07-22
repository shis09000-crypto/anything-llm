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

  test("reserves separate JetStream budgets for operations and broadcast", () => {
    const compose = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docker/docker-compose.ai-operations.production.yml"
      ),
      "utf8"
    );

    expect(compose).toContain(
      'ATHENA_OPERATIONS_NATS_MAX_BYTES: "3221225472"'
    );
    expect(compose).toContain('ATHENA_NATS_MAX_BYTES: "536870912"');
  });

  test("binds the operations consumer to its dedicated stream", () => {
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../utils/operations/jetStreamTransport.js"
      ),
      "utf8"
    );

    expect(source).toContain("options.bindStream(this.config.stream)");
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

  test("exposes Tempo OTLP receivers to the collector network", () => {
    const tempo = fs.readFileSync(
      path.resolve(__dirname, "../../../docker/observability/tempo.yaml"),
      "utf8"
    );

    expect(tempo).toContain("endpoint: 0.0.0.0:4317");
    expect(tempo).toContain("endpoint: 0.0.0.0:4318");
  });

  test("bounds Tempo search concurrency and memory", () => {
    const tempo = fs.readFileSync(
      path.resolve(__dirname, "../../../docker/observability/tempo.yaml"),
      "utf8"
    );
    const compose = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docker/docker-compose.ai-operations.production.yml"
      ),
      "utf8"
    );

    expect(tempo).toContain("max_outstanding_per_tenant: 100");
    expect(tempo).toContain("concurrent_jobs: 16");
    expect(tempo).toContain("max_concurrent_queries: 2");
    expect(compose).toContain("GOMEMLIMIT: 300MiB");
    expect(compose).toMatch(/tempo:[\s\S]*mem_limit: 384m/);
  });
});
