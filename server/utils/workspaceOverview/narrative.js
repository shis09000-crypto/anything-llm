const crypto = require("crypto");
const { getLLMProvider } = require("../helpers");
const {
  WorkspaceOverviewNarrative,
} = require("../../models/workspaceOverviewNarrative");

const activeGenerations = new Set();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourcePayload({ workspaceSupplements = [], bookStructure = null }) {
  const structureSupplements = workspaceSupplements
    .filter((item) => item.supplementKind === "structure_json")
    .map((item) => ({
      id: item.id,
      documentId: item.documentId,
      documentName: item.documentName,
      updatedAt: item.updatedAt,
      parsedStructure: item.metadata?.parsedStructure || null,
      structureJsonValidation: item.metadata?.structureJsonValidation || null,
    }));
  if (structureSupplements.length === 0)
    return { hasStructureSource: false, hash: "", payload: null };
  const payload = {
    structureSupplements,
    bookStructure: bookStructure
      ? {
          structureType: bookStructure.structureType,
          primaryAxis: bookStructure.primaryAxis,
          secondaryAxes: bookStructure.secondaryAxes || [],
          updatedAt: bookStructure.updatedAt,
          structureVersion: bookStructure.structureVersion,
        }
      : null,
  };
  return {
    hasStructureSource: true,
    hash: crypto.createHash("sha256").update(stableJson(payload)).digest("hex"),
    payload,
  };
}

function parseTagline(text = "") {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.tagline || "").trim().slice(0, 120);
  } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return String(parsed.tagline || "").trim().slice(0, 120);
    } catch {}
  }
  return raw.replace(/^["“”]+|["“”]+$/g, "").trim().slice(0, 120);
}

function scheduleGeneration({ workspace, sourceHash, payload }) {
  const workspaceId = Number(workspace?.id || workspace);
  if (!workspaceId || !sourceHash || !payload) return;
  const key = `${workspaceId}:${sourceHash}`;
  if (activeGenerations.has(key)) return;
  activeGenerations.add(key);

  setTimeout(async () => {
    try {
      const LLMConnector = getLLMProvider({
        provider: workspace?.chatProvider,
        model: workspace?.chatModel,
      });
      if (!LLMConnector) throw new Error("llm_provider_unavailable");
      const prompt = `请根据工作区结构信息生成一句中文总览。

要求：
- 只输出严格 JSON。
- 字段为 tagline。
- tagline 需要是 40 到 70 个中文字符左右。
- 不要说“本书/本文档介绍了”这种泛泛表述，要概括主线。
- 不要输出 Markdown，不要解释。

输入：
${JSON.stringify(payload, null, 2)}

输出示例：
{"tagline":"从古希腊理性开端到现代性批判，追踪主体、知识、自由与社会秩序的思想演进。"}`;
      const messages = await LLMConnector.compressMessages(
        {
          systemPrompt:
            "你为知识工作区生成极简中文总览。只输出严格 JSON。",
          userPrompt: prompt,
          contextTexts: [],
          chatHistory: [],
          attachments: [],
        },
        []
      );
      const { textResponse, metrics } = await LLMConnector.getChatCompletion(
        messages,
        { temperature: 0.2, responseFormat: { type: "json_object" } }
      );
      const tagline = parseTagline(textResponse);
      if (!tagline) throw new Error("empty_tagline");
      await WorkspaceOverviewNarrative.upsert({
        workspaceId,
        tagline,
        sourceHash,
        model: metrics?.model || workspace?.chatModel || null,
        status: "ready",
        errorType: null,
        metadata: { source: "llm", tokenMetrics: metrics || null },
        markGenerated: true,
      });
    } catch (error) {
      console.warn("[WorkspaceOverviewNarrative] generation failed", {
        workspaceId,
        error: error.message,
      });
      await WorkspaceOverviewNarrative.upsert({
        workspaceId,
        tagline: "",
        sourceHash,
        model: workspace?.chatModel || null,
        status: "failed",
        errorType: error.message || "generation_failed",
        metadata: { source: "llm" },
        markGenerated: false,
      });
    } finally {
      activeGenerations.delete(key);
    }
  }, 0);
}

async function getOrScheduleWorkspaceOverviewNarrative({
  workspace,
  workspaceSupplements = [],
  bookStructure = null,
}) {
  const workspaceId = Number(workspace?.id || workspace);
  const source = sourcePayload({ workspaceSupplements, bookStructure });
  if (!source.hasStructureSource) {
    return await WorkspaceOverviewNarrative.upsert({
      workspaceId,
      tagline: "",
      sourceHash: "",
      status: "empty",
      errorType: null,
      metadata: { reason: "no_structure_json" },
      markGenerated: false,
    });
  }

  const existing = await WorkspaceOverviewNarrative.get(workspaceId);
  if (
    existing?.sourceHash === source.hash &&
    ["ready", "pending", "failed"].includes(existing.status)
  ) {
    return existing;
  }

  const pending = await WorkspaceOverviewNarrative.upsert({
    workspaceId,
    tagline: "",
    sourceHash: source.hash,
    status: "pending",
    errorType: null,
    metadata: { reason: "source_hash_changed" },
    markGenerated: false,
  });
  scheduleGeneration({ workspace, sourceHash: source.hash, payload: source.payload });
  return pending;
}

function triggerWorkspaceOverviewNarrativeRefresh({
  workspace,
  workspaceSupplements = [],
  bookStructure = null,
}) {
  getOrScheduleWorkspaceOverviewNarrative({
    workspace,
    workspaceSupplements,
    bookStructure,
  }).catch((error) =>
    console.warn("[WorkspaceOverviewNarrative] refresh skipped", error.message)
  );
}

module.exports = {
  getOrScheduleWorkspaceOverviewNarrative,
  triggerWorkspaceOverviewNarrativeRefresh,
  sourcePayload,
};
