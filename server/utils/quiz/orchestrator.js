const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { WorkspaceThread } = require("../../models/workspaceThread");
const {
  convertToChatHistory,
  safeJSONStringify,
} = require("../helpers/chat/responses");
const { extractQuizPlan } = require("./plan");
const { retrieveQuizEvidence } = require("./evidence");
const { allocateQuestionGeneration } = require("./allocationCenter");
const { runGenerationJob } = require("./generators");
const {
  assembleQuiz,
  mergeQuestions,
  quizOutput,
  quizResponseText,
} = require("./assembly");
const { streamAnalyzeQuizResults } = require("./analysis");
const {
  favoriteQuestion,
  saveWrongQuestions,
  unfavoriteQuestion,
  upsertAttemptAndQuestionResults,
} = require("./learningRecords");
const {
  hydrateQuiz,
  parseChatResponse,
  publicQuiz,
  snapshotFromChatResponse,
  snapshotFromQuiz,
} = require("./snapshot");

const activeQuizGenerations = new Set();

function quizGenerationLog(event, details = {}) {
  console.log(`[QuizGeneration] ${event}`, details);
}

function responseForQuiz(quiz, text = null) {
  const snapshot = snapshotFromQuiz(quiz);
  const payload = snapshot.publicPayload;
  return {
    text: text || quizResponseText(payload),
    type: "quiz",
    sources: payload.sourceRefs || [],
    quizSnapshot: snapshot,
    outputs: quizOutput(payload),
  };
}

async function resolveThread({ workspace, user = null, threadSlug = null }) {
  if (!threadSlug) return null;
  return await WorkspaceThread.get({
    slug: String(threadSlug),
    workspace_id: workspace.id,
    ...(user ? { user_id: user.id } : {}),
  });
}

async function chatHistoryFor({ workspace, user = null, thread = null }) {
  const history = await WorkspaceChats.where(
    {
      workspaceId: workspace.id,
      user_id: user?.id || null,
      thread_id: thread?.id || null,
      api_session_id: null,
      include: true,
    },
    null,
    { id: "asc" }
  );
  return convertToChatHistory(history);
}

function quizFromChat(chat) {
  const response = parseChatResponse(chat?.response);
  const snapshot = snapshotFromChatResponse(response);
  return snapshot ? hydrateQuiz(snapshot) : null;
}

async function updateChatQuiz(chatId, quiz, text = null) {
  await WorkspaceChats._update(Number(chatId), {
    response: safeJSONStringify(responseForQuiz(quiz, text)),
    lastUpdatedAt: new Date(),
  });
}

function quizStatusValue(quiz = {}) {
  if (quiz.abandoned) return "abandoned";
  if (quiz.pendingTypes?.length > 0) return "generating";
  if (quiz.failedTypes?.length > 0) return "failed";
  return "ready";
}

function preserveRuntimeState(previous = {}, next = {}) {
  return {
    ...previous,
    ...next,
    schemaVersion: next.schemaVersion || previous.schemaVersion,
    state: next.state || previous.state,
    answers: previous.answers || next.answers || {},
    currentIndex: previous.currentIndex ?? next.currentIndex ?? 0,
    progress: previous.progress || next.progress,
    generationJobs: next.generationJobs || previous.generationJobs || [],
    analysisState: next.analysisState || previous.analysisState,
    submitted: previous.submitted || next.submitted || false,
    submittedAt: previous.submittedAt || next.submittedAt,
    analysis: previous.analysis || next.analysis,
    analysisStatus: previous.analysisStatus || next.analysisStatus,
    analysisError: previous.analysisError || next.analysisError,
    analysisMetrics: previous.analysisMetrics || next.analysisMetrics,
    questionResults: previous.questionResults || next.questionResults || [],
    questionResultsReliable:
      previous.questionResultsReliable ?? next.questionResultsReliable,
    questionResultsParseError:
      previous.questionResultsParseError || next.questionResultsParseError,
    attemptId: previous.attemptId || next.attemptId,
    wrongQuestionsSaved:
      previous.wrongQuestionsSaved || next.wrongQuestionsSaved || false,
    wrongQuestionCount:
      previous.wrongQuestionCount ?? next.wrongQuestionCount ?? 0,
    wrongQuestionsSavedAt:
      previous.wrongQuestionsSavedAt || next.wrongQuestionsSavedAt,
    favoritedQuestionIds:
      previous.favoritedQuestionIds || next.favoritedQuestionIds || [],
    abandoned: previous.abandoned || next.abandoned || false,
    abandonedAt: previous.abandonedAt || next.abandonedAt,
  };
}

