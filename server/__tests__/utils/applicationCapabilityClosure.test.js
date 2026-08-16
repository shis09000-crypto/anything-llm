/* global jest, describe, beforeEach, test, expect */

const mockProbeIdentityCapabilities = jest.fn();
const mockWrapMaterial = jest.fn();
const mockUnwrapMaterial = jest.fn();

jest.mock("../../utils/microModules/serviceHost", () => ({
  distributedTopology: () => true,
}));
jest.mock("../../utils/authz/identityOperationsClient", () => ({
  probeIdentityCapabilities: mockProbeIdentityCapabilities,
}));
jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  wrapMaterial: mockWrapMaterial,
  unwrapMaterial: mockUnwrapMaterial,
}));

const {
  APPLICATION_IDENTITY_CAPABILITIES,
  assertApplicationCapabilityClosure,
} = require("../../utils/coordination/applicationCapabilityClosure");

describe("application capability closure", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProbeIdentityCapabilities.mockResolvedValue({
      ready: true,
      capabilities: Object.fromEntries(
        APPLICATION_IDENTITY_CAPABILITIES.map((capability) => [
          capability,
          "ready",
        ])
      ),
    });
    mockWrapMaterial.mockImplementation(async (value) => `wrapped:${value}`);
    mockUnwrapMaterial.mockImplementation(async (value) =>
      String(value).slice("wrapped:".length)
    );
  });

  test("requires the session, device, user-state and Key Custody path", async () => {
    await expect(assertApplicationCapabilityClosure({})).resolves.toMatchObject({
      ready: true,
      topology: "distributed",
      keyCustody: "ready",
    });
    expect(mockProbeIdentityCapabilities).toHaveBeenCalledWith(
      {},
      APPLICATION_IDENTITY_CAPABILITIES
    );
    expect(mockWrapMaterial).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ purpose: "chat-conversation-key" }),
      {}
    );
  });

  test("fails readiness when a declared owner capability is unavailable", async () => {
    mockProbeIdentityCapabilities.mockResolvedValue({
      ready: false,
      capabilities: { "identity.user-state.read": "missing" },
    });
    await expect(assertApplicationCapabilityClosure({})).rejects.toMatchObject({
      code: "application_identity_capability_incomplete",
    });
    expect(mockWrapMaterial).not.toHaveBeenCalled();
  });
});
