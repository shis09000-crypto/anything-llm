const {
  rolloutPercent,
  syncV2CohortEnabled,
} = require("../../utils/syncV2/config");

describe("Sync V2 deterministic cohort rollout", () => {
  const enabled = {
    ATHENA_SYNC_V2_ENABLED: "true",
    ATHENA_SYNC_V2_DOMAINS: "all",
  };

  it("defaults enabled deployments to full compatibility", () => {
    expect(rolloutPercent("core", enabled)).toBe(100);
    expect(
      syncV2CohortEnabled(
        { userId: 1, clientId: "web", domain: "core" },
        enabled
      )
    ).toBe(true);
  });

  it("supports domain overrides and hard zero/full gates", () => {
    const env = {
      ...enabled,
      ATHENA_SYNC_V2_ROLLOUT_PERCENT: "25",
      ATHENA_SYNC_V2_DOMAIN_ROLLOUTS: "security:0,chat:100",
    };
    expect(rolloutPercent("security", env)).toBe(0);
    expect(rolloutPercent("chat", env)).toBe(100);
    expect(
      syncV2CohortEnabled(
        { userId: 1, clientId: "ios", domain: "security" },
        env
      )
    ).toBe(false);
    expect(
      syncV2CohortEnabled({ userId: 1, clientId: "ios", domain: "chat" }, env)
    ).toBe(true);
  });

  it("assigns the same user, device, and domain deterministically", () => {
    const env = { ...enabled, ATHENA_SYNC_V2_ROLLOUT_PERCENT: "37" };
    const input = { userId: 42, clientId: "device-a", domain: "core" };
    expect(syncV2CohortEnabled(input, env)).toBe(
      syncV2CohortEnabled(input, env)
    );
  });
});
