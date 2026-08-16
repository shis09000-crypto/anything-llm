const { QUIZ_ANALYSIS_MODEL } = require("./constants");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { safeJsonParse } = require("../http");
const { quizLLM, quizRuntimeContext, stripThinkBlocks } = require("./llm");

const ANALYSIS_OPEN_TAG = "<analysis_markdown>";
const ANALYSIS_CLOSE_TAG = "</analysis_markdown>";
const STRUCTURED_OPEN_TAG = "<structured_results>";
const STRUCTURED_CLOSE_TAG = "</structured_results>";
const QUIZ_STRUCTURED_RESULTS_MISSING = "QUIZ_STRUCTURED_RESULTS_MISSING";
const QUIZ_STRUCTURED_RESULTS_INVALID_JSON =
  "QUIZ_STRUCTURED_RESULTS_INVALID_JSON";
const QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH =
  "QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH";
const QUIZ_STRUCTURED_RESULTS_MISSING_IS_CORRECT =
  "QUIZ_STRUCTURED_RESULTS_MISSING_IS_CORRECT";
const QUIZ_STRUCTURED_RESULTS_INVALID_SOURCE_REFS =
  "QUIZ_STRUCTURED_RESULTS_INVALID_SOURCE_REFS";
const CONTROL_TAGS = [
  ANALYSIS_OPEN_TAG,
  ANALYSIS_CLOSE_TAG,
  STRUCTURED_OPEN_TAG,
  STRUCTURED_CLOSE_TAG,
];

function writeQuizAnalysisChunk(response, data) {
  writeResponseChunk(response, data);
  response.flush?.();
}

function answerLines(quiz = {}, answers = {}) {
  return (quiz.questions || [])
    .map((question, index) => {
      const userAnswer = answers[question.id];
      return JSON.stringify({
        number: index + 1,
        id: question.id,
        type: question.type,
        question: question.question,
        options: question.options || [],
        correctAnswer: question.correctAnswer,
        userAnswer,
        sourceRefs: question.sourceRefs || [],
      });
    })
    .join("\n");
}

function evidenceLines(quiz = {}) {
  return (quiz.evidenceChunks || [])
    .map((chunk) => {
      const sourceRef = chunk.sourceRef || {};
      const title =
        sourceRef.title ||
        chunk.title ||
        sourceRef.docpath ||
        chunk.docpath ||
        chunk.id;
      const chunkIndex =
        sourceRef.chunkIndex === undefined || sourceRef.chunkIndex === null
          ? null
          : Number(sourceRef.chunkIndex);
      const readableSource = [
        title,
        Number.isFinite(chunkIndex) ? `第 ${chunkIndex + 1} 段` : null,
      ]
        .filter(Boolean)
        .join("，");
      return JSON.stringify({
        id: chunk.id,
        score: chunk.score,
        sourceRef,
        readableSource,
        title,
        docpath: sourceRef.docpath || chunk.docpath || null,
        chunkIndex,
        textPreview: String(chunk.text || "").slice(0, 900),
      });
    })
    .join("\n");
}

