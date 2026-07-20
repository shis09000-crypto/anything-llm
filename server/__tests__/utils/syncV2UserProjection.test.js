const {
  userEntitlementProjection,
  userNotificationProjection,
  userProfileProjection,
  userSecurityPolicyProjection,
} = require("../../utils/syncV2/userProjection");

describe("Sync V2 user projections", () => {
  const user = {
    id: 7,
    username: "athena",
    displayName: "Athena",
    password: "hashed-secret",
    role: "owner",
    status: "active",
    allowedEnvs: '["development","production"]',
    ownerType: "system",
    suspended: 0,
    dailyMessageLimit: 25,
    web_push_subscription_config: '{"endpoint":"secret"}',
  };

  test("keeps profile data separate from authority fields", () => {
    const projection = userProfileProjection(user);
    expect(projection).toMatchObject({ id: 7, username: "athena" });
    expect(projection).not.toHaveProperty("role");
    expect(projection).not.toHaveProperty("password");
  });

  test("exposes policy state without credential material", () => {
    const projection = userSecurityPolicyProjection(user);
    expect(projection).toMatchObject({
      id: 7,
      role: "owner",
      allowedEnvs: ["development", "production"],
      passwordConfigured: true,
    });
    expect(JSON.stringify(projection)).not.toContain("hashed-secret");
  });

  test("derives entitlements without copying billing or token data", () => {
    expect(userEntitlementProjection(user)).toEqual({
      id: 7,
      dailyMessageLimit: 25,
      unlimitedMessages: true,
      active: true,
    });
  });

  test("reduces notification configuration to capability state", () => {
    expect(userNotificationProjection(user)).toEqual({
      id: 7,
      webPushConfigured: true,
    });
  });
});
