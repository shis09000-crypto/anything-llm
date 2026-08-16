function normalizeModelChromeValue(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function resolveModelChromeState({
  thread = {},
  workspace = {},
  settings = {},
} = {}) {
  const modelName =
    normalizeModelChromeValue(thread?.chatModel) ||
    normalizeModelChromeValue(workspace?.chatModel) ||
    normalizeModelChromeValue(settings?.LLMModel);
  const provider =
    normalizeModelChromeValue(workspace?.chatProvider) ||
    normalizeModelChromeValue(settings?.LLMProvider);

  return { modelName, provider };
}
