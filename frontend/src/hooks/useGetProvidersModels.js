import System from "@/models/system";
import { useEffect, useState } from "react";

// Providers which cannot use this feature for workspace<>model selection
export const DISABLED_PROVIDERS = [
  "azure",
  "textgenwebui",
  "generic-openai",
  "bedrock",
];
const PROVIDER_DEFAULT_MODELS = {
  openai: [],
  gemini: [],
  anthropic: [],
  azure: [],
  lmstudio: [],
  localai: [],
  ollama: [],
  togetherai: [],
  fireworksai: [],
  "nvidia-nim": [],
  groq: [],
  cohere: [
    "command-r",
    "command-r-plus",
    "command",
    "command-light",
    "command-nightly",
    "command-light-nightly",
  ],
  textgenwebui: [],
  "generic-openai": [],
  bedrock: [],
  xai: ["grok-beta"],
};

// For providers with large model lists (e.g. togetherAi) - we subgroup the options
// by their creator organization (eg: Meta, Mistral, etc)
// which makes selection easier to read.
function groupModels(models) {
  return models.reduce((acc, model) => {
    acc[model.organization] = acc[model.organization] || [];
    acc[model.organization].push(model);
    return acc;
  }, {});
}

const groupedProviders = [
  "togetherai",
  "fireworksai",
  "openai",
  "novita",
  "openrouter",
  "ppio",
  "docker-model-runner",
  "sambanova",
];
export default function useGetProviderModels(provider = null, options = {}) {
  const [defaultModels, setDefaultModels] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let stale = false;
    async function fetchProviderModels() {
      if (!provider) {
        setDefaultModels([]);
        setCustomModels([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      let models = [];
      try {
        const response = await System.customModels(provider, null, null, null, {
          signal: controller.signal,
          communicationScene:
            options.communicationScene || "llm-model-selector-visible",
          task: options.task || {
            label: `llm-selector:models:${provider}`,
            kind: "settings",
            priority: "P1",
            policy: "visible",
            intentRank: 1,
            scope: {
              route: "workspace-chat",
              surface: "llm-selector",
              provider,
              ...(options.scope || {}),
            },
          },
        });
        models = response?.models || [];
      } catch (error) {
        if (error?.name === "AbortError" || stale) return;
        console.error(error);
      }
      if (stale || controller.signal.aborted) return;
      if (
        PROVIDER_DEFAULT_MODELS.hasOwnProperty(provider) &&
        !groupedProviders.includes(provider)
      ) {
        setDefaultModels(PROVIDER_DEFAULT_MODELS[provider]);
      } else {
        setDefaultModels([]);
      }

      groupedProviders.includes(provider)
        ? setCustomModels(groupModels(models))
        : setCustomModels(models);
      setLoading(false);
    }
    fetchProviderModels();
    return () => {
      stale = true;
      controller.abort();
    };
  }, [provider, options.communicationScene, options.task, options.scope]);

  return { defaultModels, customModels, loading };
}
