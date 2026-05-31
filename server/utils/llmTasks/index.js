const { getLLMProvider } = require("../helpers");
const { MODEL_TIERS } = require("./modelTiers");
const { TASK_REGISTRY } = require("./taskRegistry");

class LLMTaskError extends Error {
  constructor(message, { taskName, code, cause = null, metadata = {} } = {}) {
    super(message);
    this.name = "LLMTaskError";
    this.taskName = taskName;
    this.code = code || "LLM_TASK_ERROR";
    this.cause = cause;
    this.metadata = metadata;
  }
}

function envString(name, defaultValue = null) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "")
    return defaultValue;
  return String(value).trim();
}

function resolveTaskConfig(taskName, overrides = {}) {
  const config = TASK_REGISTRY[taskName];
  if (!config) {
    throw new LLMTaskError(`Unknown LLM task: ${taskName}`, {
      taskName,
      code: "LLM_TASK_UNKNOWN",
    });
  }
  return { ...config, ...overrides };
}

function resolveTier(tierName, overrides = {}) {
  const tier = MODEL_TIERS[tierName];
  if (!tier) {
    throw new LLMTaskError(`Unknown LLM task model tier: ${tierName}`, {
      code: "LLM_TASK_UNKNOWN_TIER",
    });
  }
  const provider =
    overrides.provider !== undefined
      ? overrides.provider
      : envString(tier.providerEnv, tier.defaultProvider);
  const model =
    overrides.model !== undefined
      ? overrides.model
      : envString(tier.modelEnv, tier.defaultModel);
  if (!provider || !model) {
    throw new LLMTaskError(
      `LLM task model tier "${tierName}" is not configured.`,
      {
        code: "LLM_TASK_TIER_UNCONFIGURED",
        metadata: { tier: tierName },
      }
    );
  }
  return { provider, model, tier: tierName };
}

function legacyTierOverrides(config = {}) {
  const provider = config.legacyProviderEnv
    ? envString(config.legacyProviderEnv)
    : null;
  const model = config.legacyModelEnv ? envString(config.legacyModelEnv) : null;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function providerDefault(provider = null) {
  switch (provider) {
    case "deepseek":
      return process.env.DEEPSEEK_MODEL_PREF ?? "deepseek-chat";
    case "novita":
      return process.env.NOVITA_LLM_MODEL_PREF ?? "deepseek/deepseek-r1";
    default:
      return null;
  }
}

function resolveDynamicTaskProviderModel(taskName, config = {}, context = {}) {
  const workspace = context.workspace || null;
  if (config.dynamic === "workspace_chat_or_system") {
    const provider =
      workspace?.chatProvider || process.env.LLM_PROVIDER || null;
    return {
      provider,
      model:
        workspace?.chatModel ||
        (provider === "deepseek" ? process.env.DEEPSEEK_MODEL_PREF : null) ||
        null,
    };
  }

  if (config.dynamic === "workspace_chat") {
    return {
      provider: workspace?.chatProvider,
      model: workspace?.chatModel,
    };
  }

  if (config.dynamic === "agent_provider") {
    const provider =
      context.provider ?? workspace?.agentProvider ?? workspace?.chatProvider;
    const model =
      context.model ??
      workspace?.agentModel ??
      workspace?.chatModel ??
      providerDefault(provider);
    return { provider, model };
  }

  throw new LLMTaskError(`Unsupported dynamic LLM task: ${taskName}`, {
    taskName,
    code: "LLM_TASK_DYNAMIC_UNSUPPORTED",
  });
}

function resolveTaskProviderModel(taskName, context = {}, overrides = {}) {
  const config = resolveTaskConfig(taskName, overrides);
  if (config.dynamic)
    return resolveDynamicTaskProviderModel(taskName, config, context);

  const tier = resolveTier(config.tier, {
    ...legacyTierOverrides(config),
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
  });

  if (
    config.fallbackToWorkspace &&
    tier.provider === null &&
    tier.model === null
  ) {
    return {
      provider: context.workspace?.chatProvider,
      model: context.workspace?.chatModel,
    };
  }

  return { provider: tier.provider, model: tier.model, tier: tier.tier };
}

function wrapTaskError(taskName, error, metadata = {}) {
  if (error instanceof LLMTaskError) return error;
  const message = error?.message || String(error || "LLM task failed");
  const missingProviderKey = /No DeepSeek API key|DeepSeek API Key/i.test(
    message
  );
  return new LLMTaskError(`LLM task "${taskName}" failed: ${message}`, {
    taskName,
    code: missingProviderKey
      ? "LLM_TASK_PROVIDER_MISSING_KEY"
      : "LLM_TASK_CONNECTOR_UNAVAILABLE",
    cause: error,
    metadata,
  });
}

function getTaskConnector(taskName, context = {}, overrides = {}) {
  const resolved = resolveTaskProviderModel(taskName, context, overrides);
  try {
    if (
      process.env.NODE_ENV !== "test" &&
      resolved.provider === "deepseek" &&
      !process.env.DEEPSEEK_API_KEY
    ) {
      throw new Error("No DeepSeek API key was set.");
    }
    const connector = getLLMProvider({
      provider: resolved.provider,
      model: resolved.model,
    });
    return {
      connector,
      provider: resolved.provider,
      model: connector?.model || resolved.model,
    };
  } catch (error) {
    throw wrapTaskError(taskName, error, {
      provider: resolved.provider,
      model: resolved.model,
    });
  }
}

async function withTaskLogging(taskName, metadata = {}, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(
      `[LLMTask] ${taskName} succeeded durationMs=${Date.now() - startedAt}`,
      metadata
    );
    return result;
  } catch (error) {
    console.warn(
      `[LLMTask] ${taskName} failed durationMs=${Date.now() - startedAt}`,
      { ...metadata, error: error.message }
    );
    throw wrapTaskError(taskName, error, metadata);
  }
}

module.exports = {
  LLMTaskError,
  resolveTaskConfig,
  resolveTier,
  resolveTaskProviderModel,
  getTaskConnector,
  withTaskLogging,
  wrapTaskError,
};
