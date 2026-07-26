const { summarize } = require("../../scripts/audit-user-root-key-state");

describe("audit-user-root-key-state", () => {
  it("reports existing users as not initialized without exposing identities", async () => {
    const count = jest.fn();
    const client = {
      $authPrismaReady: Promise.resolve(true),
      users: { count: jest.fn().mockResolvedValue(3) },
      user_root_key_epochs: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ authUserId: 11 }, { authUserId: 12 }]),
        count,
      },
      user_root_key_envelopes: { count },
      user_root_key_challenges: { count },
    };
    count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);

    await expect(
      summarize(client, new Date("2026-07-23T00:00:00.000Z"))
    ).resolves.toEqual({
      users: { total: 3, initialized: 2, notInitialized: 1 },
      epochs: { active: 2, retired: 1 },
      envelopes: { pending: 2, expired: 1, consumed: 4 },
      challenges: { outstanding: 3, expired: 2 },
    });
  });
});
