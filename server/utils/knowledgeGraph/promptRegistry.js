const { EXTRACTION_PROMPT_VERSION } = require("./constants");

const DOMAIN_KEYWORDS = {
  code: [
    "function",
    "class",
    "module",
    "api",
    "endpoint",
    "import ",
    "const ",
    "schema",
  ],
  finance: [
    "revenue",
    "ebitda",
    "cash flow",
    "margin",
    "stock",
    "valuation",
    "earnings",
  ],
  biology: [
    "dna",
    "rna",
    "protein",
    "enzyme",
    "chromatin",
    "histone",
    "cell",
    "gene",
  ],
  ai: [
    "llm",
    "embedding",
    "retrieval",
    "rag",
    "model",
    "agent",
    "prompt",
    "token",
  ],
};

const DOMAIN_GUIDANCE = {
  default:
    "Extract important concepts, entities, processes, dependencies, comparisons, and causal links.",
  code: "Extract modules, functions, classes, APIs, data types, dependencies, ownership, and implementation relationships.",
  finance:
    "Extract companies, metrics, events, risks, drivers, financial relationships, and causal business links.",
  biology:
    "Extract biological entities, proteins, processes, regulation, location, causality, and molecular interactions.",
  ai: "Extract models, components, pipelines, evaluation concepts, retrieval concepts, reasoning steps, and dependencies.",
};

function detectPromptDomain({ text = "", metadata = {}, filePath = "" } = {}) {
  const haystack = [
    filePath,
    metadata?.title,
    metadata?.docSource,
    metadata?.chunkSource,
    String(text).slice(0, 2_000),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  let best = "default";
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.reduce(
      (count, keyword) => count + (haystack.includes(keyword) ? 1 : 0),
      0
    );
    if (score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }
  return best;
}

function buildExtractionPrompt({ text, domain = "default" }) {
  const guidance = DOMAIN_GUIDANCE[domain] || DOMAIN_GUIDANCE.default;
  return `Extract a lightweight knowledge graph from this chunk.

Domain guidance: ${guidance}

Return ONLY valid JSON with this exact shape:
{
  "entities": [
    {
      "name": "short canonical name",
      "type": "concept | person | organization | protein | process | metric | module | function | model",
      "summary": "one sentence",
      "aliases": ["optional alternate names"]
    }
  ],
  "relations": [
    {
      "source": "entity name exactly as listed above",
      "target": "entity name exactly as listed above",
      "relation": "related_to | part_of | causes | depends_on | used_in | acts_at | regulates | contrasts_with | precedes | implements | references",
      "confidence": 0.0,
      "snippet": "short evidence phrase copied or paraphrased from the chunk"
    }
  ]
}

Rules:
- Keep only important, reusable concepts.
- Prefer precise relation types from the allowed list.
- Use "related_to" only when no more specific relation fits.
- Do not include markdown, comments, or text outside JSON.

Chunk:
${text}`;
}

module.exports = {
  EXTRACTION_PROMPT_VERSION,
  detectPromptDomain,
  buildExtractionPrompt,
};
