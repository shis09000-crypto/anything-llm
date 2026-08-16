const { safeJsonParse } = require("../http");

const QUIZ_SCHEMA_VERSION = "quiz-v1";
const QUIZ_STATES = {
  draft: "draft",
  generating: "generating",
  ready: "ready",
  submitting: "submitting",
  submitted: "submitted",
  failed: "failed",
  abandoned: "abandoned",
};

function clone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

function stateFromQuiz(quiz = {}) {
  if (quiz.state && Object.values(QUIZ_STATES).includes(quiz.state))
    return quiz.state;
  if (quiz.abandoned) return QUIZ_STATES.abandoned;
  if (quiz.submitted) return QUIZ_STATES.submitted;
  if (quiz.analysisStatus === "running") return QUIZ_STATES.submitting;
  if ((quiz.pendingTypes || []).length > 0) return QUIZ_STATES.generating;
  if ((quiz.failedTypes || []).length > 0) return QUIZ_STATES.failed;
  return QUIZ_STATES.ready;
}

function progressFromQuiz(quiz = {}) {
  const progress = quiz.progress || {};
  const updatedAt =
    progress.updatedAt || quiz.progressUpdatedAt || new Date().toISOString();
  return {
    answers: clone(progress.answers ?? quiz.answers ?? {}, {}),
    currentIndex: Number.isFinite(
      Number(progress.currentIndex ?? quiz.currentIndex)
    )
      ? Number(progress.currentIndex ?? quiz.currentIndex)
      : 0,
    progressVersion: Number(
      progress.progressVersion ?? quiz.progressVersion ?? 0
    ),
    updatedAt,
  };
}

function analysisStateFromQuiz(quiz = {}) {
  const analysisState = quiz.analysisState || {};
  const status =
    analysisState.status ||
    quiz.analysisStatus ||
    (quiz.submitted ? "completed" : null);
  return {
    status,
    markdown: analysisState.markdown ?? quiz.analysis ?? "",
    error: analysisState.error ?? quiz.analysisError ?? null,
    metrics: analysisState.metrics ?? quiz.analysisMetrics ?? {},
    questionResultsReliable:
      analysisState.questionResultsReliable ??
      quiz.questionResultsReliable ??
      (status === "completed" ? true : null),
    questionResultsParseError:
      analysisState.questionResultsParseError ??
      quiz.questionResultsParseError ??
      null,
  };
}

function generationJobsFromQuiz(quiz = {}) {
  if (Array.isArray(quiz.generationJobs)) return clone(quiz.generationJobs, []);
  return (quiz.generationStatus?.jobs || []).map((job) => ({
    ...job,
    status: (quiz.failedTypes || []).includes(job.type)
      ? "failed"
      : (quiz.pendingTypes || []).includes(job.type)
        ? "pending"
        : "completed",
    attempts: job.attempts || 0,
    error: (quiz.errors || []).find((item) => item.type === job.type) || null,
  }));
}

function publicPayloadFromQuiz(quiz = {}) {
  const progress = progressFromQuiz(quiz);
  const analysisState = analysisStateFromQuiz(quiz);
  const state = stateFromQuiz(quiz);
  const {
    evidenceChunks: _evidenceChunks,
    structuredResults: _structuredResults,
    privateState: _privateState,
    publicPayload: _publicPayload,
    ...rest
  } = quiz;

  return {
    ...rest,
    schemaVersion: QUIZ_SCHEMA_VERSION,
    state,
    answers: progress.answers,
    currentIndex: progress.currentIndex,
    progress,
    generationJobs: generationJobsFromQuiz(quiz),
    analysisState,
    analysis: analysisState.markdown,
    analysisStatus: analysisState.status,
    analysisError: analysisState.error,
    analysisMetrics: analysisState.metrics,
    questionResultsReliable: analysisState.questionResultsReliable,
    questionResultsParseError: analysisState.questionResultsParseError,
  };
}

function snapshotFromQuiz(quiz = {}, previousSnapshot = null) {
  const previousPrivate = previousSnapshot?.privateState || {};
  const privateState = {
    ...previousPrivate,
    evidenceChunks: clone(
      quiz.evidenceChunks ?? previousPrivate.evidenceChunks ?? [],
      []
    ),
    structuredResults: clone(
      quiz.structuredResults ?? previousPrivate.structuredResults ?? [],
      []
    ),
  };
  const publicPayload = publicPayloadFromQuiz(quiz);
  return {
    schemaVersion: QUIZ_SCHEMA_VERSION,
    publicPayload,
    privateState,
    generationJobs: publicPayload.generationJobs || [],
    analysisState: publicPayload.analysisState,
    progress: publicPayload.progress,
  };
}

function normalizeQuizSnapshot(raw = {}) {
  if (raw?.schemaVersion === QUIZ_SCHEMA_VERSION && raw.publicPayload) {
    const publicPayload = publicPayloadFromQuiz(raw.publicPayload);
    return {
      schemaVersion: QUIZ_SCHEMA_VERSION,
      publicPayload,
      privateState: {
        ...(raw.privateState || {}),
        evidenceChunks: clone(raw.privateState?.evidenceChunks || [], []),
        structuredResults: clone(raw.privateState?.structuredResults || [], []),
      },
      generationJobs: raw.generationJobs || publicPayload.generationJobs || [],
      analysisState: raw.analysisState || publicPayload.analysisState,
      progress: raw.progress || publicPayload.progress,
    };
  }
  return snapshotFromQuiz(raw || {});
}

function snapshotFromChatResponse(response = {}) {
  const snapshot = response?.quizSnapshot;
  if (snapshot) return normalizeQuizSnapshot(snapshot);
  const payload =
    response?.outputs?.find((output) => output.type === "QuizCard")?.payload ||
    null;
  return payload ? normalizeQuizSnapshot(payload) : null;
}

function hydrateQuiz(snapshot = {}) {
  const normalized = normalizeQuizSnapshot(snapshot);
  return {
    ...normalized.publicPayload,
    evidenceChunks: clone(normalized.privateState?.evidenceChunks || [], []),
    structuredResults: clone(
      normalized.privateState?.structuredResults || [],
      []
    ),
  };
}

function publicQuiz(quizOrSnapshot = {}) {
  if (quizOrSnapshot?.publicPayload) {
    return normalizeQuizSnapshot(quizOrSnapshot).publicPayload;
  }
  return publicPayloadFromQuiz(quizOrSnapshot);
}

function parseChatResponse(responseText) {
  return typeof responseText === "string"
    ? safeJsonParse(responseText, {})
    : responseText || {};
}

module.exports = {
  QUIZ_SCHEMA_VERSION,
  QUIZ_STATES,
  hydrateQuiz,
  normalizeQuizSnapshot,
  parseChatResponse,
  publicQuiz,
  publicPayloadFromQuiz,
  snapshotFromChatResponse,
  snapshotFromQuiz,
};
