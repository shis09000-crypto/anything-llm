const {
  evaluateEscalation,
} = require("../../utils/coordination/autonomyPolicy");

const exhausted = (level) => ({
  level,
  status: "exhausted",
  validation: "failed",
  evidenceRef: `trace:l${level}`,
});

describe("coordination autonomy escalation policy", () => {
  test("L2 cannot run before L1 is exhausted", () => {
    expect(
      evaluateEscalation({ currentLevel: 1, targetLevel: 2, evidence: [] })
    ).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining(["self_heal_not_exhausted"]),
    });
  });

  test("L3 cannot skip L2 even when L1 evidence exists", () => {
    expect(
      evaluateEscalation({
        currentLevel: 1,
        targetLevel: 3,
        evidence: [exhausted(1)],
      })
    ).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining([
        "autonomy_level_skip_denied",
        "coordinated_isolation_not_exhausted",
      ]),
    });
  });

  test("L3 execution requires approval after L1 and L2 exhaustion", () => {
    expect(
      evaluateEscalation({
        currentLevel: 2,
        targetLevel: 3,
        evidence: [exhausted(1), exhausted(2)],
        phase: "execute",
        approvalCount: 0,
      })
    ).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining(["operations_approval_required"]),
    });
  });

  test("L4 execution requires two approvals", () => {
    expect(
      evaluateEscalation({
        currentLevel: 3,
        targetLevel: 4,
        evidence: [exhausted(1), exhausted(2)],
        phase: "execute",
        approvalCount: 1,
      })
    ).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining(["dual_approval_required"]),
    });
  });

  test("successful lower-level recovery permanently closes escalation", () => {
    expect(
      evaluateEscalation({
        currentLevel: 1,
        targetLevel: 2,
        evidence: [
          exhausted(1),
          {
            level: 1,
            status: "succeeded",
            validation: "passed",
            evidenceRef: "trace:recovered",
          },
        ],
      })
    ).toMatchObject({
      allowed: false,
      reasons: expect.arrayContaining(["lower_level_recovery_succeeded"]),
    });
  });
});
