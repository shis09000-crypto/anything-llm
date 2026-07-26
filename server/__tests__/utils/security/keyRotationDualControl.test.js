const {
  keyDualControlRequired,
  rotationApprovalPolicy,
  rotationExecutionAuthorization,
} = require("../../../utils/security/keyLifecycle");

describe("key rotation dual control", () => {
  test("cannot be disabled in production", () => {
    expect(
      keyDualControlRequired({
        APP_ENV: "production",
        ATHENA_KEY_DUAL_CONTROL_REQUIRED: "false",
      })
    ).toBe(true);
    expect(() =>
      rotationApprovalPolicy({
        createdBy: null,
        env: { APP_ENV: "production" },
      })
    ).toThrow("key_rotation_authenticated_initiator_required");
  });

  test("requires an independent unexpired approver", () => {
    const now = new Date("2026-07-23T00:00:00.000Z");
    const job = {
      jobId: "keyrot_1",
      createdBy: 10,
      requiredApprovals: 1,
      approvalExpiresAt: "2026-07-23T00:30:00.000Z",
    };
    expect(
      rotationExecutionAuthorization({
        job,
        actorUserId: 10,
        now,
        approvals: [
          {
            approverUserId: 10,
            decision: "approved",
            expiresAt: "2026-07-23T00:30:00.000Z",
          },
        ],
      })
    ).toMatchObject({
      authorized: false,
      reason: "key_rotation_independent_approval_required",
    });
    expect(
      rotationExecutionAuthorization({
        job,
        actorUserId: 10,
        now,
        approvals: [
          {
            approverUserId: 11,
            decision: "approved",
            expiresAt: "2026-07-23T00:30:00.000Z",
          },
        ],
      })
    ).toEqual({ authorized: true, approvalCount: 1 });
  });

  test("rejects expired approval windows and unauthenticated executors", () => {
    const job = {
      createdBy: 10,
      requiredApprovals: 1,
      approvalExpiresAt: "2026-07-23T00:30:00.000Z",
    };
    expect(
      rotationExecutionAuthorization({
        job,
        actorUserId: null,
        now: new Date("2026-07-23T00:00:00.000Z"),
      }).reason
    ).toBe("key_rotation_executor_required");
    expect(
      rotationExecutionAuthorization({
        job,
        actorUserId: 12,
        now: new Date("2026-07-23T01:00:00.000Z"),
      }).reason
    ).toBe("key_rotation_approval_expired");
  });
});
