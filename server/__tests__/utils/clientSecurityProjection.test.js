const {
  MAX_CLIENTS_PER_PROJECTION,
  normalizeClientDevicesProjection,
} = require("../../utils/syncV2/clientSecurityProjection");

describe("client security Sync V2 projection", () => {
  it("keeps only the bounded, non-secret projection contract", () => {
    const result = normalizeClientDevicesProjection([
      {
        clientId: "web-client",
        platform: "web",
        deviceName: "Browser",
        publicKey: "must-not-leave-identity",
        pqPublicKey: "must-not-leave-identity",
        signingSecretEncrypted: "must-not-leave-identity",
        createdAt: new Date("2026-08-01T12:00:00.000Z"),
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        clientId: "web-client",
        platform: "web",
        deviceName: "Browser",
        createdAt: "2026-08-01T12:00:00.000Z",
      }),
    ]);
    expect(result[0]).not.toHaveProperty("publicKey");
    expect(result[0]).not.toHaveProperty("pqPublicKey");
    expect(result[0]).not.toHaveProperty("signingSecretEncrypted");
  });

  it("bounds projection cardinality before crossing the module boundary", () => {
    const input = Array.from(
      { length: MAX_CLIENTS_PER_PROJECTION + 25 },
      (_, index) => ({ clientId: `client-${index}` })
    );
    expect(normalizeClientDevicesProjection(input)).toHaveLength(
      MAX_CLIENTS_PER_PROJECTION
    );
  });
});
