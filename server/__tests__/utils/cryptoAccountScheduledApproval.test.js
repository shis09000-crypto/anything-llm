const {
  scheduledApprovalDecision,
} = require("../../utils/plugins/securityPolicy");

describe("scheduled crypto account preapproval", () => {
  const originalMode = process.env.ATHENA_PLUGIN_SECURITY_V2;

  beforeAll(() => {
    process.env.ATHENA_PLUGIN_SECURITY_V2 = "enforce";
  });

  afterAll(() => {
    if (originalMode === undefined) {
      delete process.env.ATHENA_PLUGIN_SECURITY_V2;
    } else {
      process.env.ATHENA_PLUGIN_SECURITY_V2 = originalMode;
    }
  });

  const job = {
    id: 9,
    capabilityManifest: JSON.stringify({
      tools: ["crypto-account-agent#crypto_account_activity"],
      accountPrivateRead: {
        approved: true,
        provider: "gate",
        functions: ["crypto_account_activity"],
        symbols: ["BTC"],
        maxDays: 7,
        maxLimit: 50,
        credentialVersion: 2,
        rootKeyId: "r".repeat(43),
        domainKeyVersion: 1,
        approvedAt: new Date().toISOString(),
      },
    }),
  };

  test("approves only the declared function and bounded scope", () => {
    expect(
      scheduledApprovalDecision({
        job,
        skillName: "crypto_account_activity",
        forceApproval: true,
        approvalClass: "account-private-read",
        payload: {
          approvalClass: "account-private-read",
          symbol: "BTC",
          days: 7,
          limit: 50,
        },
      }).approved
    ).toBe(true);
  });

  test("denies function or range expansion", () => {
    expect(
      scheduledApprovalDecision({
        job,
        skillName: "crypto_account_overview",
        forceApproval: true,
        approvalClass: "account-private-read",
        payload: { approvalClass: "account-private-read" },
      }).approved
    ).toBe(false);
    expect(
      scheduledApprovalDecision({
        job,
        skillName: "crypto_account_activity",
        forceApproval: true,
        approvalClass: "account-private-read",
        payload: {
          approvalClass: "account-private-read",
          symbol: "ETH",
          days: 8,
          limit: 50,
        },
      }).approved
    ).toBe(false);
  });
});
