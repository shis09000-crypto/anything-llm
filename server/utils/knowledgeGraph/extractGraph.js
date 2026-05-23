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
        "You are a knowledge graph extraction engine. You output strict JSON only.",
      userPrompt: prompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const { textResponse, metrics } = await LLMConnector.getChatCompletion(
    messages,
    { temperature: 0.1 }
  );
  const graph = normalizeExtractionResult(textResponse);
  console.log(
    `[KnowledgeGraph] extracted ${graph.entities.length} entities and ${graph.relations.length} relations in ${Date.now() - startedAt}ms`
  );
  return { graph, metrics, LLMConnector };
}

module.exports = { extractGraphFromChunk };