function createTaggedAnalysisStreamParser({ onMarkdown } = {}) {
  let state = "before_analysis";
  let tagCandidate = "";
  let rawText = "";
  let markdown = "";
  let structuredText = "";

  function emit(text = "") {
    if (!text) return;
    if (state === "analysis") {
      markdown += text;
      onMarkdown?.(text);
      return;
    }
    if (state === "structured") structuredText += text;
  }

  function transition(tag) {
    if (tag === ANALYSIS_OPEN_TAG) state = "analysis";
    if (tag === ANALYSIS_CLOSE_TAG) state = "after_analysis";
    if (tag === STRUCTURED_OPEN_TAG) state = "structured";
    if (tag === STRUCTURED_CLOSE_TAG) state = "done";
  }

  function push(text = "") {
    for (const char of String(text || "")) {
      rawText += char;

      if (tagCandidate) {
        tagCandidate += char;
        if (CONTROL_TAGS.includes(tagCandidate)) {
          transition(tagCandidate);
          tagCandidate = "";
          continue;
        }
        if (CONTROL_TAGS.some((tag) => tag.startsWith(tagCandidate))) {
          continue;
        }
        emit(tagCandidate);
        tagCandidate = "";
        continue;
      }

      if (char === "<") {
        tagCandidate = char;
        continue;
      }

      emit(char);
    }
  }

  function finish() {
    if (tagCandidate) {
      emit(tagCandidate);
      tagCandidate = "";
    }
    return { rawText, markdown, structuredText };
  }

  return { push, finish };
}
function analysisPrompt({ quiz, answers = {} }) {
  return `你是一名极其严格、专业、注重证据链的中文知识测评分析模型。

你的任务是：
基于题目、用户答案、正确答案、sourceRefs 和 evidence，
完成一次“最终测试分析”。

你必须同时输出：
1. 面向用户的中文 Markdown 分析
2. 用于系统学习记录和数据库落库的结构化 JSON

====================
【输出协议】
====================

你必须严格按照以下顺序输出：

${ANALYSIS_OPEN_TAG}
这里是面向用户的中文 Markdown 分析内容
${ANALYSIS_CLOSE_TAG}

${STRUCTURED_OPEN_TAG}
{
  "questionResults": [...]
}
${STRUCTURED_CLOSE_TAG}

重要规则：
- structured_results 必须放在最后
- analysis_markdown 内绝对不能出现：
  ${ANALYSIS_OPEN_TAG}
  ${ANALYSIS_CLOSE_TAG}
  ${STRUCTURED_OPEN_TAG}
  ${STRUCTURED_CLOSE_TAG}
- structured_results 内只能包含纯 JSON
- 不允许输出额外解释
- 不允许输出代码块 markdown
- 不允许输出 \`\`\`json
- 前端只会展示 analysis_markdown 内容
- 用户永远不会看到 structured_results

====================
【分析要求】
====================

你必须：
- 对所有题型进行严格判定
- single_choice 和 multiple_choice 也必须认真分析
- fill_blank 允许“语义等价”答案
- 但必须基于 evidence 判断
- 不允许凭空宽松判分

你必须重点分析：
- 用户真正没理解的核心概念
- 用户的误区
- 用户是否只是记忆错误
- 用户是否在概念边界混淆
- 用户是否存在“似懂非懂”
- 用户是否只是被迷惑项干扰
- 用户是否缺少迁移能力
- 用户是否无法在陌生环境中应用知识

对于极难题：
- 必须重点分析用户是否真正理解底层原理
- 不要只分析“对错”
- 要分析“为什么会被骗”
- 要分析“为什么这个迷惑项容易误导”
- 要分析用户是否真的掌握核心概念

====================
【Markdown 分析要求】
====================

analysis_markdown 必须是：
- 专业
- 严谨
- 中文
- 有学习指导意义
- 不要像 AI 套话
- 不要空泛鼓励
- 不要机械模板化

必须包含：

# 本次测试总结
- 总分
- 正确率
- 难度评价
- 完成题量

# 核心薄弱点
分析用户真正薄弱的知识点

# 认知误区分析
分析用户为什么会错

# 逐题分析
每题：
- 用户答案
- 正确答案
- 错误原因
- 核心知识点
- 为什么迷惑项容易误导
- 正确思路

# 学习建议
给出真正有价值的学习建议

# 推荐复习方向
推荐用户应该优先复习的主题

# 推荐资料来源
必须使用具体文档/章节/片段 + 复习重点的方式描述，例如：
“Chapter5-DNA-Replication-Mechanisms-239-246.md，第 2 段：5′→3′ 合成方向与校对机制”。
不要向用户展示 evidence-1、evidence-2 这类内部编号；这些编号只能放在 structured_results.sourceRefs 中。

如果测试是不完整的：
必须明确说明：
- 实际生成题量
- 哪些题型生成失败
- 当前分析基于哪些题目

====================
【structured_results JSON 结构】
====================

{
  "questionResults": [
    {
      "questionId": "string",
      "isCorrect": true,
      "score": 1,
      "analysis": "中文逐题分析",
      "mistakeReason": "中文错误原因",
      "weakConcepts": ["概念"],
      "sourceRefs": ["evidence-1"]
    }
  ]
}

====================
【structured_results 规则】
====================

- 每道题必须有且只有一个结果
- 所有题都必须包含：
  questionId
  isCorrect
  score
  analysis
  mistakeReason
  weakConcepts
  sourceRefs

- isCorrect 必须明确 true 或 false
- 不允许 null
- score 必须是数字
- 正确题默认 1
- 错误题默认 0
- 除非题目明确允许部分得分，否则不要给中间分

- analysis：
  必须是针对本题的中文分析

- mistakeReason：
  必须明确说明：
  用户到底错在哪

- weakConcepts：
  必须是用户暴露出的真实薄弱概念

- sourceRefs：
  只能使用：
  1. 题目自身已有 sourceRefs
  2. evidence 中存在的 evidence id

- 绝对不允许编造 sourceRefs

====================
【测试信息】
====================

Quiz status: ${quiz.generationStatus?.status || "ready"}

Expected total: ${quiz.expectedTotalQuestions}

Actual total: ${(quiz.questions || []).length}

Failed types: ${(quiz.failedTypes || []).join(", ") || "none"}

====================
【题目与用户答案】
====================

每行一个 JSON：

${answerLines(quiz, answers)}

====================
【Evidence】
====================

每行一个 JSON：
其中 id 是系统内部 sourceRef 编号，只能用于 structured_results；
analysis_markdown 中应优先使用 readableSource、title、docpath、chunkIndex 和 textPreview 生成用户可读的资料来源说明。

${evidenceLines(quiz)}`;
}

