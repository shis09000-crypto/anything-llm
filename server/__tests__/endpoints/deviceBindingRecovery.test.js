/* global jest, describe, test, expect */

const mockIssueDeviceBindingChallenge = jest.fn();

jest.mock("../../utils/authz/deviceBindingRecovery", () => ({
  issueDeviceBindingChallenge: mockIssueDeviceBindingChallenge,
}));

const {
  deviceBindingRecoveryEndpoints,
} = require("../../endpoints/deviceBindingRecovery");

describe("device binding recovery endpoints", () => {
  test("exposes only preflight and does not register recovery-code recovery", () => {
    const app = { post: jest.fn() };

    deviceBindingRecoveryEndpoints(app);

    expect(app.post).toHaveBeenCalledTimes(1);
    expect(app.post).toHaveBeenCalledWith(
      "/auth/device-binding/preflight",
      expect.any(Function)
    );
    expect(
      app.post.mock.calls.some(
        ([path]) => path === "/auth/device-binding/recover/recovery-code"
      )
    ).toBe(false);
  });
});
