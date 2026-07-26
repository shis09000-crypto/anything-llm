const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  emptyRolloutState,
  planPromotion,
  planRollback,
  readRolloutState,
  writeRolloutState,
} = require("../../utils/security/hybridTlsRollout");

function passingEvidence(overrides = {}) {
  return {
    version: 1,
    providerSupport: { cdn: true, loadBalancer: true, envoy: true },
    negotiatedGroup: "X25519MLKEM768",
    sampleCount: 1_000,
    handshakeSuccessRate: 0.999,
    hybridNegotiationRate: 0.999,
    certificateValidationRate: 1,
    middleboxBlockRate: 0.001,
    classicalFallbackRate: 0,
    cpuUtilization: 0.42,
    ttfbRegressionRate: 0.03,
    ...overrides,
  };
}

describe("hybrid TLS rollout policy", () => {
  test("only promotes through 1, 5, 25 and 100 percent", () => {
    const first = planPromotion({
      state: emptyRolloutState(),
      targetPercent: 1,
      evidence: passingEvidence(),
    });
    expect(first.cohortPercent).toBe(1);
    expect(() =>
      planPromotion({
        state: first,
        targetPercent: 25,
        evidence: passingEvidence(),
      })
    ).toThrow("edge_tls_rollout_stage_skip_forbidden");
  });

  test("fails closed when the provider or compatibility gates are missing", () => {
    expect(() =>
      planPromotion({
        state: emptyRolloutState(),
        targetPercent: 1,
        evidence: passingEvidence({
          providerSupport: {
            cdn: true,
            loadBalancer: false,
            envoy: true,
          },
          middleboxBlockRate: 0.02,
        }),
      })
    ).toThrow("edge_tls_rollout_gate_failed");
  });

  test("supports immediate rollback without changing application policy", () => {
    const promoted = planPromotion({
      state: emptyRolloutState(),
      targetPercent: 1,
      evidence: passingEvidence(),
    });
    const rolledBack = planRollback({
      state: promoted,
      targetPercent: 0,
      reason: "middlebox_regression",
    });
    expect(rolledBack).toMatchObject({
      cohortPercent: 0,
      previousCohortPercent: 1,
      status: "disabled",
      policy: "edge-enforced",
    });
  });

  test("writes state atomically and reads it back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "edge-rollout-"));
    const file = path.join(root, "state.json");
    const planned = planPromotion({
      state: emptyRolloutState(),
      targetPercent: 1,
      evidence: passingEvidence(),
    });
    writeRolloutState(file, planned);
    expect(readRolloutState(file)).toEqual(planned);
    expect(fs.readdirSync(root)).toEqual(["state.json"]);
  });
});
