const { spawnSync } = require("child_process");
const path = require("path");
const {
  expectedCapabilities,
  requiredPostQuantumFindings,
} = require("../../utils/security/cryptoRuntimeCapabilities");

describe("post-quantum runtime requirements", () => {
  test("rejects a required PQ gate on every runtime except Node 24", () => {
    expect(
      requiredPostQuantumFindings({
        required: true,
        runtimeMajor: 22,
        capabilities: {},
      })
    ).toEqual(["node24_required:22"]);
    expect(
      requiredPostQuantumFindings({
        required: true,
        runtimeMajor: 25,
        capabilities: {},
      })
    ).toEqual(["node24_required:25"]);
  });

  test("reports every missing Node 24 capability", () => {
    expect(
      requiredPostQuantumFindings({
        required: true,
        runtimeMajor: 24,
        capabilities: {
          ml_kem_768: true,
          ml_dsa_65: false,
          encapsulation_api: false,
          classical_provider_baseline: true,
        },
      })
    ).toEqual(["node24_post_quantum_probe_failed:ml_dsa_65,encapsulation_api"]);
  });

  test("accepts only a complete Node 24 provider baseline", () => {
    expect(
      requiredPostQuantumFindings({
        required: true,
        runtimeMajor: 24,
        capabilities: {
          ml_kem_768: true,
          ml_dsa_65: true,
          encapsulation_api: true,
          classical_provider_baseline: true,
        },
      })
    ).toEqual([]);
  });

  test("keeps the declared PQ capability baseline on legacy runtimes", () => {
    expect(
      expectedCapabilities(
        {
          ml_kem_768: false,
          ml_dsa_65: false,
          encapsulation_api: false,
          classical_provider_baseline: true,
        },
        { ATHENA_REQUIRE_NODE24_PQ_PROBE: "true" }
      )
    ).toEqual({
      ml_kem_768: true,
      ml_dsa_65: true,
      encapsulation_api: true,
      classical_provider_baseline: true,
    });
  });

  test("the CLI fails closed when Node 24 PQ is required on this legacy runtime", () => {
    const runtimeMajor = Number(process.versions.node.split(".")[0]);
    if (runtimeMajor === 24) return;
    const script = path.join(
      __dirname,
      "../../scripts/verify-crypto-runtime-capabilities.js"
    );
    const result = spawnSync(
      process.execPath,
      [script, "--require-node24-pq"],
      {
        encoding: "utf8",
      }
    );
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      postQuantumRequired: true,
      findings: [`node24_required:${runtimeMajor}`],
    });
  });
});
