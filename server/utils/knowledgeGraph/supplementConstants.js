const WORKSPACE_SUPPLEMENT_SCOPE_TYPES = ["workspace", "book"];
const WORKSPACE_SUPPLEMENT_KINDS = [
  "structure_json",
  "reading_guide",
  "timeline",
  "person_map",
  "concept_index",
  "chapter_overview",
  "summary_standard",
  "other",
];

const SUPPLEMENT_KIND_WEIGHTS = Object.freeze({
  structure_json: 100,
  reading_guide: 82,
  chapter_overview: 78,
  timeline: 68,
  person_map: 66,
  concept_index: 66,
  summary_standard: 62,
  other: 15,
});

const WORKSPACE_SUPPLEMENT_KIND_LABELS = Object.freeze({
  structure_json: "结构说明",
  reading_guide: "阅读导引",
  chapter_overview: "章节总览",
  timeline: "时间线",
  person_map: "人物关系",
  concept_index: "概念索引",
  summary_standard: "总结标准",
  other: "其他补充",
});

const STRUCTURE_JSON_REQUIRED_FIELDS = [
  "资料类型",
  "主文档",
  "主题范围",
  "不讨论范围",
  "组织方式",
  "主轴",
  "次轴",
  "关键人物",
  "关键概念",
  "关键问题",
  "关键章节",
  "关键方法或论证",
  "节点解析标准",
  "推荐偏好",
  "禁止误判",
  "语言偏好",
];

function normalizeSupplementKind(kind = "other") {
  return WORKSPACE_SUPPLEMENT_KINDS.includes(kind) ? kind : "other";
}

function supplementKindWeight(kind = "other") {
  return SUPPLEMENT_KIND_WEIGHTS[normalizeSupplementKind(kind)] || 0;
}

function normalizeScopeType(scopeType = "workspace") {
  return WORKSPACE_SUPPLEMENT_SCOPE_TYPES.includes(scopeType)
    ? scopeType
    : "workspace";
}

function isHighStructureSupplement(kind = "other") {
  return supplementKindWeight(kind) >= SUPPLEMENT_KIND_WEIGHTS.chapter_overview;
}

function workspaceSupplementKindLabel(kind = "reading_guide") {
  return (
    WORKSPACE_SUPPLEMENT_KIND_LABELS[normalizeSupplementKind(kind)] ||
    WORKSPACE_SUPPLEMENT_KIND_LABELS.reading_guide
  );
}

function promptHeader(label, purpose) {
  return `请你基于我提供的整本书或资料集内容，生成一份“${label}”补充资料。

用途：${purpose}

要求：
1. 必须使用中文。
2. 不确定的内容写 null 或空数组，不要猜测。
3. 禁止编造不存在的人物、章节、概念、事件、方法、论证或结构。
4. 如果资料不是书，不要强行按章节、人物或时间线组织。`;
}

