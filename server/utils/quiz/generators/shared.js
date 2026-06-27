const { completeJsonStreamWithRetry } = require("../llm");
const { QUIZ_GENERATION_MODEL } = require("../constants");
const { validateQuestionsWithReport } = require("../validators/quizValidator");

function evidenceBlock(evidenceChunks = []) {
  return evidenceChunks
    .map(
      (chunk) =>
        `[${chunk.id}] score=${chunk.score}\nsource=${chunk.sourceRef.title}\n${chunk.text}`
    )
    .join("\n\n---\n\n");
}

async function generateQuestionsForType({ job, systemPrompt, typeRules }) {
  const prompt = generationPrompt({ job, typeRules });

  const { json, metrics, model } = await completeJsonStreamWithRetry({
    model: QUIZ_GENERATION_MODEL,
    systemPrompt,
    userPrompt: prompt,
    temperature: 0.1,
    label: `quiz_generate_${job.type}`,
  });
  let validation = validateQuestionsWithReport(
    json?.questions || [],
    job.evidenceChunks,
    {
      difficulty: job.difficulty,
    }
  );
  let questions = validation.questions;
  let validationReport = validation.report;
  let repairMetrics = null;

  if (questions.length === 0) {
    console.warn(
      `[QuizGeneration] empty_valid_questions type=${job.type} count=${job.count}; retrying with repair prompt`
    );
    const repair = await completeJsonStreamWithRetry({
      model: QUIZ_GENERATION_MODEL,
      systemPrompt,
      userPrompt: repairPrompt({ job, typeRules, previousJson: json }),
      temperature: 0.1,
      label: `quiz_repair_${job.type}`,
    });
    repairMetrics = repair.metrics;
    validation = validateQuestionsWithReport(
      repair.json?.questions || [],
      job.evidenceChunks,
      { difficulty: job.difficulty }
    );
    questions = validation.questions;
    validationReport = validation.report;
  }

  if (questions.length === 0) {
    const error = new Error(`quiz_${job.type}_empty_valid_questions`);
    error.code = "quiz_empty_valid_questions";
    throw error;
  }

  return {
    type: job.type,
    questions,
    metrics: {
      ...(repairMetrics || metrics || {}),
      validation: validationReport,
    },
    model,
  };
}

function generationPrompt({ job, typeRules }) {
  const isGeneralKnowledge = job.evidenceMode === "general_knowledge";
  const evidenceRules = isGeneralKnowledge
    ? `- The workspace has no usable knowledge-base evidence for this request.
- Generate questions from your general knowledge about the topic.
- Every question must include sourceRefs exactly as ["general-knowledge"].
- Do not claim that these questions are sourced from workspace documents.`
    : `- Use ONLY the evidence chunks below.
- Every question must include sourceRefs containing one or more evidence ids.
- Do not invent facts that are not present in evidence.`;

  return `Generate ${job.count} ${job.type} quiz questions.

Topic: ${job.topic}
Keywords: ${(job.keywords || []).join(", ")}
Difficulty: ${job.difficulty}

Rules:
${evidenceRules}
- Do not write explanations, grading notes, teaching analysis, weak points, or review advice.
- Return JSON only.
${typeRules}

Output schema:
{
  "questions": [
    {
      "id": "stable-id",
      "type": "${job.type}",
      "question": "string",
      "options": [{"id": "A", "text": "string"}],
      "correctAnswer": "A or array",
      "sourceRefs": ["evidence-1"]
    }
  ]
}

Evidence:
${evidenceBlock(job.evidenceChunks)}`;
}

function repairPrompt({ job, typeRules, previousJson }) {
  const evidenceIds = (job.evidenceChunks || []).map((chunk) => chunk.id);
  const isGeneralKnowledge = job.evidenceMode === "general_knowledge";
  const evidenceConstraint = isGeneralKnowledge
    ? `- Every question.sourceRefs must be exactly ["general-knowledge"].`
    : `- Every question.sourceRefs entry must be one of these exact evidence ids: ${evidenceIds.join(", ")}.
- Do not invent facts outside the evidence.`;
  return `The previous ${job.type} quiz generation returned zero valid questions after validation.

Regenerate exactly ${job.count} valid ${job.type} questions now.

Hard validation requirements:
- Return strict JSON only.
- Every question.type must be "${job.type}".
${evidenceConstraint}
- Every question must include a non-empty question, correctAnswer, and sourceRefs.
- single_choice must have exactly 4 options and exactly 1 correct option id.
- multiple_choice must have 4-6 options, 2-4 correct option ids, and not all options correct.
- fill_blank must have no options and correctAnswer must be a non-empty array of acceptable answers.
- Do not use source titles as sourceRefs. Use evidence ids only.
- Do not write explanations, grading notes, teaching analysis, weak points, or review advice.

Original type rules:
${typeRules}

Previous invalid JSON:
${JSON.stringify(previousJson || {})}

Evidence:
${evidenceBlock(job.evidenceChunks)}`;
}

module.exports = {
  evidenceBlock,
  generationPrompt,
  repairPrompt,
  generateQuestionsForType,
};
