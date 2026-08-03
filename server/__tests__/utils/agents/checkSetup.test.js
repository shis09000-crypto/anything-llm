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
jest.mock("../../../utils/MCP", () =>
  jest.fn().mockImplementation(() => ({
    activeMCPServers: jest.fn().mockResolvedValue([]),
  }))
);
jest.mock("../../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: {
    get: jest.fn().mockReturnValue(null),
  },
}));

const { AgentHandler } = require("../../../utils/agents");

describe("AgentHandler DeepSeek credential boundary", () => {
  const managedKeys = [
    "ATHENA_RUNTIME_ROLE",
    "ATHENA_RESPONSES_RUNTIME_CUTOVER",
    "ATHENA_RESPONSES_RUNTIME_URL",
    "ATHENA_MODEL_GATEWAY_CUTOVER",
    "ATHENA_MODEL_GATEWAY_URL",
    "DEEPSEEK_API_KEY",
  ];
  const original = Object.fromEntries(
    managedKeys.map((key) => [key, process.env[key]])
  );

  afterEach(() => {
    for (const key of managedKeys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  function deepSeekHandler(model = "deepseek-v4-flash") {
    const handler = new AgentHandler({ uuid: "agent-credential-test" });
    handler.provider = "deepseek";
    handler.model = model;
    return handler;
  }

  test("accepts a credentialless flash Agent when Responses Runtime owns execution", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.ATHENA_RUNTIME_ROLE = "agent-runtime";
    process.env.ATHENA_RESPONSES_RUNTIME_CUTOVER = "true";
    process.env.ATHENA_RESPONSES_RUNTIME_URL = "http://responses-runtime.test";
    process.env.ATHENA_MODEL_GATEWAY_CUTOVER = "true";
    process.env.ATHENA_MODEL_GATEWAY_URL = "http://model-gateway.test";

    expect(() => deepSeekHandler().checkSetup()).not.toThrow();
  });

  test("accepts a credentialless Agent when Model Gateway owns execution", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.ATHENA_RUNTIME_ROLE = "agent-runtime";
    process.env.ATHENA_RESPONSES_RUNTIME_CUTOVER = "false";
    process.env.ATHENA_MODEL_GATEWAY_CUTOVER = "true";
    process.env.ATHENA_MODEL_GATEWAY_URL = "http://model-gateway.test";

    expect(() => deepSeekHandler("deepseek-v4-pro").checkSetup()).not.toThrow();
  });

  test("still rejects local DeepSeek Agent execution without a key", () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.ATHENA_RUNTIME_ROLE = "agent-runtime";
    process.env.ATHENA_RESPONSES_RUNTIME_CUTOVER = "false";
    process.env.ATHENA_MODEL_GATEWAY_CUTOVER = "false";
    delete process.env.ATHENA_RESPONSES_RUNTIME_URL;
    delete process.env.ATHENA_MODEL_GATEWAY_URL;

    expect(() => deepSeekHandler().checkSetup()).toThrow(
      "DeepSeek API Key must be provided to use agents."
    );
  });
});
