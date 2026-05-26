const { DeepSeekLLM } = require("../AiProviders/deepseek");
const { clipChunkText, normalizeExtractionResult } = require("./schema");
const { buildExtractionPrompt } = require("./promptRegistry");
const { DEFAULT_EXTRACTION_MODEL } = require("./constants");

async function extractGraphFromChunk({ chunkText, domain = "default" }) {
  const startedAt = Date.now();
  const model =
    process.env.KNOWLEDGE_GRAPH_DEEPSEEK_MODEL || DEFAULT_EXTRACTION_MODEL;
  const LLMConnector = new DeepSeekLLM(null, model);
  const prompt = buildExtractionPrompt({
    text: clipChunkText(chunkText),
    domain,
  });
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt:
        "你是知识图谱抽取引擎。只输出严格 JSON。实体名称、摘要和证据短语必须优先使用简体中文，除必要专有名词外不要输出英文解释。",
      userPrompt: prompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const { textResponse, metrics } = await LLMConnector.getChatCompletion(
    messages,
    { temperature: 0.1, responseFormat: { type: "json_object" } }
  );
  const graph = normalizeExtractionResult(textResponse);
  console.log(
    `[KnowledgeGraph] extracted ${graph.entities.length} entities and ${graph.relations.length} relations in ${Date.now() - startedAt}ms`
  );
  return { graph, metrics, LLMConnector };
}

module.exports = { extractGraphFromChunk };
