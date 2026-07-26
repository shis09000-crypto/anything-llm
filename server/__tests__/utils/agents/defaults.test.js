// Set required env vars before requiring modules
process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

const {
  SystemPromptVariables,
} = require("../../../models/systemPromptVariables");
const Provider = require("../../../utils/agents/aibitat/providers/ai-provider");
const mockCryptoAccountEligibility = jest.fn();

jest.mock("../../../models/systemPromptVariables");
jest.mock("../../../models/systemSettings");
jest.mock("../../../utils/cryptoAccount", () => ({
  cryptoAccountEligibility: (...args) => mockCryptoAccountEligibility(...args),
}));
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

const {
  WORKSPACE_AGENT,
  agentSkillsFromSystemSettings,
  sortedDynamicFunctions,
} = require("../../../utils/agents/defaults");

function expectMandatoryAgentPolicies(role, basePrompt) {
  expect(role.startsWith(basePrompt)).toBe(true);
  expect(role).toContain("MUST use the request-user-input tool");
  expect(role).toContain("MUST call save_memory");
}

describe("WORKSPACE_AGENT.getDefinition", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCryptoAccountEligibility.mockResolvedValue({ available: false });
    // Mock SystemSettings to return empty arrays for agent skills
    const { SystemSettings } = require("../../../models/systemSettings");
    SystemSettings.getValueOrFallback = jest.fn().mockResolvedValue("[]");
  });

  it("should use provider default system prompt when workspace has no openAiPrompt", async () => {
    const workspace = {
      id: 1,
      name: "Test Workspace",
      openAiPrompt: null,
    };
    const user = { id: 1 };
    const provider = "openai";
    const expectedPrompt = await Provider.systemPrompt({
      provider,
      workspace,
      user,
    });
    const definition = await WORKSPACE_AGENT.getDefinition(
      provider,
      workspace,
      user
    );
    expectMandatoryAgentPolicies(definition.role, expectedPrompt);
    expect(
      SystemPromptVariables.expandSystemPromptVariables
    ).not.toHaveBeenCalled();
  });

  it("should use workspace system prompt with variable expansion when openAiPrompt exists", async () => {
    const workspace = {
      id: 1,
      name: "Test Workspace",
      openAiPrompt:
        "You are a helpful assistant for {workspace.name}. The current user is {user.name}.",
    };
    const user = { id: 1 };
    const provider = "openai";

    const expandedPrompt =
      "You are a helpful assistant for Test Workspace. The current user is John Doe.";
    SystemPromptVariables.expandSystemPromptVariables.mockResolvedValue(
      expandedPrompt
    );

    const definition = await WORKSPACE_AGENT.getDefinition(
      provider,
      workspace,
      user
    );

    expect(
      SystemPromptVariables.expandSystemPromptVariables
    ).toHaveBeenCalledWith(workspace.openAiPrompt, user.id, workspace.id);
    expectMandatoryAgentPolicies(definition.role, expandedPrompt);
  });

  it("should handle workspace system prompt without user context", async () => {
    const workspace = {
      id: 1,
      name: "Test Workspace",
      openAiPrompt: "You are a helpful assistant. Today is {date}.",
    };
    const user = null;
    const provider = "lmstudio";
    const expandedPrompt =
      "You are a helpful assistant. Today is January 1, 2024.";
    SystemPromptVariables.expandSystemPromptVariables.mockResolvedValue(
      expandedPrompt
    );

    const definition = await WORKSPACE_AGENT.getDefinition(
      provider,
      workspace,
      user
    );

    expect(
      SystemPromptVariables.expandSystemPromptVariables
    ).toHaveBeenCalledWith(workspace.openAiPrompt, null, workspace.id);
    expectMandatoryAgentPolicies(definition.role, expandedPrompt);
  });

  it("should return functions array in definition", async () => {
    const workspace = { id: 1, openAiPrompt: null };
    const provider = "openai";

    const definition = await WORKSPACE_AGENT.getDefinition(
      provider,
      workspace,
      null
    );

    expect(definition).toHaveProperty("functions");
    expect(Array.isArray(definition.functions)).toBe(true);
    expect(definition.functions).toEqual(
      expect.arrayContaining([
        "document-ingest-agent",
        "crypto-market-agent#crypto_price",
        "crypto-market-agent#crypto_market_snapshot",
        "weather-agent#weather_current",
        "weather-agent#weather_forecast",
        "global-market-agent#global_forex_rate",
        "global-market-agent#global_index_quote",
        "global-market-agent#global_stock_quote",
        "global-market-agent#global_commodity_quote",
        "global-market-agent#global_fund_quote",
        "create-files-agent#create-text-file",
        "create-files-agent#create-docx-file",
        "create-files-agent#create-pdf-file",
        "document-formatting-agent#format-docx-file",
      ])
    );
  });

  it("applies group and sub-skill controls to default document tools", async () => {
    const { SystemSettings } = require("../../../models/systemSettings");
    SystemSettings.getValueOrFallback = jest
      .fn()
      .mockImplementation(async ({ label }) => {
        if (label === "disabled_agent_skills")
          return JSON.stringify(["document-formatting-agent"]);
        if (label === "disabled_create_files_skills")
          return JSON.stringify(["create-pdf-file"]);
        return "[]";
      });

    const functions = await agentSkillsFromSystemSettings();
    expect(functions).toContain("create-files-agent#create-text-file");
    expect(functions).toContain("create-files-agent#create-docx-file");
    expect(functions).not.toContain("create-files-agent#create-pdf-file");
    expect(functions).not.toContain(
      "document-formatting-agent#format-docx-file"
    );
  });

  it("completely hides private crypto tools for an ineligible account", async () => {
    const functions = await agentSkillsFromSystemSettings({
      id: 1,
      authUserId: 11,
    });

    expect(
      functions.some((name) => name.startsWith("crypto-account-agent#"))
    ).toBe(false);
  });

  it("loads private crypto tools only when eligible and not disabled globally", async () => {
    mockCryptoAccountEligibility.mockResolvedValue({ available: true });
    const eligibleUser = { id: 1, authUserId: 11 };
    const functions = await agentSkillsFromSystemSettings(eligibleUser);
    expect(functions).toEqual(
      expect.arrayContaining([
        "crypto-account-agent#crypto_account_overview",
        "crypto-account-agent#crypto_account_holdings",
        "crypto-account-agent#crypto_account_positions",
        "crypto-account-agent#crypto_account_activity",
      ])
    );

    const { SystemSettings } = require("../../../models/systemSettings");
    SystemSettings.getValueOrFallback = jest
      .fn()
      .mockImplementation(async ({ label }) =>
        label === "disabled_agent_skills"
          ? JSON.stringify(["crypto-account-agent"])
          : "[]"
      );
    const disabled = await agentSkillsFromSystemSettings(eligibleUser);
    expect(
      disabled.some((name) => name.startsWith("crypto-account-agent#"))
    ).toBe(false);
  });

  it("deduplicates legacy create-files default settings", async () => {
    const { SystemSettings } = require("../../../models/systemSettings");
    SystemSettings.getValueOrFallback = jest
      .fn()
      .mockImplementation(async ({ label }) => {
        if (label === "default_agent_skills")
          return JSON.stringify(["create-files-agent"]);
        return "[]";
      });

    const functions = await agentSkillsFromSystemSettings();
    expect(
      functions.filter((name) => name === "create-files-agent#create-docx-file")
    ).toHaveLength(1);
  });

  it("removes only the disabled default market data group", async () => {
    const { SystemSettings } = require("../../../models/systemSettings");
    SystemSettings.getValueOrFallback = jest
      .fn()
      .mockImplementation(async ({ label }) =>
        label === "disabled_agent_skills"
          ? JSON.stringify(["crypto-market-agent"])
          : "[]"
      );

    const functions = await agentSkillsFromSystemSettings();
    expect(functions).not.toEqual(
      expect.arrayContaining([
        "crypto-market-agent#crypto_price",
        "crypto-market-agent#crypto_market_snapshot",
      ])
    );
    expect(functions).toEqual(
      expect.arrayContaining([
        "weather-agent#weather_current",
        "weather-agent#weather_forecast",
        "global-market-agent#global_forex_rate",
        "global-market-agent#global_stock_quote",
      ])
    );
  });

  it("should use LMStudio specific prompt when workspace has no openAiPrompt", async () => {
    const workspace = { id: 1, openAiPrompt: null };
    const user = null;
    const provider = "lmstudio";
    const definition = await WORKSPACE_AGENT.getDefinition(
      provider,
      workspace,
      null
    );

    expectMandatoryAgentPolicies(
      definition.role,
      await Provider.systemPrompt({ provider, workspace, user })
    );
    expect(definition.role).toContain("helpful ai assistant");
  });

  it("sorts and deduplicates dynamic agent functions", () => {
    expect(
      sortedDynamicFunctions(["@@flow_b", "@@flow_a", "@@flow_b"])
    ).toEqual(["@@flow_a", "@@flow_b"]);
  });
});
