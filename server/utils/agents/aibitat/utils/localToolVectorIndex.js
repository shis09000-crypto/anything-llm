const crypto = require("crypto");

const DEFAULT_TOOL_LIMIT = 15;
const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_TIMEOUT_MS = 300;
const VECTOR_DIMENSIONS = 2048;

const QUERY_ALIASES = new Map([
  ["搜索", "search web browser"],
  ["网页", "web browser page"],
  ["浏览器", "browser web"],
  ["文件", "file document"],
  ["文档", "document file"],
  ["邮件", "email mail gmail outlook"],
  ["日历", "calendar schedule event"],
  ["会议", "meeting calendar"],
  ["天气", "weather search web"],
  ["加密", "crypto market"],
  ["币价", "crypto price market"],
  ["图片", "image vision"],
  ["生成", "create generate"],
  ["读取", "read fetch get"],
  ["写入", "write create update"],
  ["下载", "download file"],
  ["上传", "upload file"],
]);

function numberSetting(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toolDocument(tool = {}) {
  const properties = tool.parameters?.properties || {};
  return [
    tool.name,
    tool.description,
    ...Object.entries(properties).flatMap(([name, definition]) => [
      name,
      definition?.description,
    ]),
    ...(Array.isArray(tool.examples)
      ? tool.examples.map((example) => example?.prompt)
      : []),
  ]
    .filter(Boolean)
    .join(" ");
}

function expandedText(value) {
  const source = String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const aliases = [];
  for (const [term, expansion] of QUERY_ALIASES)
    if (source.includes(term)) aliases.push(expansion);
  return `${source} ${aliases.join(" ")}`.trim();
}

function features(value) {
  const text = expandedText(value);
  const result = [];
  const words = text.match(/[a-z0-9]+|[\u3400-\u9fff]/g) || [];
  result.push(...words.map((word) => `w:${word}`));
  const compactLatin = text.replace(/[^a-z0-9]+/g, " ").trim();
  for (const word of compactLatin.split(/\s+/).filter(Boolean)) {
    if (word.length < 3) continue;
    for (let index = 0; index <= word.length - 3; index += 1)
      result.push(`g:${word.slice(index, index + 3)}`);
  }
  const cjk = text.match(/[\u3400-\u9fff]/g) || [];
  for (let index = 0; index < cjk.length - 1; index += 1)
    result.push(`c:${cjk[index]}${cjk[index + 1]}`);
  return result;
}

function hashFeature(value) {
  const digest = crypto.createHash("sha1").update(value).digest();
  return digest.readUInt16BE(0) % VECTOR_DIMENSIONS;
}

function vectorize(value) {
  const vector = new Map();
  for (const feature of features(value)) {
    const index = hashFeature(feature);
    vector.set(index, (vector.get(index) || 0) + 1);
  }
  const magnitude = Math.sqrt(
    [...vector.values()].reduce((sum, weight) => sum + weight * weight, 0)
  );
  if (!magnitude) return vector;
  for (const [index, weight] of vector) vector.set(index, weight / magnitude);
  return vector;
}

function cosine(left, right) {
  const [smallest, largest] =
    left.size <= right.size ? [left, right] : [right, left];
  let score = 0;
  for (const [index, weight] of smallest)
    score += weight * (largest.get(index) || 0);
  return score;
}

function registryFingerprint(tools = []) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(tools.map((tool) => toolDocument(tool))))
    .digest("hex");
}

function forcedToolNames(query, tools, context = {}) {
  const normalizedQuery = String(query || "").toLowerCase();
  const forced = new Set();
  const explicitWorkspaceRetrievalIntent =
    /(?:工作区|本地|知识库|向量|资料|文档).*(?:搜索|查找|检索|查询|找|搜)|(?:搜索|查找|检索|查询|找|搜).*(?:工作区|本地|知识库|向量|资料|文档)|(?:workspace|local|knowledge\s*base|vector|document|file).*(?:search|find|retrieve|query)|(?:search|find|retrieve|query).*(?:workspace|local|knowledge\s*base|vector|document|file)/i.test(
      normalizedQuery
    );
  for (const tool of tools) {
    const name = String(tool?.name || "").toLowerCase();
    if (explicitWorkspaceRetrievalIntent && name === "rag-memory")
      forced.add(tool.name);
    if (name && normalizedQuery.includes(name)) forced.add(tool.name);
  }
  const messages = Array.isArray(context.messages) ? context.messages : [];
  for (const message of messages.slice(-4))
    for (const call of message?.tool_calls || [])
      if (call?.function?.name) forced.add(call.function.name);
  const hasAttachments =
    Boolean(context.hasAttachments) ||
    messages.some((message) => message?.attachments?.length);
  const hasUrl = /https?:\/\//i.test(normalizedQuery);
  for (const tool of tools) {
    const name = String(tool?.name || "").toLowerCase();
    if (
      hasAttachments &&
      /(file|document|attachment|image|vision|upload|workspace)/.test(name)
    )
      forced.add(tool.name);
    if (hasUrl && /(browser|web|url|http|scrape|search)/.test(name))
      forced.add(tool.name);
  }
  return forced;
}

