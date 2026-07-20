const { PROVIDER_SETTING_KEYS, updateENV } = require("./helpers/updateENV");

const SECRET_FIELD_PATTERN =
  /(api.?key|accesskey|sessiontoken|authtoken|accesstoken|key)$/i;
const URL_FIELD_PATTERN = /(basepath|endpoint)$/i;
const INTEGER_FIELD_PATTERN =
  /(tokenlimit|maxoutputtokens|maxtokens|timeout|keepaliveseconds)$/i;
const DYNAMIC_MODEL_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "localai",
  "ollama",
  "togetherai",
  "fireworksai",
  "nvidia-nim",
  "mistral",
  "perplexity",
  "openrouter",
  "lmstudio",
  "koboldcpp",
  "litellm",
  "groq",
  "deepseek",
  "apipie",
  "novita",
  "cometapi",
  "xai",
  "gemini",
  "ppio",
  "dpais",
  "moonshotai",
  "foundry",
  "cohere",
  "zai",
  "giteeai",
  "docker-model-runner",
  "privatemode",
  "sambanova",
  "lemonade",
]);

const PICKER_OPTIONS = {
  AzureOpenAiModelType: [
    { value: "default", label: "默认" },
    { value: "reasoning", label: "推理" },
  ],
  AnthropicCacheControl: [
    { value: "none", label: "不缓存" },
    { value: "5m", label: "5 分钟" },
    { value: "1h", label: "1 小时" },
  ],
  GeminiSafetySetting: [
    { value: "BLOCK_NONE", label: "不拦截" },
    { value: "BLOCK_ONLY_HIGH", label: "仅高风险" },
    { value: "BLOCK_MEDIUM_AND_ABOVE", label: "中高风险" },
    { value: "BLOCK_LOW_AND_ABOVE", label: "低风险及以上" },
  ],
  AwsBedrockLLMConnectionMethod: [
    { value: "iam", label: "IAM 凭据" },
    { value: "sessionToken", label: "临时 Session Token" },
    { value: "iam_role", label: "IAM Role" },
    { value: "apiKey", label: "API Key" },
  ],
};

const FIELD_LABELS = {
  OpenAiKey: "API Key",
  OpenAiModelPref: "模型",
  AzureOpenAiEndpoint: "Endpoint",
  AzureOpenAiTokenLimit: "Token 上限",
  AzureOpenAiKey: "API Key",
  AzureOpenAiModelPref: "模型",
  AzureOpenAiModelType: "模型类型",
  AnthropicApiKey: "API Key",
  AnthropicModelPref: "模型",
  AnthropicCacheControl: "Prompt Cache",
  GeminiLLMApiKey: "API Key",
  GeminiLLMModelPref: "模型",
  GeminiSafetySetting: "安全级别",
  LMStudioBasePath: "服务地址",
  LMStudioModelPref: "模型",
  LMStudioTokenLimit: "Token 上限",
  LMStudioAuthToken: "认证 Token",
  LocalAiBasePath: "服务地址",
  LocalAiModelPref: "模型",
  LocalAiTokenLimit: "Token 上限",
  LocalAiApiKey: "API Key",
  OllamaLLMBasePath: "服务地址",
  OllamaLLMModelPref: "模型",
  OllamaLLMTokenLimit: "Token 上限",
  OllamaLLMKeepAliveSeconds: "Keep Alive 秒数",
  OllamaLLMAuthToken: "认证 Token",
  AwsBedrockLLMConnectionMethod: "连接方式",
  AwsBedrockLLMAccessKeyId: "Access Key ID",
  AwsBedrockLLMAccessKey: "Secret Access Key",
  AwsBedrockLLMSessionToken: "Session Token",
  AwsBedrockLLMAPIKey: "API Key",
  AwsBedrockLLMRegion: "区域",
  AwsBedrockLLMModel: "模型",
  AwsBedrockLLMTokenLimit: "Token 上限",
  AwsBedrockLLMMaxOutputTokens: "最大输出 Token",
};

