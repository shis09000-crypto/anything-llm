const manifest = require("../../module-manifests/agent-runtime.json");

describe("agent runtime AICP consumers", () => {
  it("declares the identity user-domain wrap capability required by final chat persistence", () => {
    const capability = "identity.user-domain-wrap.queue";

    expect(manifest.rpc.consumes).toContain(capability);
    expect(
      manifest.contracts.consumes.find((entry) => entry.id === capability)
    ).toEqual(
      expect.objectContaining({
        version: "1.0",
        callType: "Command",
        targetModule: "authentication",
        requiredForReadiness: true,
      })
    );
  });
});
