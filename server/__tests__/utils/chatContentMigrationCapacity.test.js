const {
  migrationCapacity,
} = require("../../utils/contentObjects/migrationCapacity");

describe("chat content migration capacity", () => {
  it("budgets a new backup, database rewrite, and fixed reserve", () => {
    expect(
      migrationCapacity({
        databaseBytes: 1_000,
        availableBytes: 2_100,
        reserveBytes: 200,
      })
    ).toEqual({
      databaseBytes: 1_000,
      availableFreeBytes: 2_100,
      requiredFreeBytes: 2_200,
      reserveBytes: 200,
      includesNewBackup: true,
      executeReady: false,
    });
  });

  it("does not budget another backup when a verified backup is supplied", () => {
    expect(
      migrationCapacity({
        databaseBytes: 1_000,
        availableBytes: 1_200,
        reserveBytes: 200,
        existingBackup: true,
      })
    ).toMatchObject({
      requiredFreeBytes: 1_200,
      includesNewBackup: false,
      executeReady: true,
    });
  });
});