async function streamAnalyzeQuizResults({
  response,
  quiz,
  answers = {},
  uuid,
}) {
  const LLMConnector = quizLLM(QUIZ_ANALYSIS_MODEL, "quiz_analysis");
  const userPrompt = analysisPrompt({ quiz, answers });
  const parser = createTaggedAnalysisStreamParser({
    onMarkdown: (text) =>
      writeQuizAnalysisChunk(response, {
        uuid,
        sources: [],
        type: "textResponseChunk",
        textResponse: text,
        close: false,
        error: false,
      }),
  });
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt:
        "You are a strict but helpful quiz grader. Follow the tagged output protocol exactly. Put the user-facing Chinese Markdown first and the structured JSON last.",
      userPrompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const stream = await LLMConnector.streamGetChatCompletion(messages, {
    temperature: 0.2,
    store: false,
    runtimeContext: quizRuntimeContext(),
  });
  let fullText = "";
  const usage = { completion_tokens: 0 };

  try {
    for await (const chunk of stream) {
      const message = chunk?.choices?.[0];
      const token = message?.delta?.content;
      if (token) {
        fullText += token;
        usage.completion_tokens++;
        parser.push(token);
      }

      if (
        message?.hasOwnProperty("finish_reason") &&
        message.finish_reason !== "" &&
        message.finish_reason !== null
      ) {
        const result = finalizeStreamResult({
          parser,
          fullText,
          quiz,
          answers,
        });
        writeQuizAnalysisChunk(response, {
          uuid,
          sources: quiz.sourceRefs || [],
          type: "textResponseChunk",
          textResponse: "",
          close: true,
          error: false,
        });
        stream?.endMeasurement?.(usage);
        return {
          ...result,
          metrics: {},
          model: QUIZ_ANALYSIS_MODEL,
        };
      }
    }
  } catch (error) {
    stream?.endMeasurement?.(usage);
    writeQuizAnalysisChunk(response, {
      uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: error.message,
    });
    throw error;
  }

  stream?.endMeasurement?.(usage);
  const result = finalizeStreamResult({ parser, fullText, quiz, answers });
  writeQuizAnalysisChunk(response, {
    uuid,
    sources: quiz.sourceRefs || [],
    type: "textResponseChunk",
    textResponse: "",
    close: true,
    error: false,
  });
  return {
    ...result,
    metrics: {},
    model: QUIZ_ANALYSIS_MODEL,
  };
}

async function analyzeQuizResults({ quiz, answers = {} }) {
  const LLMConnector = quizLLM(QUIZ_ANALYSIS_MODEL, "quiz_analysis");
  const parser = createTaggedAnalysisStreamParser();
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt:
        "You are a strict but helpful quiz grader. Follow the tagged output protocol exactly. Put the user-facing Chinese Markdown first and the structured JSON last.",
      userPrompt: analysisPrompt({ quiz, answers }),
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const stream = await LLMConnector.streamGetChatCompletion(messages, {
    temperature: 0.2,
    store: false,
    runtimeContext: quizRuntimeContext(),
  });
  let fullText = "";
  const usage = { completion_tokens: 0 };
  for await (const chunk of stream) {
    const message = chunk?.choices?.[0];
    const token = message?.delta?.content;
    if (token) {
      fullText += token;
      usage.completion_tokens += 1;
      parser.push(token);
    }
    if (
      Object.prototype.hasOwnProperty.call(message || {}, "finish_reason") &&
      message.finish_reason !== "" &&
      message.finish_reason !== null
    ) {
      break;
    }
  }
  stream?.endMeasurement?.(usage);
  return {
    ...finalizeStreamResult({ parser, fullText, quiz, answers }),
    metrics: stream?.metrics || {},
    model: QUIZ_ANALYSIS_MODEL,
  };
}

function finalizeStreamResult({
  parser,
  fullText = "",
  quiz = {},
  answers = {},
}) {
  const parsed = parser.finish();
  const structured = parseStructuredResults({
    structuredText: parsed.structuredText,
    quiz,
    answers,
  });
  return {
    text: stripThinkBlocks(parsed.markdown),
    rawText: fullText,
    structuredResults: structured.questionResults,
    questionResultsReliable: structured.reliable,
    questionResultsParseError: structured.error,
  };
}

function fallbackQuestionResults({ quiz = {}, answers = {} }) {
  return (quiz.questions || []).map((question) => ({
    questionId: question.id,
    questionType: question.type,
    difficulty: question.difficulty || quiz.plan?.difficulty || null,
    question: question.question,
    options: question.options || [],
    userAnswer: answers[question.id],
    correctAnswer: question.correctAnswer,
    isCorrect: null,
    score: null,
    analysis: "",
    mistakeReason: "",
    weakConcepts: [],
    sourceRefs: question.sourceRefs || [],
  }));
}