async function quizChat({ workspace, user = null, quizId }) {
  const chat = await WorkspaceChats.get({
    id: Number(quizId),
    workspaceId: workspace.id,
    user_id: user?.id || null,
    include: true,
  });
  if (!chat) throw new Error("quiz_not_found");
  const quiz = quizFromChat(chat);
  if (!quiz) throw new Error("quiz_payload_not_found");
  return { chat, quiz };
}

async function markJobFailed({ chatId, type, error }) {
  const chat = await WorkspaceChats.get({ id: Number(chatId) });
  const quiz = quizFromChat(chat);
  if (!quiz) return;
  if (quiz.abandoned || quiz.submitted) return;
  const failedTypes = [...new Set([...(quiz.failedTypes || []), type])];
  const errors = [
    ...(quiz.errors || []),
    { type, message: error?.message || String(error || "generation_failed") },
  ];
  const nextQuiz = assembleQuiz({
    quizId: quiz.id,
    plan: quiz.plan,
    evidenceChunks: quiz.evidenceChunks || [],
    sourceRefs: quiz.sourceRefs || [],
    jobs: quiz.generationStatus?.jobs || [],
    questions: quiz.questions || [],
    failedTypes,
    errors,
  });
  await updateChatQuiz(chatId, preserveRuntimeState(quiz, nextQuiz));
}

async function appendJobQuestions({ chatId, questions }) {
  const chat = await WorkspaceChats.get({ id: Number(chatId) });
  const quiz = quizFromChat(chat);
  if (!quiz) return;
  if (quiz.abandoned || quiz.submitted) return;
  const mergedQuestions = mergeQuestions(quiz.questions || [], questions || []);
  const nextQuiz = assembleQuiz({
    quizId: quiz.id,
    plan: quiz.plan,
    evidenceChunks: quiz.evidenceChunks || [],
    sourceRefs: quiz.sourceRefs || [],
    jobs: quiz.generationStatus?.jobs || [],
    questions: mergedQuestions,
    failedTypes: quiz.failedTypes || [],
    errors: quiz.errors || [],
  });
  await updateChatQuiz(chatId, preserveRuntimeState(quiz, nextQuiz));
}

function countQuestionsByType(questions = [], type) {
  return (questions || []).filter((question) => question.type === type).length;
}

function jobIsSatisfied(quiz = {}, job = {}) {
  return countQuestionsByType(quiz.questions || [], job.type) >= job.count;
}

function pendingJobsForQuiz(quiz = {}) {
  if (quiz.abandoned || quiz.submitted) return [];
  if (!quiz.plan || !(quiz.evidenceChunks || []).length) return [];
  const failedTypes = new Set(quiz.failedTypes || []);
  const pendingTypes = new Set(quiz.pendingTypes || []);
  return allocateQuestionGeneration({
    plan: quiz.plan,
    evidenceChunks: quiz.evidenceChunks || [],
  }).filter((job) => {
    if (failedTypes.has(job.type)) return false;
    if (pendingTypes.size > 0 && !pendingTypes.has(job.type)) return false;
    return !jobIsSatisfied(quiz, job);
  });
}