const WORKSPACE_SUPPLEMENT_PROMPTS = Object.freeze({
  reading_guide: `${promptHeader(
    "阅读导引",
    "帮助系统理解整本书或资料集的阅读方式、主题边界和推荐学习顺序。"
  )}

请输出 Markdown，包含以下部分：
- 资料类型和主文档
- 如何理解这本书或资料集
- 主题范围和不讨论范围
- 推荐阅读顺序
- 阅读时最应该关注的问题
- 推荐偏好
- 禁止误判项`,

  structure_json: `${promptHeader(
    "结构说明",
    "用于工作区知识画像、书籍结构分析、主轴次轴判断和节点解析标准。"
  )}
5. 必须先输出人类可读的 Markdown 说明，再输出一个完整 JSON 代码块。
6. JSON 代码块必须可被 JSON.parse 解析，不要写注释，不要使用尾随逗号。
7. JSON 字段必须使用中文字段名，不要输出英文内部键名。

Markdown 说明需要包含：
- 如何理解这本书或资料集
- 主题范围和不讨论范围
- 组织方式、主轴和次轴
- 关键人物、关键概念、关键问题、关键章节、关键方法或论证
- 节点解析标准：不同类型节点应该如何总结和讲解
- 推荐偏好和禁止误判项

最后输出这个 JSON 代码块，字段必须完整：
\`\`\`json
{
  "资料类型": null,
  "主文档": null,
  "主题范围": null,
  "不讨论范围": null,
  "组织方式": null,
  "主轴": null,
  "次轴": [],
  "关键人物": [],
  "关键概念": [],
  "关键问题": [],
  "关键章节": [],
  "关键方法或论证": [],
  "节点解析标准": {
    "人物": [],
    "概念": [],
    "问题": [],
    "章节": [],
    "论证": [],
    "方法": [],
    "事件": []
  },
  "推荐偏好": [],
  "禁止误判": [],
  "语言偏好": null
}
\`\`\`

请根据资料真实内容填写。`,

  chapter_overview: `${promptHeader(
    "章节总览",
    "帮助系统理解章节作用、章节之间的关系、每章关键节点和学习重点。"
  )}

请输出 Markdown，按章节列出：
- 章节名称
- 本章作用
- 本章与前后章节的关系
- 关键人物、概念、问题、方法或论证
- 本章学习重点
- 容易误解的地方
- 推荐复习或测验方向`,

  timeline: `${promptHeader(
    "时间线",
    "帮助系统按时间顺序理解事件、人物、概念发展和因果关系。"
  )}

请输出 Markdown，按时间顺序列出：
- 时间或时期
- 关键事件
- 相关人物
- 相关概念
- 因果关系
- 对后续章节或思想发展的影响
- 不确定或有争议的时间点`,

  person_map: `${promptHeader(
    "人物关系",
    "帮助系统理解人物列表、人物关系、影响链、对比关系和核心观点。"
  )}

请输出 Markdown，包含：
- 关键人物列表
- 每个人物的核心观点
- 人物之间的影响关系
- 人物之间的批评、继承或对比关系
- 相关学派或时代
- 推荐对比阅读的人物组合
- 禁止误判的人物关系`,

  concept_index: `${promptHeader(
    "概念索引",
    "帮助系统理解概念表、定义、来源、关联概念、对比概念和易错点。"
  )}

请输出 Markdown，按概念列出：
- 概念名称
- 简明定义
- 来源章节或来源人物
- 关联概念
- 对比概念
- 常见误解或易错点
- 推荐讲解顺序
- 适合生成测验的问题`,

  summary_standard: `${promptHeader(
    "总结标准",
    "规定以后总结这本书或资料集时应遵守的标准、结构和禁止误判项。"
  )}

请输出 Markdown，包含：
- 总结时必须覆盖的维度
- 节点总结的固定结构
- 人物、概念、问题、章节、论证、方法分别如何总结
- 引用证据和原文时的要求
- 禁止误判项
- 不确定内容的表达方式
- 推荐输出长度和层级`,

  other: `${promptHeader(
    "其他补充",
    "作为低权重辅助资料使用，不参与强结构判断。"
  )}

请输出 Markdown，说明：
- 这份补充资料想补充什么
- 它适合帮助哪些理解场景
- 哪些内容是确定的
- 哪些内容只是个人整理或待确认
- 它不应该被系统用于哪些强判断`,
});

const WORKSPACE_SUPPLEMENT_PROMPT_TEMPLATE =
  WORKSPACE_SUPPLEMENT_PROMPTS.reading_guide;

function workspaceSupplementPromptForKind(kind = "reading_guide") {
  const normalized = normalizeSupplementKind(kind);
  return {
    supplementKind: normalized,
    label: workspaceSupplementKindLabel(normalized),
    prompt:
      WORKSPACE_SUPPLEMENT_PROMPTS[normalized] ||
      WORKSPACE_SUPPLEMENT_PROMPTS.reading_guide,
  };
}

module.exports = {
  WORKSPACE_SUPPLEMENT_SCOPE_TYPES,
  WORKSPACE_SUPPLEMENT_KINDS,
  WORKSPACE_SUPPLEMENT_KIND_LABELS,
  SUPPLEMENT_KIND_WEIGHTS,
  STRUCTURE_JSON_REQUIRED_FIELDS,
  WORKSPACE_SUPPLEMENT_PROMPT_TEMPLATE,
  workspaceSupplementKindLabel,
  workspaceSupplementPromptForKind,
  normalizeScopeType,
  normalizeSupplementKind,
  supplementKindWeight,
  isHighStructureSupplement,
};
