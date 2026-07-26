const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const root = path.resolve(__dirname, "../../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

describe("post-quantum production configuration", () => {
  test("builds production backend roles on Node 24 while retaining the frontend-only Node 18 build", () => {
    const dockerfile = read("docker/Dockerfile");
    expect(dockerfile.match(/node_24\.x/g)).toHaveLength(2);
    expect(dockerfile).not.toMatch(/nodesource\.com\/node_18\.x/);
    expect(dockerfile).toContain(
      "FROM --platform=$BUILDPLATFORM node:18-slim AS frontend-build"
    );
  });

  test("runs the PQ runtime preflight before every server runtime role", () => {
    const entrypoint = read("docker/docker-entrypoint.sh");
    for (const role of [
      "run_server",
      "run_reader_worker",
      "run_background_worker",
      "run_realtime_gateway",
    ]) {
      expect(entrypoint).toMatch(
        new RegExp(`${role}\\(\\) \\{[\\s\\S]*?verify_crypto_runtime`)
      );
    }
    expect(entrypoint).toContain("--require-node24-pq");
  });

  test("keeps enterprise PQ key and evidence mounts read-only", () => {
    const overlay = YAML.parse(read("docker/docker-compose.enterprise-pq.yml"));
    const api = overlay.services["anything-llm-api"];
    const worker = overlay.services["anything-llm-background-worker"];
    for (const service of [api, worker]) {
      expect(service.environment.ATHENA_REQUIRE_NODE24_PQ_PROBE).toBe("true");
      expect(service.environment.ATHENA_PQ_RUNTIME_EXPECTED_CAPABILITIES).toBe(
        "ml_kem_768,ml_dsa_65,encapsulation_api,classical_provider_baseline"
      );
      expect(service.volumes.every((volume) => volume.endsWith(":ro"))).toBe(
        true
      );
    }
    expect(api.environment.ATHENA_ENTERPRISE_RELEASE_GATE).toBe("true");
    expect(api.environment.ATHENA_AUDIT_HYBRID_SIGNATURES).toBe("required");
    expect(api.environment.ATHENA_IOS_HIGH_RISK_PQ_REQUIRED).toBe("true");
    expect(api.environment.ATHENA_DEVICE_ATTESTATION_MODE).toBe("required");
  });

  test("requires real Node 24 PQ interoperability in compatibility and release workflows", () => {
    const compatibility = read(
      ".github/workflows/crypto-runtime-compatibility.yaml"
    );
    const releaseGate = read(
      ".github/workflows/enterprise-security-release-gate.yaml"
    );
    expect(compatibility).toContain("--require-node24-pq");
    expect(compatibility).toContain("verify-pq-hybrid-interoperability.js");
    expect(compatibility).toContain(
      "Reject a PQ production requirement on legacy Node"
    );
    expect(releaseGate).toContain("crypto-runtime:verify --require-node24-pq");
    expect(releaseGate).toContain("crypto-hybrid:verify");
  });
});
