/* eslint-env jest */
jest.mock("../../utils/prisma", () => ({}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../models/user", () => ({
  User: { _get: jest.fn(), filterFields: jest.fn((user) => user) },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn((_request, _response, next) => next()),
}));

const {
  _zkLoginTestUtils: {
    isTrustedDeviceSchemaError,
    normalizeDeviceId,
    opaqueIdentifiers,
    sanitizeTrustedDevice,
    zkUserIdentifier,
  },
} = require("../../endpoints/authZkLogin");

describe("ZK login endpoint helpers", () => {
  it("accepts only base64url-style trusted device ids", () => {
    expect(normalizeDeviceId("abcDEF_123-4567890")).toBe(
      "abcDEF_123-4567890"
    );
    expect(normalizeDeviceId("short")).toBe(null);
    expect(normalizeDeviceId("unsafe/device/id")).toBe(null);
  });

  it("uses stable OPAQUE identifiers without exposing local secrets", () => {
    expect(opaqueIdentifiers("device_1234567890abcdef")).toEqual({
      client: "device_1234567890abcdef",
      server: "Athena",
    });
    expect(zkUserIdentifier(7, "device_1234567890abcdef")).toBe(
      "athena:user:7:device:device_1234567890abcdef"
    );
  });

  it("sanitizes trusted devices without registration records or verifier data", () => {
    const sanitized = sanitizeTrustedDevice({
      id: 1,
      userId: 2,
      deviceId: "device_1234567890abcdef",
      deviceName: "Mac",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastUsedAt: null,
      lastChallengeAt: null,
      lockedUntil: null,
      revokedAt: null,
      opaqueRegistrationRecord: "record",
      verifier: "verifier",
      publicCommitment: "commitment",
    });

    expect(sanitized).toEqual({
      id: 1,
      userId: 2,
      deviceId: "device_1234567890abcdef",
      deviceName: "Mac",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastUsedAt: null,
      lastChallengeAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
    expect(sanitized.opaqueRegistrationRecord).toBeUndefined();
    expect(sanitized.verifier).toBeUndefined();
    expect(sanitized.publicCommitment).toBeUndefined();
  });

  it("recognizes missing trusted-device Prisma schema errors", () => {
    expect(
      isTrustedDeviceSchemaError({
        code: "P2021",
        message: "The table `main.TrustedLoginDevice` does not exist",
        meta: { table: "main.TrustedLoginDevice" },
      })
    ).toBe(true);
    expect(
      isTrustedDeviceSchemaError({
        code: "P2021",
        message: "The table `main.OtherTable` does not exist",
        meta: { table: "main.OtherTable" },
      })
    ).toBe(false);
  });
});
