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
  default: "提取重要概念、实体、过程、依赖、比较关系与因果关系。",
  code: "提取模块、函数、类、API、数据类型、依赖、归属关系与实现关系。",
  finance: "提取公司、指标、事件、风险、驱动因素、财务关系与业务因果关系。",
  biology: "提取生物实体、蛋白质、过程、调控、位置、因果关系与分子互作。",
  ai: "提取模型、组件、流程、评估概念、检索概念、推理步骤与依赖关系。",
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
  return `请从下面的文档片段中抽取轻量知识图谱。

领域提示：${guidance}

只返回合法 JSON，结构必须如下：
{
  "entities": [
    {
      "name": "简短规范中文概念名；专有名词可保留原文并在 aliases 放中文译名",
      "type": "concept | person | organization | protein | process | metric | module | function | model",
      "summary": "一句中文解释，不超过 60 个汉字",
      "aliases": ["中文别名或常见英文原名，必须是字符串"]
    }
  ],
  "relations": [
    {
      "source": "必须与上方实体 name 完全一致",
      "target": "必须与上方实体 name 完全一致",
      "relation": "influences | influenced_by | criticizes | develops | introduces_concept | belongs_to_school | answers_question | contrasts_with | prerequisite_of | often_confused_with | supports_claim | refutes_claim | related_to | part_of | depends_on | leads_to | open_question_for | evidence_for | causes | used_in | acts_at | regulates | precedes | implements | references",
      "confidence": 0.0,
      "snippet": "中文证据短语，可从片段摘录或紧贴片段改写"
    }
  ]
}

规则：
- 输出语言必须以简体中文为主；除人名、术语、书名等必要原文外，不要输出英文解释。
- name、summary、snippet 必须优先中文；如果原文是英文，也要翻译成自然中文。
- aliases 必须是字符串数组，不要输出对象。
- 只保留重要、可复用的概念。
- 优先使用允许列表中更精确的关系类型；只有没有更具体关系时才用 "related_to"。
- 不要输出 markdown、注释或 JSON 之外的任何文本。

文档片段：
${text}`;
}

module.exports = {
  EXTRACTION_PROMPT_VERSION,
  detectPromptDomain,
  buildExtractionPrompt,
};
