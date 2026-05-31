const MODEL_TIERS = {
  rough: {
    providerEnv: "LLM_TASK_ROUGH_PROVIDER",
    modelEnv: "LLM_TASK_ROUGH_MODEL",
    defaultProvider: "deepseek",
    defaultModel: "deepseek-v4-flash",
  },
  refined: {
    providerEnv: "LLM_TASK_REFINED_PROVIDER",
    modelEnv: "LLM_TASK_REFINED_MODEL",
    defaultProvider: "deepseek",
    defaultModel: "deepseek-v4-pro",
  },
  ultra: {
    providerEnv: "LLM_TASK_ULTRA_PROVIDER",
    modelEnv: "LLM_TASK_ULTRA_MODEL",
    defaultProvider: null,
    defaultModel: null,
  },
};

module.exports = { MODEL_TIERS };
