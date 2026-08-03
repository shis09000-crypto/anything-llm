const {
  identityMaintenanceOwnedLocally,
} = require("../../utils/security/identityMaintenanceOwnership");

describe("identity maintenance ownership", () => {
  test("keeps maintenance inside the monolith by default", () => {
    expect(identityMaintenanceOwnedLocally({})).toBe(true);
  });

  test("removes Identity-owned maintenance from a micro-module API", () => {
    expect(
      identityMaintenanceOwnedLocally({
        ATHENA_RUNTIME_ROLE: "api",
        ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
      })
    ).toBe(false);
  });

  test("runs maintenance in the Identity module", () => {
    expect(
      identityMaintenanceOwnedLocally({
        ATHENA_RUNTIME_ROLE: "identity",
        ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
      })
    ).toBe(true);
  });

  test("supports an explicit ownership override", () => {
    expect(
      identityMaintenanceOwnedLocally({
        ATHENA_RUNTIME_ROLE: "identity",
        ATHENA_IDENTITY_MAINTENANCE_INLINE: "false",
      })
    ).toBe(false);
  });
});
