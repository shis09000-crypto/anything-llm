const path = require("path");
const {
  MIN_DISK_BYTES,
  MIN_MEMORY_BYTES,
  evaluatePreproductionHost,
} = require("../../scripts/verify-micro-module-preproduction-host");

function validInput() {
  return {
    env: {
      APP_ENV: "preproduction",
      ATHENA_PREPROD_CONFIRM: "athena-preproduction",
      ATHENA_PREPROD_PUBLIC_URL: "https://preproduction.athena.example",
    },
    repoRoot: "/srv/anything-llm",
    stateDir: "/data/athena-preproduction",
    snapshot: {
      docker: {
        available: true,
        engineReady: true,
        composeV2: true,
        buildx: true,
        architecture: "x86_64",
        cpuCount: 8,
        memoryBytes: MIN_MEMORY_BYTES,
        runningContainers: [],
      },
      diskFreeBytes: MIN_DISK_BYTES,
    },
  };
}

describe("micro-module preproduction host admission", () => {
  it("accepts a dedicated amd64 host with the minimum capacity", () => {
    expect(evaluatePreproductionHost(validInput())).toMatchObject({
      ready: true,
      findings: [],
      publicOrigin: "https://preproduction.athena.example",
    });
  });

  it("rejects production co-location and unsafe state paths", () => {
    const input = validInput();
    input.stateDir = "/data/anythingllm/preproduction";
    input.snapshot.docker.runningContainers.push({
      name: "anythingllm-v2",
      composeProject: "anythingllm-v2",
    });
    expect(evaluatePreproductionHost(input)).toMatchObject({
      ready: false,
      findings: expect.arrayContaining([
        "preproduction_state_directory_unsafe",
        "production_runtime_detected_on_preproduction_host",
      ]),
    });
  });

  it("fails closed on placeholder URLs and insufficient runtime capacity", () => {
    const input = validInput();
    input.env.ATHENA_PREPROD_PUBLIC_URL =
      "https://preproduction.athena.invalid";
    input.snapshot.docker.cpuCount = 2;
    input.snapshot.docker.memoryBytes = 4 * 1024 ** 3;
    input.snapshot.diskFreeBytes = 8 * 1024 ** 3;
    expect(evaluatePreproductionHost(input)).toMatchObject({
      ready: false,
      findings: expect.arrayContaining([
        "dedicated_https_public_url_required",
        "preproduction_cpu_capacity_insufficient",
        "preproduction_memory_capacity_insufficient",
        "preproduction_disk_capacity_insufficient",
      ]),
    });
  });

  it("rejects non-standard ports and URL paths that Caddy cannot bind exactly", () => {
    for (const value of [
      "https://preproduction.athena.example:8443",
      "https://preproduction.athena.example/athena",
    ]) {
      const input = validInput();
      input.env.ATHENA_PREPROD_PUBLIC_URL = value;
      expect(evaluatePreproductionHost(input).findings).toContain(
        "dedicated_https_public_url_required"
      );
    }
  });

  it("does not permit the repository itself as the state directory", () => {
    const input = validInput();
    input.stateDir = path.join(input.repoRoot, "server", "storage");
    expect(evaluatePreproductionHost(input).findings).toContain(
      "preproduction_state_directory_unsafe"
    );
  });
});
