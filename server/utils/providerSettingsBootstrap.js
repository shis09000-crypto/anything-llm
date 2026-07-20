const SETTINGS_BOOTSTRAP_MATCHERS = Object.freeze({
  llm: [
    "llm",
    "openai",
    "azureopenai",
    "anthropic",
    "geminillm",
    "geminisafety",
    "lmstudio",
    "localai",
    "ollamallm",
    "novitallm",
    "togetherai",
    "fireworksai",
    "perplexity",
    "openrouter",
    "mistral",
    "groq",
    "huggingfacellm",
    "koboldcpp",
    "textgenwebui",
    "litellm",
    "moonshotai",
    "genericopenai",
    "foundry",
    "awsbedrockllm",
    "cohere",
    "deepseek",
    "apipie",
    "xai",
    "nvidianim",
    "ppio",
    "dellproaistudio",
    "cometapi",
    "zai",
    "giteeai",
    "dockermodelrunner",
    "privatemode",
    "sambanova",
    "lemonade",
  ],
  vector: [
    "vectordb",
    "pinecone",
    "chrom",
    "weaviate",
    "qdrant",
    "milvus",
    "zilliz",
    "astradb",
    "pgvector",
    "hasexistingembeddings",
  ],
  embedding: [
    "embedding",
    "documentembeddingmode",
    "hasexistingembeddings",
    "hascachedembeddings",
    "openai",
    "azureopenai",
    "geminiembedding",
    "localai",
    "ollamaembedding",
    "lmstudio",
    "cohere",
    "voyageai",
    "litellm",
    "genericopenaiembedding",
    "openrouter",
    "mistral",
    "lemonade",
  ],
  rerank: ["rerank"],
  search: ["searchmodel"],
  ocr: ["readerocr"],
  vision: ["vision"],
  audio: ["speechtotext", "texttospeech", "tts", "stt"],
  transcription: ["whisper", "openai"],
});

function filterSettingsBySections(settings = {}, sections = []) {
  const normalized = sections.map((section) => String(section).toLowerCase());
  if (
    normalized.length === 0 ||
    normalized.includes("system") ||
    normalized.includes("all")
  ) {
    return settings;
  }

  const activeMatchers = normalized.flatMap(
    (section) => SETTINGS_BOOTSTRAP_MATCHERS[section] || []
  );
  return Object.fromEntries(
    Object.entries(settings || {}).filter(([key]) => {
      const lowerKey = key.toLowerCase();
      return (
        lowerKey === "lastupdatedat" ||
        activeMatchers.some((matcher) => lowerKey.startsWith(matcher))
      );
    })
  );
}

module.exports = { SETTINGS_BOOTSTRAP_MATCHERS, filterSettingsBySections };
