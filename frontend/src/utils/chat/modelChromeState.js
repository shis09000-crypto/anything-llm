function normalizeModelChromeValue(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function resolveModelChromeState({
  workspace = {},
  settings = {},
} = {}) {
  const modelName =
    normalizeModelChromeValue(workspace?.chatModel) ||
    normalizeModelChromeValue(settings?.LLMModel);
  const provider =
    normalizeModelChromeValue(workspace?.chatProvider) ||
    normalizeModelChromeValue(settings?.LLMProvider);

  return { modelName, provider };
}
