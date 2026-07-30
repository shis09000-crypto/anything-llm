const Providers = require(".");

function createAgentProvider(config = {}) {
  switch (config.provider) {
    case "openai":
      return new Providers.OpenAIProvider({ model: config.model });
    case "anthropic":
      return new Providers.AnthropicProvider({ model: config.model });
    case "lmstudio":
      return new Providers.LMStudioProvider({ model: config.model });
    case "ollama":
      return new Providers.OllamaProvider({ model: config.model });
    case "groq":
      return new Providers.GroqProvider({ model: config.model });
    case "togetherai":
      return new Providers.TogetherAIProvider({ model: config.model });
    case "azure":
      return new Providers.AzureOpenAiProvider({ model: config.model });
    case "koboldcpp":
      return new Providers.KoboldCPPProvider({});
    case "localai":
      return new Providers.LocalAIProvider({ model: config.model });
    case "openrouter":
      return new Providers.OpenRouterProvider({ model: config.model });
    case "mistral":
      return new Providers.MistralProvider({ model: config.model });
    case "generic-openai":
      return new Providers.GenericOpenAiProvider({ model: config.model });
    case "perplexity":
      return new Providers.PerplexityProvider({ model: config.model });
    case "textgenwebui":
      return new Providers.TextWebGenUiProvider({});
    case "bedrock":
      return new Providers.AWSBedrockProvider({});
    case "fireworksai":
      return new Providers.FireworksAIProvider({ model: config.model });
    case "nvidia-nim":
      return new Providers.NvidiaNimProvider({ model: config.model });
    case "moonshotai":
      return new Providers.MoonshotAiProvider({ model: config.model });
    case "deepseek":
      return new Providers.DeepSeekProvider({ model: config.model });
    case "litellm":
      return new Providers.LiteLLMProvider({ model: config.model });
    case "apipie":
      return new Providers.ApiPieProvider({ model: config.model });
    case "xai":
      return new Providers.XAIProvider({ model: config.model });
    case "zai":
      return new Providers.ZAIProvider({ model: config.model });
    case "novita":
      return new Providers.NovitaProvider({ model: config.model });
    case "ppio":
      return new Providers.PPIOProvider({ model: config.model });
    case "gemini":
      return new Providers.GeminiProvider({ model: config.model });
    case "dpais":
      return new Providers.DellProAiStudioProvider({ model: config.model });
    case "cometapi":
      return new Providers.CometApiProvider({ model: config.model });
    case "foundry":
      return new Providers.FoundryProvider({ model: config.model });
    case "giteeai":
      return new Providers.GiteeAIProvider({ model: config.model });
    case "cohere":
      return new Providers.CohereProvider({ model: config.model });
    case "docker-model-runner":
      return new Providers.DockerModelRunnerProvider({ model: config.model });
    case "privatemode":
      return new Providers.PrivatemodeProvider({ model: config.model });
    case "sambanova":
      return new Providers.SambaNovaProvider({ model: config.model });
    case "lemonade":
      return new Providers.LemonadeProvider({ model: config.model });
    default:
      throw new Error(
        `Unknown provider: ${config.provider}. Please use a valid provider.`
      );
  }
}

module.exports = { createAgentProvider };