function normalizeStructuredResults(raw = {}, quiz = {}, answers = {}) {
  const results = Array.isArray(raw.questionResults)
    ? raw.questionResults
    : Array.isArray(raw.results)
      ? raw.results
      : [];
  if (!results.length) return fallbackQuestionResults({ quiz, answers });

  return (quiz.questions || []).map((question) => {
    const result =
      results.find((item) => item.questionId === question.id) || {};
    return {
      questionId: question.id,
      questionType: question.type,
      difficulty: question.difficulty || quiz.plan?.difficulty || null,
      question: question.question,
      options: question.options || [],
      userAnswer:
        result.userAnswer !== undefined
          ? result.userAnswer
          : answers[question.id],
      correctAnswer:
        result.correctAnswer !== undefined
          ? result.correctAnswer
          : question.correctAnswer,
      isCorrect:
        result.isCorrect === true
          ? true
          : result.isCorrect === false
            ? false
            : null,
      score: Number.isFinite(Number(result.score))
        ? Number(result.score)
        : null,
      analysis: result.analysis || result.explanation || "",
      mistakeReason: result.mistakeReason || "",
      weakConcepts: Array.isArray(result.weakConcepts)
        ? result.weakConcepts
        : [],
      sourceRefs: result.sourceRefs || question.sourceRefs || [],
    };
  });
}

function cleanStructuredJson(text = "") {
  const trimmed = String(text || "").trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return withoutFence.trim();
  return withoutFence.slice(start, end + 1).trim();
}

function parseStructuredResults({
  structuredText = "",
  quiz = {},
  answers = {},
}) {
  try {
    if (!String(structuredText || "").trim()) {
      throw new Error(QUIZ_STRUCTURED_RESULTS_MISSING);
    }
    const cleaned = cleanStructuredJson(structuredText);
    if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) {
      throw new Error(QUIZ_STRUCTURED_RESULTS_INVALID_JSON);
    }
    const parsed = safeJsonParse(cleaned, null);
    if (!parsed) throw new Error(QUIZ_STRUCTURED_RESULTS_INVALID_JSON);
    if (!parsed || !Array.isArray(parsed.questionResults)) {
      throw new Error(QUIZ_STRUCTURED_RESULTS_MISSING);
    }
    if (parsed.questionResults.length !== (quiz.questions || []).length) {
      throw new Error(QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH);
    }
    assertStructuredSourceRefs(parsed.questionResults, quiz);
    const questionResults = normalizeStructuredResults(parsed, quiz, answers);
    if (questionResults.some((result) => result.isCorrect === null)) {
      throw new Error(QUIZ_STRUCTURED_RESULTS_MISSING_IS_CORRECT);
    }
    return {
      reliable: true,
      error: null,
      questionResults,
    };
  } catch (error) {
    console.error("[Quiz] structured result parse failed", error);
    return {
      reliable: false,
      error: error.message || "structured_results_parse_failed",
      questionResults: fallbackQuestionResults({ quiz, answers }),
    };
  }
}

function assertStructuredSourceRefs(results = [], quiz = {}) {
  const evidenceIds = new Set([
    ...(quiz.evidenceChunks || []).map((chunk) => chunk.id),
    ...(quiz.sourceRefs || []).map((ref) => ref.id).filter(Boolean),
  ]);
  const questions = new Map(
    (quiz.questions || []).map((question) => [question.id, question])
  );

  for (const result of results) {
    const question = questions.get(result.questionId);
    if (!question) throw new Error(QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH);
    const allowedRefs = new Set([
      ...evidenceIds,
      ...(question.sourceRefs || []).map((ref) => String(ref)),
    ]);
    const refs = Array.isArray(result.sourceRefs) ? result.sourceRefs : [];
    if (!refs.length) continue;
    const invalid = refs.some((ref) => !allowedRefs.has(String(ref)));
    if (invalid) throw new Error(QUIZ_STRUCTURED_RESULTS_INVALID_SOURCE_REFS);
  }
}

module.exports = {
  analyzeQuizResults,
  streamAnalyzeQuizResults,
  createTaggedAnalysisStreamParser,
  parseStructuredResults,
  assertStructuredSourceRefs,
  QUIZ_STRUCTURED_RESULTS_MISSING,
  QUIZ_STRUCTURED_RESULTS_INVALID_JSON,
  QUIZ_STRUCTURED_RESULTS_COUNT_MISMATCH,
  QUIZ_STRUCTURED_RESULTS_MISSING_IS_CORRECT,
  QUIZ_STRUCTURED_RESULTS_INVALID_SOURCE_REFS,
  fallbackQuestionResults,
  normalizeStructuredResults,
  answerLines,
  evidenceLines,
};
