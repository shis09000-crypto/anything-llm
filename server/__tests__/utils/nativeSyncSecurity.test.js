const path = require("path");
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const {
  isHighRiskSignedRequest,
} = require("../../utils/requestSigning");
const { IOSPushToken } = require("../../models/iosPushToken");

describe("native sync security boundaries", () => {
  it.each([
    ["GET", "/api/sync/events/replay"],
    ["POST", "/api/sync/thread-fingerprints"],
    ["POST", "/api/native-app/push-token"],
    ["DELETE", "/api/native-app/push-token"],
    ["POST", "/api/workspace/workspace-a/thread/thread-a/update"],
  ])("requires signed requests for %s %s", (method, path) => {
    expect(isHighRiskSignedRequest({ method, path })).toBe(true);
  });

  it("normalizes APNs device tokens without logging or exposing them", () => {
    const token = "AB".repeat(32);
    expect(IOSPushToken.normalizeDeviceToken(`<${token}>`)).toBe(
      token.toLowerCase()
    );
    expect(IOSPushToken.normalizeDeviceToken("not-a-token")).toBeNull();
    expect(IOSPushToken.fingerprint(token)).not.toContain(token);
  });
});