const PROVIDERS = [
  provider("openai", "OpenAI", ["OpenAiKey", "OpenAiModelPref"], ["OpenAiKey"]),
  provider(
    "azure",
    "Azure OpenAI",
    [
      "AzureOpenAiEndpoint",
      "AzureOpenAiKey",
      "AzureOpenAiModelPref",
      "AzureOpenAiTokenLimit",
      "AzureOpenAiModelType",
    ],
    ["AzureOpenAiEndpoint"]
  ),
  provider(
    "anthropic",
    "Anthropic",
    ["AnthropicApiKey", "AnthropicModelPref", "AnthropicCacheControl"],
    ["AnthropicApiKey"]
  ),
  provider(
    "gemini",
    "Gemini",
    ["GeminiLLMApiKey", "GeminiLLMModelPref", "GeminiSafetySetting"],
    ["GeminiLLMApiKey"]
  ),
  provider(
    "nvidia-nim",
    "NVIDIA NIM",
    ["NvidiaNimLLMBasePath", "NvidiaNimLLMModelPref"],
    ["NvidiaNimLLMBasePath"]
  ),
  provider(
    "huggingface",
    "HuggingFace",
    [
      "HuggingFaceLLMEndpoint",
      "HuggingFaceLLMAccessToken",
      "HuggingFaceLLMTokenLimit",
    ],
    [
      "HuggingFaceLLMEndpoint",
      "HuggingFaceLLMAccessToken",
      "HuggingFaceLLMTokenLimit",
    ]
  ),
  provider(
    "ollama",
    "Ollama",
    [
      "OllamaLLMBasePath",
      "OllamaLLMModelPref",
      "OllamaLLMTokenLimit",
      "OllamaLLMKeepAliveSeconds",
      "OllamaLLMAuthToken",
    ],
    ["OllamaLLMBasePath"]
  ),
  provider(
    "dpais",
    "Dell Pro AI Studio",
    [
      "DellProAiStudioBasePath",
      "DellProAiStudioModelPref",
      "DellProAiStudioTokenLimit",
    ],
    [
      "DellProAiStudioBasePath",
      "DellProAiStudioModelPref",
      "DellProAiStudioTokenLimit",
    ]
  ),
  provider(
    "lmstudio",
    "LM Studio",
    [
      "LMStudioBasePath",
      "LMStudioModelPref",
      "LMStudioTokenLimit",
      "LMStudioAuthToken",
    ],
    ["LMStudioBasePath"]
  ),
  provider(
    "docker-model-runner",
    "Docker Model Runner",
    [
      "DockerModelRunnerBasePath",
      "DockerModelRunnerModelPref",
      "DockerModelRunnerModelTokenLimit",
    ],
    [
      "DockerModelRunnerBasePath",
      "DockerModelRunnerModelPref",
      "DockerModelRunnerModelTokenLimit",
    ]
  ),
  provider(
    "lemonade",
    "Lemonade",
    [
      "LemonadeLLMBasePath",
      "LemonadeLLMApiKey",
      "LemonadeLLMModelPref",
      "LemonadeLLMModelTokenLimit",
    ],
    ["LemonadeLLMBasePath"]
  ),
  provider(
    "sambanova",
    "SambaNova",
    ["SambaNovaLLMApiKey", "SambaNovaLLMModelPref"],
    ["SambaNovaLLMApiKey"]
  ),
  provider(
    "localai",
    "Local AI",
    [
      "LocalAiApiKey",
      "LocalAiBasePath",
      "LocalAiModelPref",
      "LocalAiTokenLimit",
    ],
    ["LocalAiApiKey", "LocalAiBasePath", "LocalAiTokenLimit"]
  ),
  provider(
    "togetherai",
    "Together AI",
    ["TogetherAiApiKey", "TogetherAiModelPref"],
    ["TogetherAiApiKey"]
  ),
  provider(
    "fireworksai",
    "Fireworks AI",
    ["FireworksAiLLMApiKey", "FireworksAiLLMModelPref"],
    ["FireworksAiLLMApiKey"]
  ),
  provider(
    "mistral",
    "Mistral",
    ["MistralApiKey", "MistralModelPref"],
    ["MistralApiKey"]
  ),
  provider(
    "perplexity",
    "Perplexity AI",
    ["PerplexityApiKey", "PerplexityModelPref"],
    ["PerplexityApiKey"]
  ),
  provider(
    "openrouter",
    "OpenRouter",
    ["OpenRouterApiKey", "OpenRouterModelPref", "OpenRouterTimeout"],
    ["OpenRouterApiKey"]
  ),
  provider("groq", "Groq", ["GroqApiKey", "GroqModelPref"], ["GroqApiKey"]),
  provider(
    "koboldcpp",
    "KoboldCPP",
    [
      "KoboldCPPBasePath",
      "KoboldCPPModelPref",
      "KoboldCPPTokenLimit",
      "KoboldCPPMaxTokens",
    ],
    ["KoboldCPPBasePath"]
  ),
  provider(
    "textgenwebui",
    "Oobabooga Web UI",
    ["TextGenWebUIBasePath", "TextGenWebUITokenLimit", "TextGenWebUIAPIKey"],
    ["TextGenWebUIBasePath", "TextGenWebUITokenLimit"]
  ),
  provider(
    "cohere",
    "Cohere",
    ["CohereApiKey", "CohereModelPref"],
    ["CohereApiKey"]
  ),
  provider(
    "litellm",
    "LiteLLM",
    [
      "LiteLLMApiKey",
      "LiteLLMBasePath",
      "LiteLLMModelPref",
      "LiteLLMTokenLimit",
    ],
    ["LiteLLMBasePath"]
  ),
  provider(
    "deepseek",
    "DeepSeek",
    ["DeepSeekApiKey", "DeepSeekModelPref"],
    ["DeepSeekApiKey"]
  ),
  provider("ppio", "PPIO", ["PPIOApiKey", "PPIOModelPref"], ["PPIOApiKey"]),
  provider(
    "bedrock",
    "AWS Bedrock",
    [
      "AwsBedrockLLMConnectionMethod",
      "AwsBedrockLLMAccessKeyId",
      "AwsBedrockLLMAccessKey",
      "AwsBedrockLLMSessionToken",
      "AwsBedrockLLMAPIKey",
      "AwsBedrockLLMRegion",
      "AwsBedrockLLMModel",
      "AwsBedrockLLMTokenLimit",
      "AwsBedrockLLMMaxOutputTokens",
    ],
    ["AwsBedrockLLMRegion", "AwsBedrockLLMModel"]
  ),
  provider(
    "apipie",
    "APIpie",
    ["ApipieLLMApiKey", "ApipieLLMModelPref"],
    ["ApipieLLMApiKey", "ApipieLLMModelPref"]
  ),
  provider(
    "moonshotai",
    "Moonshot AI",
    ["MoonshotAiApiKey", "MoonshotAiModelPref"],
    ["MoonshotAiApiKey"]
  ),
  provider(
    "privatemode",
    "Privatemode",
    ["PrivateModeBasePath", "PrivateModeModelPref"],
    ["PrivateModeBasePath"]
  ),
  provider(
    "novita",
    "Novita AI",
    ["NovitaLLMApiKey", "NovitaLLMModelPref", "NovitaLLMTimeout"],
    ["NovitaLLMApiKey"]
  ),
  provider(
    "cometapi",
    "CometAPI",
    ["CometApiLLMApiKey", "CometApiLLMModelPref", "CometApiLLMTimeout"],
    ["CometApiLLMApiKey"]
  ),
  provider(
    "foundry",
    "Microsoft Foundry Local",
    ["FoundryBasePath", "FoundryModelPref", "FoundryModelTokenLimit"],
    ["FoundryBasePath"]
  ),
  provider(
    "xai",
    "xAI",
    ["XAIApiKey", "XAIModelPref"],
    ["XAIApiKey", "XAIModelPref"]
  ),
  provider("zai", "Z.AI", ["ZAiApiKey", "ZAiModelPref"], ["ZAiApiKey"]),
  provider(
    "giteeai",
    "GiteeAI",
    ["GiteeAIApiKey", "GiteeAIModelPref", "GiteeAITokenLimit"],
    ["GiteeAIApiKey"]
  ),
  provider(
    "generic-openai",
    "Generic OpenAI",
    [
      "GenericOpenAiBasePath",
      "GenericOpenAiKey",
      "GenericOpenAiModelPref",
      "GenericOpenAiTokenLimit",
      "GenericOpenAiMaxTokens",
    ],
    ["GenericOpenAiBasePath"]
  ),
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((entry) => [entry.id, entry]));
const VALID_SETTING_KEYS = new Set(PROVIDER_SETTING_KEYS);