function simpleAgentRequest(query, { selectedTools = [], context = {} } = {}) {
  const prompt = String(query || "").trim();
  if (!prompt || prompt.length > 160 || selectedTools.length) return false;
  if (/@agent\b/i.test(prompt) || /https?:\/\//i.test(prompt)) return false;
  if (context.hasAttachments) return false;
  return !/(首先|然后|最后|步骤|计划|分析|比较|调查|执行|创建|修改|下载|上传|搜索|查找|调用|审批|多步|workflow|step|plan|analy[sz]e|compare|create|update|search|find|call|tool)/i.test(
    prompt
  );
}

function agentReasoningEffort(query, options = {}) {
  // DeepSeek documents `none` as the supported way to disable thinking.
  // Once Athena has classified a turn as simple and tool-free, another hidden
  // reasoning pass only delays the first visible token.
  return simpleAgentRequest(query, options) ? "none" : "high";
}

class LocalToolVectorIndex {
  static instance = null;

  constructor({ env = process.env } = {}) {
    if (LocalToolVectorIndex.instance) return LocalToolVectorIndex.instance;
    this.env = env;
    this.fingerprint = null;
    this.entries = [];
    LocalToolVectorIndex.instance = this;
  }

  prewarm(tools = []) {
    const fingerprint = registryFingerprint(tools);
    if (fingerprint === this.fingerprint) return false;
    this.entries = tools.map((tool) => ({
      tool,
      vector: vectorize(toolDocument(tool)),
    }));
    this.fingerprint = fingerprint;
    return true;
  }

  select(query, tools = [], context = {}) {
    const startedAt = Date.now();
    const timeoutMs = numberSetting(
      this.env.ATHENA_AGENT_TOOL_SELECTOR_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    );
    try {
      this.prewarm(tools);
      const queryVector = vectorize(query);
      const minScore = numberSetting(
        this.env.ATHENA_AGENT_TOOL_MIN_SCORE,
        DEFAULT_MIN_SCORE
      );
      const limit = Math.floor(
        numberSetting(this.env.ATHENA_AGENT_TOOL_LIMIT, DEFAULT_TOOL_LIMIT)
      );
      const forced = forcedToolNames(query, tools, context);
      const ranked = this.entries
        .map(({ tool, vector }) => ({
          tool,
          score: cosine(queryVector, vector),
        }))
        .filter(({ tool, score }) => forced.has(tool.name) || score >= minScore)
        .sort((left, right) => {
          const forcedDifference =
            Number(forced.has(right.tool.name)) -
            Number(forced.has(left.tool.name));
          return forcedDifference || right.score - left.score;
        });
      const forcedCount = ranked.filter(({ tool }) =>
        forced.has(tool.name)
      ).length;
      const selected = ranked
        .slice(0, Math.max(limit, forcedCount))
        .map(({ tool }) => tool);
      const durationMs = Date.now() - startedAt;
      if (durationMs > timeoutMs)
        return {
          tools,
          durationMs,
          degradedReason: "tool_selector_timeout",
          selectedCount: tools.length,
        };
      return {
        tools: selected,
        durationMs,
        degradedReason: null,
        selectedCount: selected.length,
      };
    } catch (error) {
      return {
        tools,
        durationMs: Date.now() - startedAt,
        degradedReason: "tool_selector_unavailable",
        selectedCount: tools.length,
        error,
      };
    }
  }
}

module.exports = {
  DEFAULT_MIN_SCORE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOL_LIMIT,
  LocalToolVectorIndex,
  agentReasoningEffort,
  cosine,
  forcedToolNames,
  simpleAgentRequest,
  toolDocument,
  vectorize,
};
