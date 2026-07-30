/* eslint-env jest */

const {
  evaluateGovernanceState,
} = require("../../../utils/cryptoForecasting/governance");

describe("crypto forecast governance", () => {
  it("requires offline, shadow, paper and explicit activation in order", () => {
    expect(evaluateGovernanceState()).toMatchObject({ state: "candidate" });
    expect(
      evaluateGovernanceState({
        offlineValidated: true,
        shadowDays: 29,
        paperEligible: true,
      })
    ).toMatchObject({ state: "shadow" });
    expect(
      evaluateGovernanceState({
        offlineValidated: true,
        shadowDays: 30,
        paperEligible: true,
      })
    ).toMatchObject({ state: "paper_eligible" });
    expect(
      evaluateGovernanceState({
        offlineValidated: true,
        shadowDays: 30,
        paperEligible: true,
        activationApproved: true,
      })
    ).toMatchObject({ state: "active" });
  });

  it("degrades at PSI 0.20 and suspends at PSI 0.30", () => {
    expect(
      evaluateGovernanceState({
        offlineValidated: true,
        drift: { psi: 0.2 },
      })
    ).toMatchObject({ state: "degraded", blockers: ["psi_warning"] });
    expect(
      evaluateGovernanceState({
        offlineValidated: true,
        drift: { psi: 0.3 },
      })
    ).toMatchObject({ state: "suspended", blockers: ["psi_critical"] });
  });

  it("hard-blocks parity, signatures and settled online quality", () => {
    const result = evaluateGovernanceState({
      offlineValidated: true,
      contracts: { pythonNodeParity: false, modelSignature: false },
      online: {
        settledSamples: 200,
        ece: 0.081,
        brierSkill: 0,
        meanNetReturn: -0.001,
      },
    });
    expect(result.state).toBe("suspended");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "pythonNodeParity_contract_failed",
        "modelSignature_contract_failed",
        "online_ece_exceeded",
        "online_brier_skill_non_positive",
        "online_cost_adjusted_expectation_negative",
      ])
    );
  });
});