function provider(id, name, fields, required = []) {
  return {
    id,
    name,
    required,
    supportsDynamicModels: DYNAMIC_MODEL_PROVIDERS.has(id),
    fields: fields.map((key) => field(key, required.includes(key))),
  };
}

function field(key, required = false) {
  const secret = SECRET_FIELD_PATTERN.test(key);
  const options = PICKER_OPTIONS[key] || [];
  let type = "text";
  if (secret) type = "secret";
  else if (URL_FIELD_PATTERN.test(key)) type = "url";
  else if (INTEGER_FIELD_PATTERN.test(key)) type = "integer";
  else if (options.length) type = "picker";
  return {
    key,
    label: FIELD_LABELS[key] || humanizeSettingKey(key),
    type,
    required,
    secret,
    options,
  };
}

function humanizeSettingKey(value) {
  return String(value)
    .replace(/LLM/g, " LLM ")
    .replace(/API/g, " API ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function publicProviderCatalog({ includeFields = true } = {}) {
  return PROVIDERS.map((entry) => ({
    id: entry.id,
    name: entry.name,
    supportsDynamicModels: entry.supportsDynamicModels,
    fields: includeFields ? entry.fields : [],
  }));
}

function providerSettingsSnapshot(settings, { canManage = false } = {}) {
  const providerId = settings.LLMProvider || "openai";
  const descriptor = PROVIDER_BY_ID.get(providerId) || PROVIDERS[0];
  const values = {};
  if (canManage) {
    const allFields = new Map(
      PROVIDERS.flatMap((providerEntry) => providerEntry.fields).map(
        (fieldDescriptor) => [fieldDescriptor.key, fieldDescriptor]
      )
    );
    for (const fieldDescriptor of allFields.values()) {
      const raw = settings[fieldDescriptor.key];
      values[fieldDescriptor.key] = fieldDescriptor.secret
        ? { configured: Boolean(raw), value: null }
        : {
            configured: raw !== null && raw !== undefined && raw !== "",
            value: raw ?? null,
          };
    }
  }
  return {
    provider: providerId,
    model: settings.LLMModel || modelValue(settings, descriptor),
    values,
  };
}

async function applyProviderSettingsUpdate({
  providerId,
  fields = {},
  userId = null,
}) {
  const descriptor = PROVIDER_BY_ID.get(String(providerId || ""));
  if (!descriptor) throw new Error("Unsupported LLM provider.");
  const allowed = new Map(descriptor.fields.map((entry) => [entry.key, entry]));
  const updates = { LLMProvider: descriptor.id };
  const allowEmptyKeys = [];
  const changedFields = ["LLMProvider"];

  for (const [key, input] of Object.entries(fields || {})) {
    const fieldDescriptor = allowed.get(key);
    if (!fieldDescriptor || !VALID_SETTING_KEYS.has(key)) {
      throw new Error(`Unsupported provider setting: ${key}`);
    }
    const action = String(input?.action || "set");
    if (fieldDescriptor.secret) {
      if (action === "keep") continue;
      if (action === "clear") {
        updates[key] = "";
        allowEmptyKeys.push(key);
      } else if (action === "replace") {
        const replacement = String(input?.value || "").trim();
        if (!replacement)
          throw new Error(`${fieldDescriptor.label} cannot be empty.`);
        updates[key] = replacement;
      } else {
        throw new Error(`Unsupported secret action for ${key}.`);
      }
    } else {
      if (!["set", "replace"].includes(action)) {
        throw new Error(`Unsupported setting action for ${key}.`);
      }
      const value = input?.value;
      if (fieldDescriptor.type === "integer") {
        if (value === "" || value === null || value === undefined) {
          updates[key] = "";
          allowEmptyKeys.push(key);
        } else if (!Number.isFinite(Number(value))) {
          throw new Error(`${fieldDescriptor.label} must be a number.`);
        } else {
          updates[key] = String(value);
        }
      } else {
        updates[key] = String(value ?? "").trim();
        if (!updates[key]) allowEmptyKeys.push(key);
      }
    }
    changedFields.push(key);
  }

  const result = await updateENV(updates, false, userId, { allowEmptyKeys });
  if (result.error) throw new Error(result.error);
  return {
    provider: descriptor.id,
    changedFields: [...new Set(changedFields)],
    newValues: result.newValues,
  };
}

function modelValue(settings, descriptor) {
  const modelField = descriptor.fields.find((entry) =>
    /Model(Pref)?$/.test(entry.key)
  );
  return modelField ? settings[modelField.key] || null : null;
}

module.exports = {
  PROVIDERS,
  applyProviderSettingsUpdate,
  publicProviderCatalog,
  providerSettingsSnapshot,
};
