jest.mock("../../utils/helpers/updateENV", () => {
  process.env.STORAGE_DIR ||= "/tmp/athena-provider-settings-tests";
  const actual = jest.requireActual("../../utils/helpers/updateENV");
  return {
    ...actual,
    updateENV: jest.fn(),
  };
});

const {
  PROVIDER_SETTING_KEYS,
  updateENV,
} = require("../../utils/helpers/updateENV");
const {
  PROVIDERS,
  applyProviderSettingsUpdate,
  publicProviderCatalog,
  providerSettingsSnapshot,
} = require("../../utils/providerSettingsCatalog");

describe("native LLM provider settings catalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateENV.mockResolvedValue({ newValues: {}, error: false });
  });

  it("covers every main-chat provider exposed by the web settings page", () => {
    expect(PROVIDERS.map((provider) => provider.id)).toEqual([
      "openai",
      "azure",
      "anthropic",
      "gemini",
      "nvidia-nim",
      "huggingface",
      "ollama",
      "dpais",
      "lmstudio",
      "docker-model-runner",
      "lemonade",
      "sambanova",
      "localai",
      "togetherai",
      "fireworksai",
      "mistral",
      "perplexity",
      "openrouter",
      "groq",
      "koboldcpp",
      "textgenwebui",
      "cohere",
      "litellm",
      "deepseek",
      "ppio",
      "bedrock",
      "apipie",
      "moonshotai",
      "privatemode",
      "novita",
      "cometapi",
      "foundry",
      "xai",
      "zai",
      "giteeai",
      "generic-openai",
    ]);
    for (const provider of PROVIDERS) {
      for (const field of provider.fields) {
        expect(PROVIDER_SETTING_KEYS).toContain(field.key);
      }
    }
  });

  it("never returns a configured secret value", () => {
    const snapshot = providerSettingsSnapshot(
      {
        LLMProvider: "openai",
        LLMModel: "gpt-4.1",
        OpenAiKey: true,
        OpenAiModelPref: "gpt-4.1",
      },
      { canManage: true }
    );

    expect(snapshot.values.OpenAiKey).toEqual({
      configured: true,
      value: null,
    });
    expect(snapshot.values.OpenAiModelPref.value).toBe("gpt-4.1");
    expect(publicProviderCatalog({ includeFields: false })[0].fields).toEqual(
      []
    );
  });

  it("uses explicit keep, replace, and clear semantics for secrets", async () => {
    updateENV.mockResolvedValue({
      newValues: {
        LLMProvider: "openai",
        OpenAiKey: "",
        OpenAiModelPref: "gpt-4.1",
      },
      error: false,
    });

    await applyProviderSettingsUpdate({
      providerId: "openai",
      userId: 7,
      fields: {
        OpenAiKey: { action: "clear" },
        OpenAiModelPref: { action: "set", value: "gpt-4.1" },
      },
    });

    expect(updateENV).toHaveBeenCalledWith(
      {
        LLMProvider: "openai",
        OpenAiKey: "",
        OpenAiModelPref: "gpt-4.1",
      },
      false,
      7,
      { allowEmptyKeys: ["OpenAiKey"] }
    );

    await applyProviderSettingsUpdate({
      providerId: "openai",
      fields: {
        OpenAiKey: { action: "keep" },
      },
    });
    expect(updateENV).toHaveBeenLastCalledWith(
      { LLMProvider: "openai" },
      false,
      null,
      { allowEmptyKeys: [] }
    );
  });

  it("rejects fields that do not belong to the selected provider", async () => {
    await expect(
      applyProviderSettingsUpdate({
        providerId: "openai",
        fields: {
          AnthropicApiKey: { action: "replace", value: "secret" },
        },
      })
    ).rejects.toThrow("Unsupported provider setting");
  });
});
