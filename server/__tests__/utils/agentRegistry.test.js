jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: {
    workspaceAgentInvocation: {
      where: jest.fn(async () => [
        {
          uuid: "invocation-1",
          closed: false,
          workspace_id: 7,
          thread_id: 9,
          user_id: 11,
          clientTurnId: "turn-1",
          createdAt: "2026-07-23T00:00:00.000Z",
          lastUpdatedAt: "2026-07-23T00:00:01.000Z",
        },
      ]),
    },
  },
}));

jest.mock("../../utils/agents/defaults", () => ({
  agentSkillsFromSystemSettings: jest.fn(async () => ["search", "search"]),
}));

jest.mock("../../utils/agents/imported", () => ({
  listImportedPlugins: jest.fn(() => [
    { hubId: "weather", name: "Weather", version: "1", skills: ["forecast"] },
  ]),
}));

jest.mock("../../utils/agentFlows", () => ({
  AgentFlows: { activeFlowPlugins: jest.fn(() => ["review-flow"]) },
}));

jest.mock("../../utils/operations/shadowAgents/definitions", () => ({
  shadowAgentDefinitions: jest.fn(() => []),
}));

jest.mock("../../utils/security/agentManifestSignature", () => ({
  agentSignatureRequired: jest.fn(() => false),
  signAgentManifest: jest.fn(() => ({
    format: "athena-agent-manifest-signature:v1",
    suiteId: "agent-registry-mldsa65-v1",
    signature: "test-signature",
  })),
}));

const {
  agentRegistrySnapshot,
  safePluginIdentity,
} = require("../../utils/operations/agentRegistry");

describe("operations agent registry", () => {
  it("normalizes imported plugins without returning undefined entries", () => {
    expect(
      safePluginIdentity({
        hubId: "weather",
        name: "Weather",
        version: 2,
        skills: ["forecast"],
      })
    ).toEqual({
      id: "imported:weather",
      name: "Weather",
      type: "imported-extension",
      version: "2",
      status: "active",
      capabilities: ["forecast"],
    });
  });

  it("signs the completed registry snapshot and preserves its summary", async () => {
    const snapshot = await agentRegistrySnapshot({ invocationLimit: 25 });
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "workspace-agent" }),
        expect.objectContaining({ id: "imported:weather" }),
        expect.objectContaining({ id: "flow:review-flow" }),
      ])
    );
    expect(snapshot.summary).toMatchObject({
      registered: 3,
      invocations: 1,
      running: 1,
      closed: 0,
    });
    expect(snapshot.integrity).toMatchObject({
      format: "athena-agent-manifest-signature:v1",
      suiteId: "agent-registry-mldsa65-v1",
    });
  });
});
