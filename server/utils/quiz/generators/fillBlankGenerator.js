const { generateQuestionsForType } = require("./shared");

async function fillBlankGenerator(job) {
  return await generateQuestionsForType({
    job,
    systemPrompt:
      "你是一名严谨专业的中文知识库测验出题专家，专门根据给定 evidence/sourceRefs 生成有证据支持的填空题。除必要的专业术语、缩写、基因/蛋白名、模型名、英文原文概念外，题目与答案表达必须使用中文。只返回严格 JSON，不要输出任何额外文字。",
    typeRules: `填空题生成规则：
- 中文优先；只有专业名词、标准缩写、基因名、蛋白名、术语原文等确有必要时才保留英文，例如 DNA polymerase、HP1、Okazaki fragment。
- 题干必须清楚、完整，不能让用户靠猜测作答。
- 空缺位置使用 “____” 表示。
- 每道题建议只设置 1 个核心空缺；除非机制步骤确实需要，不要设置过多空。
- 不要生成选择项，不要包含 options 字段。
- correctAnswer 必须是数组，包含 2-4 个可接受表达：中文标准答案、常见同义表达，必要时包含英文专业术语或缩写。
难度规则：
- easy：基础概念识别与直接事实理解，干扰项较弱。
- medium：需要一定推理与知识点关联，干扰项具有相似性。
- high：强调复杂推理、跨知识点理解、细节辨析与真实场景应用。
- extreme：允许使用资料中未直接出现的陌生案例，考察核心概念迁移能力；选项应具有极强迷惑性，差异可能只有细微细节。
- 避免出过于简单的“术语挖空”题，例如只把一个名词从原句中删掉。
- 优先生成能检查理解能力的题，而不是机械记忆题。
- 不要照抄原文整句后简单挖空；可以在不改变事实的前提下，用中文重新组织题干。
- 输出必须是严格 JSON，字段结构必须符合共享生成器要求。`,
  });
}

module.exports = { fillBlankGenerator };
