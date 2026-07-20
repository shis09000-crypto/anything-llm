const {
  structuredMemoryProjection,
} = require("../../utils/syncV2/memoryProjection");

describe("Sync V2 memory projections", () => {
  test("never exposes encrypted or plaintext sensitive memory", async () => {
    const client = {
      user_memory_blocks: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 2,
            category: "facts",
            title: "stored-title",
            detail: "stored-detail",
            source: "manual",
            confidence: "high",
            updatedAt: new Date("2026-07-17T12:00:00.000Z"),
            isSensitive: true,
          },
        ]),
      },
    };

    const rows = await structuredMemoryProjection(client, 7001);

    const query = client.user_memory_blocks.findMany.mock.calls[0][0];
    expect(query.select).not.toHaveProperty("encryptedPayload");
    expect(rows[0].title).toBe("••••••••");
    expect(rows[0].detail).toBe("••••••••");
    expect(JSON.stringify(rows)).not.toContain("stored-title");
    expect(JSON.stringify(rows)).not.toContain("stored-detail");
  });
});
