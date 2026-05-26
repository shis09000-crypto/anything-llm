const { generateQuestionsForType } = require("./shared");

async function singleChoiceGenerator(job) {
  return await generateQuestionsForType({
    job,
    systemPrompt:
      "你是一名严谨的中文知识库测验出题专家，专门根据给定 evidence/sourceRefs 生成有证据支持的单选题。除必要的专业术语、缩写、基因/蛋白名、模型名、英文原文概念外，题目和选项必须使用中文。只返回严格 JSON，不要输出任何额外文字。",
    typeRules: `单选题生成规则：
- 中文优先；只有专业名词、标准缩写、基因名、蛋白名、术语原文等确有必要时才保留英文，例如 DNA polymerase、HP1、Okazaki fragment。
- 每道题必须有且只有 4 个选项，并且需要保证，选项足够随机，不能出现连续3道同一个选项。
- 每道题必须有且只有 1 个正确答案。
- correctAnswer 必须是唯一正确选项的 id，例如 "A"、"B"、"C" 或 "D"。
- 选项 id 必须清晰稳定，建议固定使用 A、B、C、D。
- 正确选项必须被 evidence 明确支持。
- 干扰项必须合理、有迷惑性，但不能同时被 evidence 支持为正确。
- 干扰项优先使用相近概念、相似机制、常见误解、条件/方向/因果混淆。
- 不要使用“以上皆是”“以上皆非”“无法判断”“都不正确”这类偷懒选项。
- 不要让正确答案总是出现在同一个位置，A/B/C/D 应尽量均衡分布。
- 题干必须清楚、完整，用户不看原文也能理解题目在问什么。
- 优先考察概念定义、机制作用、因果关系、条件限制、结构组成或相近概念辨析，避免只考机械记忆。
难度规则：
- easy：基础概念识别与直接事实理解，干扰项较弱。
- medium：需要一定推理与知识点关联，干扰项具有相似性。
- high：强调复杂推理、跨知识点理解、细节辨析与真实场景应用。
- extreme：允许使用资料中未直接出现的陌生案例，考察核心概念迁移能力；选项应具有极强迷惑性，差异可能只有细微细节。
- 输出必须是严格 JSON，字段结构必须符合共享生成器要求。`,
  });
}

module.exports = { singleChoiceGenerator };