async function runBackgroundJobs({ chatId, jobs = [] }) {
  for (const job of jobs) {
    const latest = quizFromChat(
      await WorkspaceChats.get({ id: Number(chatId) })
    );
    if (!latest) return;
    if (latest.abandoned || latest.submitted) {
      quizGenerationLog("skipped", {
        quizId: chatId,
        type: job.type,
        reason: latest.abandoned ? "abandoned" : "submitted",
      });
      return;
    }
    if (jobIsSatisfied(latest, job)) {
      quizGenerationLog("skipped", {
        quizId: chatId,
        type: job.type,
        reason: "already_satisfied",
        count: job.count,
      });
      continue;
    }

    const startedAt = Date.now();
    quizGenerationLog("started", {
      quizId: chatId,
      type: job.type,
      count: job.count,
      generator: job.generator,
      model: "deepseek-v4-pro",
    });
    try {
      const result = await runGenerationJob(job);
      if (!result.questions?.length) {
        const error = new Error(`quiz_${job.type}_empty_valid_questions`);
        error.code = "quiz_empty_valid_questions";
        throw error;
      }
      await appendJobQuestions({
        chatId,
        questions: result.questions || [],
      });
      quizGenerationLog("succeeded", {
        quizId: chatId,
        type: job.type,
        generated: result.questions?.length || 0,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      quizGenerationLog("failed", {
        quizId: chatId,
        type: job.type,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      await markJobFailed({ chatId, type: job.type, error });
    }
  }
}

async function enqueueRemainingGenerationJobs({ chatId, reason = "unknown" }) {
  const key = String(chatId);
  if (activeQuizGenerations.has(key)) {
    quizGenerationLog("skipped", {
      quizId: key,
      reason: "already_active",
      source: reason,
    });
    return false;
  }

  const chat = await WorkspaceChats.get({ id: Number(chatId) });
  const quiz = quizFromChat(chat);
  const jobs = pendingJobsForQuiz(quiz);
  if (!jobs.length) return false;

  activeQuizGenerations.add(key);
  quizGenerationLog("queued", {
    quizId: key,
    reason,
    jobs: jobs.map((job) => ({ type: job.type, count: job.count })),
  });

  setImmediate(() =>
    runBackgroundJobs({ chatId: key, jobs })
      .catch((error) =>
        console.error("[Quiz] background generation failed", error)
      )
      .finally(() => activeQuizGenerations.delete(key))
  );
  return true;
}

async function generateQuiz({
  workspace,
  user = null,
  message,
  threadSlug = null,
}) {
  const thread = await resolveThread({ workspace, user, threadSlug });
  if (threadSlug && !thread) throw new Error("quiz_thread_not_found");

  const { plan } = await extractQuizPlan({
    userRequest: message,
    workspaceSlug: workspace.slug,
  });
  const { evidenceChunks, sourceRefs, error } = await retrieveQuizEvidence({
    workspace,
    plan,
  });
  if (error || evidenceChunks.length === 0) {
    return {
      success: false,
      insufficientEvidence: true,
      error: error || "quiz_insufficient_evidence",
      history: await chatHistoryFor({ workspace, user, thread }),
    };
  }

  const jobs = allocateQuestionGeneration({ plan, evidenceChunks });
  const firstJob = jobs[0];
  if (!firstJob) throw new Error("quiz_no_generation_jobs");

  const firstResult = await runGenerationJob(firstJob);
  if (!firstResult.questions?.length) {
    return {
      success: false,
      insufficientEvidence: true,
      error: "quiz_first_batch_empty",
      history: await chatHistoryFor({ workspace, user, thread }),
    };
  }

  const initialQuizId = uuidv4();
  const initialQuiz = assembleQuiz({
    quizId: initialQuizId,
    plan,
    evidenceChunks,
    sourceRefs,
    jobs,
    questions: firstResult.questions,
  });
  const { chat, message: chatError } = await WorkspaceChats.new({
    workspaceId: workspace.id,
    prompt: message,
    response: responseForQuiz(initialQuiz),
    user,
    threadId: thread?.id || null,
  });
  if (!chat) throw new Error(chatError || "quiz_chat_create_failed");

  const quiz = { ...initialQuiz, id: String(chat.id), chatId: chat.id };
  await updateChatQuiz(chat.id, quiz);

  await enqueueRemainingGenerationJobs({
    chatId: chat.id,
    reason: "generate_quiz",
  });

  return {
    success: true,
    quizId: String(chat.id),
    status: quiz.generationStatus.status,
    quiz: publicQuiz(quiz),
    generationStatus: quiz.generationStatus,
    history: await chatHistoryFor({ workspace, user, thread }),
  };
}

async function quizStatus({ workspace, user = null, quizId }) {
  const chat = await WorkspaceChats.get({
    id: Number(quizId),
    workspaceId: workspace.id,
    user_id: user?.id || null,
    include: true,
  });
  if (!chat) throw new Error("quiz_not_found");
  const quiz = quizFromChat(chat);
  if (!quiz) throw new Error("quiz_payload_not_found");
  if (
    (quiz.pendingTypes || []).length > 0 &&
    !quiz.abandoned &&
    !quiz.submitted
  ) {
    await enqueueRemainingGenerationJobs({
      chatId: chat.id,
      reason: "status_recovery",
    });
  }
  return {
    quizId: String(quiz.id || quizId),
    status: quizStatusValue(quiz),
    questions: quiz.questions || [],
    generatedCounts: quiz.generatedCounts || {},
    pendingTypes: quiz.pendingTypes || [],
    failedTypes: quiz.failedTypes || [],
    errors: quiz.errors || [],
    quiz: publicQuiz(quiz),
  };
}

async function submitQuiz({ workspace, user = null, quizId }) {
  const { quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.abandoned) throw new Error("quiz_abandoned");
  if ((quiz.pendingTypes || []).length > 0) {
    return {
      success: false,
      pending: true,
      error: "quiz_generation_still_running",
      quiz: publicQuiz(quiz),
    };
  }
  return {
    success: false,
    error: "quiz_submit_stream_required",
    quiz: publicQuiz(quiz),
  };
}

async function submitQuizStream({
  response,
  workspace,
  user = null,
  quizId,
  answers = {},
}) {
  const { chat, quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.abandoned) throw new Error("quiz_abandoned");
  if ((quiz.pendingTypes || []).length > 0) {
    const error = new Error("quiz_generation_still_running");
    error.status = 409;
    throw error;
  }

  const runningQuiz = {
    ...quiz,
    answers,
    analysisStatus: "running",
    analysisError: null,
  };
  await updateChatQuiz(chat.id, runningQuiz, runningQuiz.analysis || "");

  let analysis = "";
  try {
    const result = await streamAnalyzeQuizResults({
      response,
      quiz: runningQuiz,
      answers,
      uuid: uuidv4(),
    });
    analysis = result.text || "";
    runningQuiz.analysisMetrics = result.metrics || {};
    runningQuiz.structuredResults = result.structuredResults || [];
    runningQuiz.questionResultsReliable = result.questionResultsReliable;
    runningQuiz.questionResultsParseError = result.questionResultsParseError;
  } catch (error) {
    const latest = quizFromChat(await WorkspaceChats.get({ id: chat.id }));
    if (!latest?.abandoned) {
      await updateChatQuiz(
        chat.id,
        {
          ...runningQuiz,
          analysisStatus: "failed",
          analysisError: error.message,
          analysis,
        },
        analysis
      );
    }
    throw error;
  }

  const latestChat = await WorkspaceChats.get({ id: chat.id });
  const latestQuiz = quizFromChat(latestChat);
  if (!latestQuiz || latestQuiz.abandoned) return { skipped: true };

  const learning = await upsertAttemptAndQuestionResults({
    workspace,
    user,
    quiz: latestQuiz,
    answers,
    analysis,
    structuredResults: runningQuiz.structuredResults || [],
    questionResultsReliable: runningQuiz.questionResultsReliable === true,
    questionResultsParseError: runningQuiz.questionResultsParseError || null,
  });
  const submittedQuiz = {
    ...latestQuiz,
    submitted: true,
    submittedAt: new Date().toISOString(),
    answers,
    partialQuizSubmitted: (latestQuiz.failedTypes || []).length > 0,
    analysis,
    analysisMetrics: runningQuiz.analysisMetrics || {},
    analysisStatus: "completed",
    analysisError: null,
    questionResultsReliable: runningQuiz.questionResultsReliable === true,
    questionResultsParseError: runningQuiz.questionResultsParseError || null,
    attemptId: learning.attempt.id,
    questionResults: learning.questionResults,
    score: learning.score,
    accuracy: learning.accuracy,
  };
  await updateChatQuiz(chat.id, submittedQuiz, analysis);
  return { success: true, quiz: publicQuiz(submittedQuiz), analysis };
}

async function saveQuizProgress({
  workspace,
  user = null,
  quizId,
  answers = {},
  currentIndex = 0,
}) {
  const { chat, quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.abandoned) throw new Error("quiz_abandoned");
  const previousVersion = Number(quiz.progress?.progressVersion || 0);
  const nextQuiz = {
    ...quiz,
    answers,
    currentIndex: Number.isFinite(Number(currentIndex))
      ? Number(currentIndex)
      : 0,
    progressUpdatedAt: new Date().toISOString(),
  };
  nextQuiz.progress = {
    answers,
    currentIndex: nextQuiz.currentIndex,
    progressVersion: previousVersion + 1,
    updatedAt: nextQuiz.progressUpdatedAt,
  };
  await updateChatQuiz(chat.id, nextQuiz, nextQuiz.analysis || null);
  return { success: true, quiz: publicQuiz(nextQuiz) };
}

async function abandonQuiz({ workspace, user = null, quizId }) {
  const { chat, quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.submitted) throw new Error("quiz_already_submitted");
  const nextQuiz = {
    ...quiz,
    abandoned: true,
    abandonedAt: new Date().toISOString(),
    submitted: false,
    pendingTypes: [],
    analysisStatus: "abandoned",
    generationStatus: {
      ...(quiz.generationStatus || {}),
      status: "abandoned",
    },
  };
  await updateChatQuiz(chat.id, nextQuiz, "本次测试已放弃，不会计入学习记录。");
  return { success: true, quiz: publicQuiz(nextQuiz) };
}

async function saveQuizWrongQuestions({ workspace, user = null, quizId }) {
  const { chat, quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.abandoned) throw new Error("quiz_abandoned");
  if (!quiz.submitted) throw new Error("quiz_not_submitted");
  if (quiz.questionResultsReliable !== true) {
    throw new Error("quiz_question_results_unreliable");
  }
  const { count } = await saveWrongQuestions({ workspace, user, quiz });
  const nextQuiz = {
    ...quiz,
    wrongQuestionsSaved: true,
    wrongQuestionCount: count,
    wrongQuestionsSavedAt: new Date().toISOString(),
  };
  await updateChatQuiz(chat.id, nextQuiz, nextQuiz.analysis || null);
  return { success: true, count, quiz: publicQuiz(nextQuiz) };
}

function markQuestionFavorite(questions = [], questionId, favorited) {
  return questions.map((question) =>
    question.id === questionId
      ? {
          ...question,
          favorited,
          favoritedAt: favorited ? new Date().toISOString() : null,
        }
      : question
  );
}

async function saveFavoriteQuestion({
  workspace,
  user = null,
  quizId,
  questionId,
}) {
  const { chat, quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.abandoned) throw new Error("quiz_abandoned");
  if (!quiz.submitted) throw new Error("quiz_not_submitted");
  await favoriteQuestion({ workspace, user, quiz, questionId });
  const ids = new Set([...(quiz.favoritedQuestionIds || []), questionId]);
  const nextQuiz = {
    ...quiz,
    favoritedQuestionIds: [...ids],
    questions: markQuestionFavorite(quiz.questions || [], questionId, true),
  };
  await updateChatQuiz(chat.id, nextQuiz, nextQuiz.analysis || null);
  return { success: true, quiz: publicQuiz(nextQuiz) };
}

async function deleteFavoriteQuestion({
  workspace,
  user = null,
  quizId,
  questionId,
}) {
  const { chat, quiz } = await quizChat({ workspace, user, quizId });
  if (quiz.abandoned) throw new Error("quiz_abandoned");
  if (!quiz.submitted) throw new Error("quiz_not_submitted");
  await unfavoriteQuestion({ workspace, user, quiz, questionId });
  const nextQuiz = {
    ...quiz,
    favoritedQuestionIds: (quiz.favoritedQuestionIds || []).filter(
      (id) => id !== questionId
    ),
    questions: markQuestionFavorite(quiz.questions || [], questionId, false),
  };
  await updateChatQuiz(chat.id, nextQuiz, nextQuiz.analysis || null);
  return { success: true, quiz: publicQuiz(nextQuiz) };
}

module.exports = {
  generateQuiz,
  quizStatus,
  submitQuiz,
  submitQuizStream,
  saveQuizProgress,
  abandonQuiz,
  saveQuizWrongQuestions,
  saveFavoriteQuestion,
  deleteFavoriteQuestion,
  responseForQuiz,
  quizFromChat,
  updateChatQuiz,
  enqueueRemainingGenerationJobs,
  pendingJobsForQuiz,
  runBackgroundJobs,
};
