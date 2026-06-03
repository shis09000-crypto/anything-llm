process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("../../../utils/agents/imported", () => ({
  activeImportedPlugins: jest.fn().mockReturnValue([]),
}));
jest.mock("../../../utils/agentFlows", () => ({
  AgentFlows: {
    activeFlowPlugins: jest.fn().mockReturnValue([]),
  },
}));
jest.mock("../../../utils/MCP", () => {
  return jest.fn().mockImplementation(() => ({
    activeMCPServers: jest.fn().mockResolvedValue([]),
  }));
});
jest.mock("../../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: {
    get: jest.fn().mockReturnValue(null),
  },
}));

const { AgentHandler } = require("../../../utils/agents");

describe("AgentHandler.parseCallOptions", () => {
  it("handles null setup definitions without crashing plugin attachment", () => {
    const handler = new AgentHandler({ uuid: "test-invocation" });
    const logSpy = jest.spyOn(handler, "log").mockImplementation(() => {});

    const result = handler.parseCallOptions(
      { provided: "value" },
      {
        broken: null,
        provided: { default: "fallback" },
        missingRequired: { required: true },
      },
      "dynamic-plugin"
    );

    expect(result).toEqual({
      broken: null,
      provided: "value",
    });
    expect(logSpy).toHaveBeenCalledWith(
      "'missingRequired' required parameter for 'dynamic-plugin' plugin is missing. Plugin may not function or crash agent."
    );
  });
});
