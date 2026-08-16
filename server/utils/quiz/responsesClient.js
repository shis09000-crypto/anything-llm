const crypto = require("crypto");
const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const { requestInternalService } = require("../microModules");
const { writeResponseChunk } = require("../helpers/chat/responses");

const WorkspaceThread = lazyDataAccessFacade("quiz").workspaceThread;

function runtimeUrl(env = process.env) {
  const value = String(env.ATHENA_RESPONSES_RUNTIME_URL || "").replace(
    /\/+$/,
    ""
  );
  if (!value) throw new Error("responses_runtime_url_missing");
  return value;
}

async function resolveThread({ workspace, user = null, threadSlug = null }) {
  if (!threadSlug) return null;
  const thread = await WorkspaceThread.get({
    slug: String(threadSlug),
    workspace_id: workspace.id,
    ...(user ? { user_id: user.id } : {}),
  });
  if (!thread)
    throw Object.assign(new Error("quiz_thread_not_found"), {
      httpStatus: 404,
    });
  return thread;
}

function workspacePayload(workspace = {}) {
  return {
    id: Number(workspace.id),
    slug: String(workspace.slug || ""),
    similarityThreshold: workspace.similarityThreshold,
    vectorSearchMode: workspace.vectorSearchMode,
  };
}

function athenaScope({ workspace, user = null, thread = null }) {
  return {
    workspaceId: Number(workspace.id),
    threadId: thread?.id ?? null,
    userId: user?.id ?? null,
    taskName: "quiz",
    taskIntent: "quiz",
    taskPriority: "P0",
  };
}

function quizCoordinationContext({ idempotencyKey, timeoutMs }) {
  const correlationId = String(idempotencyKey || crypto.randomUUID());
  return {
    coordinationRunId: `quiz-${correlationId}`,
    stepId: `responses-quiz-${crypto.randomUUID()}`,
    correlationId,
    center: "task",
    priority: "P0",
    deadlineAt: new Date(Date.now() + Math.max(5_000, timeoutMs)).toISOString(),
    causationId: correlationId,
  };
}

async function call(
  action,
  { workspace, user = null, thread = null, quizId = null, body = {} },
  options = {}
) {
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 20_000);
  const idempotencyKey = options.idempotencyKey || crypto.randomUUID();
  return requestInternalService({
    callerRole: "api",
    callerModule: "athena-api",
    targetModule: "responses-runtime",
    capability: "responses.quiz.execute",
    contractVersion: "1.0",
    method: "POST",
    url: `${runtimeUrl()}/internal/v1/responses/quizzes${quizId ? `/${encodeURIComponent(quizId)}` : ""}/${action}`,
    body: {
      ...body,
      workspace: workspacePayload(workspace),
      athena: athenaScope({ workspace, user, thread }),
    },
    idempotencyKey,
    // Quiz is a declared AICP Task. Always attach a fresh, bounded task
    // context instead of inheriting a potentially expired page/bootstrap
    // context. An invalid inherited deadline used to stop requests before they
    // ever reached the Responses runtime.
    coordinationContext: quizCoordinationContext({
      idempotencyKey,
      timeoutMs,
    }),
    timeoutMs,
  });
}

async function generateQuiz({
  workspace,
  user = null,
  message,
  threadSlug = null,
  nodeContext = null,
  clientTurnId = null,
}) {
  const thread = await resolveThread({ workspace, user, threadSlug });
  return call(
    "generate",
    {
      workspace,
      user,
      thread,
      body: { message, nodeContext, clientTurnId },
    },
    { timeoutMs: 20_000, idempotencyKey: clientTurnId || undefined }
  );
}

async function quizStatus({ workspace, user = null, quizId }) {
  return call("status", { workspace, user, quizId });
}

async function submitQuiz({ workspace, user = null, quizId, answers = {} }) {
  return call("submit", { workspace, user, quizId, body: { answers } });
}

async function submitQuizStream({
  response,
  workspace,
  user = null,
  quizId,
  answers = {},
}) {
  const result = await submitQuiz({ workspace, user, quizId, answers });
  writeResponseChunk(response, {
    uuid: crypto.randomUUID(),
    sources: result.quiz?.sourceRefs || [],
    type: "textResponseChunk",
    textResponse: result.analysis || "",
    close: false,
    error: false,
  });
  writeResponseChunk(response, {
    uuid: crypto.randomUUID(),
    sources: result.quiz?.sourceRefs || [],
    type: "textResponseChunk",
    textResponse: "",
    close: true,
    error: false,
  });
  return result;
}

async function saveQuizProgress({
  workspace,
  user = null,
  quizId,
  answers = {},
  currentIndex = 0,
}) {
  return call("progress", {
    workspace,
    user,
    quizId,
    body: { answers, currentIndex },
  });
}

async function abandonQuiz({ workspace, user = null, quizId }) {
  return call("abandon", { workspace, user, quizId });
}

async function saveQuizWrongQuestions({ workspace, user = null, quizId }) {
  return call("wrong-questions", { workspace, user, quizId });
}

async function dismissQuizWrongQuestions({ workspace, user = null, quizId }) {
  return call("wrong-questions-dismiss", { workspace, user, quizId });
}

async function saveFavoriteQuestion({
  workspace,
  user = null,
  quizId,
  questionId,
}) {
  return call("favorite", {
    workspace,
    user,
    quizId,
    body: { questionId, favorited: true },
  });
}

async function deleteFavoriteQuestion({
  workspace,
  user = null,
  quizId,
  questionId,
}) {
  return call("favorite", {
    workspace,
    user,
    quizId,
    body: { questionId, favorited: false },
  });
}

async function quizHistory({ workspace, user = null, threadSlug = null }) {
  const thread = await resolveThread({ workspace, user, threadSlug });
  return call("history", { workspace, user, thread });
}

module.exports = {
  abandonQuiz,
  deleteFavoriteQuestion,
  dismissQuizWrongQuestions,
  generateQuiz,
  quizHistory,
  quizStatus,
  saveFavoriteQuestion,
  saveQuizProgress,
  saveQuizWrongQuestions,
  submitQuiz,
  submitQuizStream,
};
