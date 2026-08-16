const { draftQuizPlan, extractQuizPlan } = require("../../quiz/plan");
const { retrieveQuizEvidence } = require("../../quiz/evidence");
const { allocateQuestionGeneration } = require("../../quiz/allocationCenter");
const { runGenerationJob } = require("../../quiz/generators");
const {
  assembleQuiz,
  mergeQuestions,
  quizOutput,
  quizResponseText,
} = require("../../quiz/assembly");
const { analyzeQuizResults } = require("../../quiz/analysis");
const {
  gradeSelectionQuestions,
  mergeFinalQuestionResults,
} = require("../../quiz/grading");
const { publicQuiz } = require("../../quiz/snapshot");
const { ResponsesQuizRepository, quizConversationId } = require("./repository");

const BACKGROUND_CONCURRENCY = 2;

function error(code, status = 500) {
  return Object.assign(new Error(code), { code, httpStatus: status });
}

function scope(body = {}) {
  const athena = body.athena || {};
  const workspaceId = Number(athena.workspaceId);
  const threadId =
    athena.threadId === null || athena.threadId === undefined
      ? null
      : Number(athena.threadId);
  const ownerUserId =
    athena.userId === null || athena.userId === undefined
      ? null
      : Number(athena.userId);
  if (!Number.isFinite(workspaceId))
    throw error("quiz_workspace_required", 400);
  if (threadId !== null && !Number.isFinite(threadId))
    throw error("quiz_thread_invalid", 400);
  if (ownerUserId !== null && !Number.isFinite(ownerUserId))
    throw error("quiz_user_invalid", 400);
  return { workspaceId, threadId, ownerUserId };
}

function requestBodyForScope(expected = {}) {
  return {
    athena: {
      workspaceId: expected.workspaceId,
      threadId: expected.threadId ?? null,
      userId: expected.ownerUserId ?? expected.userId ?? null,
    },
  };
}

function authorize(row, expected) {
  if (!row || row.workspaceId !== expected.workspaceId)
    throw error("quiz_not_found", 404);
  if ((row.ownerUserId ?? null) !== expected.ownerUserId)
    throw error("quiz_not_found", 404);
  return row;
}

function pendingJobs(quiz = {}) {
  if (quiz.abandoned || quiz.submitted || quiz.generationPhase === "planning")
    return [];
  const questions = mergeQuestions(
    quiz.questions || [],
    quiz.deferredQuestions || []
  );
  const failed = new Set(quiz.failedTypes || []);
  return allocateQuestionGeneration({
    plan: quiz.plan,
    evidenceChunks: quiz.evidenceChunks || [],
    evidenceMode: quiz.evidenceMode || "workspace",
  }).filter(
    (job) =>
      !failed.has(job.type) &&
      questions.filter((question) => question.type === job.type).length <
        job.count
  );
}

function preserveState(previous = {}, next = {}) {
  return {
    ...previous,
    ...next,
    answers: previous.answers || next.answers || {},
    currentIndex: previous.currentIndex ?? next.currentIndex ?? 0,
    progress: previous.progress || next.progress,
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
    favoritedQuestionIds:
      previous.favoritedQuestionIds || next.favoritedQuestionIds || [],
    wrongQuestionIds: previous.wrongQuestionIds || next.wrongQuestionIds || [],
    wrongQuestionsSaved:
      previous.wrongQuestionsSaved || next.wrongQuestionsSaved || false,
    abandoned: previous.abandoned || next.abandoned || false,
    abandonedAt: previous.abandonedAt || next.abandonedAt,
  };
}

function quizStatus(quiz = {}) {
  if (quiz.abandoned) return "abandoned";
  if (quiz.submitted) return "submitted";
  if ((quiz.pendingTypes || []).length > 0) return "generating";
  if ((quiz.failedTypes || []).length > 0) return "failed";
  return "ready";
}

function needsGeneration(quiz = {}) {
  if (quiz.abandoned || quiz.submitted) return false;
  if (quiz.generationPhase === "planning") return true;
  return pendingJobs(quiz).length > 0;
}

function publicResult(quiz) {
  return {
    quizId: String(quiz.id),
    status: quizStatus(quiz),
    questions: quiz.questions || [],
    generatedCounts: quiz.generatedCounts || {},
    pendingTypes: quiz.pendingTypes || [],
    failedTypes: quiz.failedTypes || [],
    errors: quiz.errors || [],
    quiz: publicQuiz(quiz),
  };
}

function scoreResults(results = []) {
  const reliable = results.every(
    (item) => item.isCorrect === true || item.isCorrect === false
  );
  const correct = results.filter((item) => item.isCorrect === true).length;
  return {
    score: reliable ? correct : null,
    accuracy: reliable && results.length ? correct / results.length : null,
  };
}

function favoriteQuestions(questions = [], questionId, favorited) {
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

class ResponsesQuizRuntime {
  constructor({ repository = new ResponsesQuizRepository() } = {}) {
    this.repository = repository;
    this.active = new Set();
    this.activeAnalyses = new Set();
  }

  snapshot() {
    return {
      activeQuizGenerations: this.active.size,
      activeQuizAnalyses: this.activeAnalyses.size,
    };
  }

  async stateFor(id, body) {
    const expected = scope(body);
    const row = authorize(await this.repository.find(id), expected);
    const state = await this.repository.read(row);
    if (!state?.quiz) throw error("quiz_payload_not_found", 404);
    return { row, state, expected };
  }

  async generate(body = {}) {
    const expected = scope(body);
    const message = String(body.message || "").trim();
    const workspace = body.workspace || {};
    if (!message) throw error("message_required", 400);
    if (Number(workspace.id) !== expected.workspaceId || !workspace.slug)
      throw error("quiz_workspace_scope_invalid", 400);

    if (body.clientTurnId) {
      const rows = await this.repository.list(expected);
      for (const existingRow of rows) {
        const existingState = await this.repository.read(existingRow);
        if (existingState?.clientTurnId !== body.clientTurnId) continue;
        this.enqueue(existingRow.id, expected);
        return {
          success: true,
          replayed: true,
          ...publicResult(existingState.quiz),
          generationStatus: existingState.quiz.generationStatus,
          history: await this.history(body).then((result) => result.history),
        };
      }
    }

    const createdAt = new Date().toISOString();
    const quizId = this.repository.nextId?.() || quizConversationId();
    const plan = draftQuizPlan(message);
    const jobs = allocateQuestionGeneration({
      plan,
      evidenceChunks: [],
      evidenceMode: "pending",
    });
    const initial = assembleQuiz({
      quizId,
      plan,
      evidenceChunks: [],
      evidenceMode: "pending",
      sourceRefs: [],
      jobs,
      questions: [],
    });
    initial.generationPhase = "planning";
    initial.pendingTypes = ["planning"];
    initial.generationStatus = {
      ...initial.generationStatus,
      status: "planning",
    };
    const row = await this.repository.create({
      id: quizId,
      ...expected,
      state: {
        schemaVersion: "responses-quiz-v1",
        prompt: message,
        clientTurnId: body.clientTurnId || null,
        createdAt,
        workspace,
        nodeContext: body.nodeContext || null,
        quiz: {
          ...initial,
          id: quizId,
          conversationId: quizId,
        },
      },
    });
    const quiz = { ...initial, id: row.id, conversationId: row.id };
    this.enqueue(row.id, expected);
    return {
      success: true,
      ...publicResult(quiz),
      generationStatus: quiz.generationStatus,
      history: await this.history(body).then((result) => result.history),
    };
  }

  enqueue(id, expected) {
    const key = String(id);
    if (this.active.has(key)) return false;
    this.active.add(key);
    setImmediate(() =>
      this.runGeneration(key, expected)
        .catch((failure) =>
          console.error("[ResponsesQuiz] background generation failed", failure)
        )
        .finally(() => this.active.delete(key))
    );
    return true;
  }

  enqueueAnalysis(id, expected) {
    const key = String(id);
    if (this.activeAnalyses.has(key)) return false;
    this.activeAnalyses.add(key);
    setImmediate(() =>
      this.runAnalysis(key, expected)
        .catch((failure) =>
          console.error("[ResponsesQuiz] background analysis failed", failure)
        )
        .finally(() => this.activeAnalyses.delete(key))
    );
    return true;
  }

  async runGeneration(id, expected) {
    let { state } = await this.stateFor(id, requestBodyForScope(expected));
    if (state.quiz.generationPhase === "planning") {
      try {
        const { plan } = await extractQuizPlan({
          userRequest: state.prompt,
          workspaceSlug: state.workspace?.slug,
        });
        const { evidenceChunks, sourceRefs, evidenceMode } =
          await retrieveQuizEvidence({
            workspace: state.workspace,
            plan,
            nodeContext: state.nodeContext || null,
          });
        const jobs = allocateQuestionGeneration({
          plan,
          evidenceChunks,
          evidenceMode,
        });
        if (!jobs.length) throw error("quiz_no_generation_jobs", 409);
        const prepared = await this.repository.mutate(id, (current) => {
          if (current.quiz.abandoned || current.quiz.submitted) return null;
          const next = assembleQuiz({
            quizId: current.quiz.id,
            plan,
            evidenceChunks,
            evidenceMode,
            sourceRefs,
            jobs,
            questions: current.quiz.questions || [],
          });
          return {
            state: {
              ...current,
              quiz: preserveState(current.quiz, {
                ...next,
                generationPhase: "generating",
              }),
            },
            status: "generating",
          };
        });
        state = prepared.state;
      } catch (failure) {
        await this.repository.mutate(id, (current) => {
          if (current.quiz.abandoned || current.quiz.submitted) return null;
          const quiz = {
            ...current.quiz,
            generationPhase: "failed",
            pendingTypes: [],
            failedTypes: [
              ...new Set([...(current.quiz.failedTypes || []), "planning"]),
            ],
            errors: [
              ...(current.quiz.errors || []),
              {
                type: "planning",
                message: failure.message || "quiz_planning_failed",
              },
            ],
            generationStatus: {
              ...(current.quiz.generationStatus || {}),
              status: "failed",
            },
          };
          return { state: { ...current, quiz }, status: "failed" };
        });
        throw failure;
      }
    }
    await this.runPending(id, expected);
  }

  async runPending(id, expected) {
    const { state } = await this.stateFor(id, requestBodyForScope(expected));
    const jobs = pendingJobs(state.quiz);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(BACKGROUND_CONCURRENCY, jobs.length) },
      async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          try {
            const result = await runGenerationJob(job);
            await this.repository.mutate(id, (current) => {
              const quiz = current.quiz;
              if (quiz.abandoned || quiz.submitted) return null;
              const questions = mergeQuestions(
                quiz.questions || [],
                result.questions || []
              );
              const next = assembleQuiz({
                quizId: quiz.id,
                plan: quiz.plan,
                evidenceChunks: quiz.evidenceChunks || [],
                evidenceMode: quiz.evidenceMode,
                sourceRefs: quiz.sourceRefs || [],
                jobs: quiz.generationStatus?.jobs || [],
                questions,
                failedTypes: quiz.failedTypes || [],
                errors: quiz.errors || [],
              });
              const merged = preserveState(quiz, next);
              return {
                state: { ...current, quiz: merged },
                status: quizStatus(merged),
              };
            });
          } catch (failure) {
            await this.repository.mutate(id, (current) => {
              const quiz = current.quiz;
              if (quiz.abandoned || quiz.submitted) return null;
              const failedTypes = [
                ...new Set([...(quiz.failedTypes || []), job.type]),
              ];
              const errors = [
                ...(quiz.errors || []),
                {
                  type: job.type,
                  message: failure.message || "generation_failed",
                },
              ];
              const next = assembleQuiz({
                quizId: quiz.id,
                plan: quiz.plan,
                evidenceChunks: quiz.evidenceChunks || [],
                evidenceMode: quiz.evidenceMode,
                sourceRefs: quiz.sourceRefs || [],
                jobs: quiz.generationStatus?.jobs || [],
                questions: quiz.questions || [],
                failedTypes,
                errors,
              });
              const merged = preserveState(quiz, next);
              return {
                state: { ...current, quiz: merged },
                status: quizStatus(merged),
              };
            });
          }
        }
      }
    );
    await Promise.all(workers);
    await this.repository.mutate(id, (current) => {
      const quiz = current.quiz;
      if (quiz.abandoned || quiz.submitted) return null;
      const status = quizStatus(quiz);
      if ((quiz.pendingTypes || []).length > 0) return null;
      return {
        state: {
          ...current,
          quiz: {
            ...quiz,
            generationPhase: status === "ready" ? "ready" : "failed",
            generationStatus: {
              ...(quiz.generationStatus || {}),
              status,
            },
          },
        },
        status,
      };
    });
  }

  async status(id, body = {}) {
    const { state, expected } = await this.stateFor(id, body);
    if (state.quiz.submitted && state.quiz.analysisStatus === "running") {
      this.enqueueAnalysis(id, expected);
    } else if (needsGeneration(state.quiz)) {
      this.enqueue(id, expected);
    }
    return publicResult(state.quiz);
  }

  async progress(id, body = {}) {
    const expected = scope(body);
    authorize(await this.repository.find(id), expected);
    const { state } = await this.repository.mutate(id, (current) => {
      if (current.quiz.abandoned) throw error("quiz_abandoned", 409);
      if (current.quiz.submitted) throw error("quiz_already_submitted", 409);
      const previousVersion = Number(
        current.quiz.progress?.progressVersion || 0
      );
      const currentIndex = Number.isFinite(Number(body.currentIndex))
        ? Number(body.currentIndex)
        : 0;
      const updatedAt = new Date().toISOString();
      const quiz = {
        ...current.quiz,
        answers: body.answers || {},
        currentIndex,
        progress: {
          answers: body.answers || {},
          currentIndex,
          progressVersion: previousVersion + 1,
          updatedAt,
        },
        progressUpdatedAt: updatedAt,
      };
      return { state: { ...current, quiz }, status: quizStatus(quiz) };
    });
    return { success: true, quiz: publicQuiz(state.quiz) };
  }

  async abandon(id, body = {}) {
    const expected = scope(body);
    authorize(await this.repository.find(id), expected);
    const { state } = await this.repository.mutate(id, (current) => {
      if (current.quiz.submitted) throw error("quiz_already_submitted", 409);
      const quiz = {
        ...current.quiz,
        abandoned: true,
        abandonedAt: new Date().toISOString(),
        submitted: false,
        pendingTypes: [],
        analysisStatus: "abandoned",
        generationStatus: {
          ...(current.quiz.generationStatus || {}),
          status: "abandoned",
        },
      };
      return { state: { ...current, quiz }, status: "abandoned" };
    });
    return { success: true, quiz: publicQuiz(state.quiz) };
  }

  async submit(id, body = {}) {
    const { state, expected } = await this.stateFor(id, body);
    if (state.quiz.abandoned) throw error("quiz_abandoned", 409);
    if ((state.quiz.pendingTypes || []).length)
      throw error("quiz_generation_still_running", 409);
    if (state.quiz.submitted) {
      let submittedState = state;
      if (state.quiz.analysisStatus === "failed") {
        const retried = await this.repository.mutate(id, (current) => ({
          state: {
            ...current,
            quiz: {
              ...current.quiz,
              analysisStatus: "running",
              analysisError: null,
              analysisStartedAt: new Date().toISOString(),
            },
          },
          status: "submitted",
        }));
        submittedState = retried.state;
      }
      if (submittedState.quiz.analysisStatus === "running")
        this.enqueueAnalysis(id, expected);
      return {
        success: true,
        accepted: true,
        analysis: submittedState.quiz.analysis || "",
        analysisStatus: submittedState.quiz.analysisStatus,
        quiz: publicQuiz(submittedState.quiz),
      };
    }

    const answers = body.answers || {};
    const { state: sealed } = await this.repository.mutate(id, (current) => {
      if (current.quiz.submitted) return null;
      const { questionResults, quickGrade } = gradeSelectionQuestions({
        quiz: current.quiz,
        answers,
        attemptId: id,
      });
      const quiz = {
        ...current.quiz,
        submitted: true,
        submittedAt: new Date().toISOString(),
        answers,
        partialQuizSubmitted: (current.quiz.failedTypes || []).length > 0,
        attemptId: id,
        questionResults,
        quickGrade,
        score: null,
        accuracy: null,
        questionResultsReliable: false,
        questionResultsParseError: null,
        analysisStatus: "running",
        analysisError: null,
        analysisStartedAt: new Date().toISOString(),
      };
      return { state: { ...current, quiz }, status: "submitted" };
    });

    this.enqueueAnalysis(id, expected);
    return {
      success: true,
      accepted: true,
      analysis: sealed.quiz.analysis || "",
      analysisStatus: sealed.quiz.analysisStatus,
      quickGrade: sealed.quiz.quickGrade,
      quiz: publicQuiz(sealed.quiz),
    };
  }

  async runAnalysis(id, expected) {
    const { state } = await this.stateFor(id, requestBodyForScope(expected));
    if (!state.quiz.submitted || state.quiz.analysisStatus !== "running")
      return;
    const answers = state.quiz.answers || {};
    let result;
    try {
      result = await analyzeQuizResults({ quiz: state.quiz, answers });
    } catch (failure) {
      await this.repository.mutate(id, (current) => {
        if (
          !current.quiz.submitted ||
          current.quiz.analysisStatus !== "running"
        )
          return null;
        return {
          state: {
            ...current,
            quiz: {
              ...current.quiz,
              analysisStatus: "failed",
              analysisError: failure.message || "quiz_analysis_failed",
              analysisCompletedAt: new Date().toISOString(),
            },
          },
          status: "submitted",
        };
      });
      throw failure;
    }

    const { state: analyzed } = await this.repository.mutate(id, (current) => {
      if (
        current.quiz.abandoned ||
        !current.quiz.submitted ||
        current.quiz.analysisStatus !== "running"
      )
        return null;
      const questionResults = mergeFinalQuestionResults({
        attemptId: id,
        quiz: current.quiz,
        structuredResults: result.structuredResults || [],
      });
      const scored = scoreResults(questionResults);
      const quiz = {
        ...current.quiz,
        analysis: result.text || "",
        analysisMetrics: result.metrics || {},
        analysisStatus: "completed",
        analysisError: null,
        analysisCompletedAt: new Date().toISOString(),
        structuredResults: result.structuredResults || [],
        questionResultsReliable: result.questionResultsReliable === true,
        questionResultsParseError: result.questionResultsParseError || null,
        questionResults,
        ...scored,
      };
      return { state: { ...current, quiz }, status: "submitted" };
    });
    return {
      success: true,
      quiz: publicQuiz(analyzed.quiz),
      analysis: analyzed.quiz.analysis || "",
    };
  }

  async wrongQuestions(id, body = {}) {
    const expected = scope(body);
    authorize(await this.repository.find(id), expected);
    const { state } = await this.repository.mutate(id, (current) => {
      const quiz = current.quiz;
      if (!quiz.submitted) throw error("quiz_not_submitted", 409);
      if (quiz.questionResultsReliable !== true)
        throw error("quiz_question_results_unreliable", 409);
      const ids = (quiz.questionResults || [])
        .filter((item) => item.isCorrect === false)
        .map((item) => item.questionId);
      const next = {
        ...quiz,
        wrongQuestionIds: ids,
        wrongQuestionsSaved: true,
        wrongQuestionCount: ids.length,
        wrongQuestionsSavedAt: new Date().toISOString(),
      };
      return { state: { ...current, quiz: next }, status: "submitted" };
    });
    return {
      success: true,
      count: state.quiz.wrongQuestionCount,
      quiz: publicQuiz(state.quiz),
    };
  }

  async dismissWrongQuestions(id, body = {}) {
    const expected = scope(body);
    authorize(await this.repository.find(id), expected);
    const { state } = await this.repository.mutate(id, (current) => {
      const quiz = current.quiz;
      if (!quiz.submitted) throw error("quiz_not_submitted", 409);
      const next = {
        ...quiz,
        wrongQuestionsDismissed: true,
        wrongQuestionsDismissedAt: new Date().toISOString(),
      };
      return { state: { ...current, quiz: next }, status: "submitted" };
    });
    return { success: true, quiz: publicQuiz(state.quiz) };
  }

  async favorite(id, body = {}, favorited = true) {
    const expected = scope(body);
    authorize(await this.repository.find(id), expected);
    const questionId = String(body.questionId || "").trim();
    if (!questionId) throw error("quiz_question_required", 400);
    const { state } = await this.repository.mutate(id, (current) => {
      const quiz = current.quiz;
      if (!quiz.submitted) throw error("quiz_not_submitted", 409);
      if (!(quiz.questions || []).some((item) => item.id === questionId))
        throw error("quiz_question_not_found", 404);
      const ids = new Set(quiz.favoritedQuestionIds || []);
      if (favorited) ids.add(questionId);
      else ids.delete(questionId);
      const next = {
        ...quiz,
        favoritedQuestionIds: [...ids],
        questions: favoriteQuestions(
          quiz.questions || [],
          questionId,
          favorited
        ),
      };
      return { state: { ...current, quiz: next }, status: "submitted" };
    });
    return { success: true, quiz: publicQuiz(state.quiz) };
  }

  async history(body = {}) {
    const expected = scope(body);
    const rows = await this.repository.list(expected);
    const history = [];
    for (const row of rows) {
      const state = await this.repository.read(row);
      if (!state?.quiz || !state?.prompt) continue;
      const quiz = publicQuiz(state.quiz);
      const sentAt = Math.floor(
        new Date(state.createdAt || row.createdAt).getTime() / 1000
      );
      history.push(
        {
          role: "user",
          content: state.prompt,
          sentAt,
          chatId: row.id,
          clientTurnId: state.clientTurnId || null,
          attachments: [],
        },
        {
          type: "quiz",
          role: "assistant",
          content: quiz.analysis || quizResponseText(quiz),
          sources: quiz.sourceRefs || [],
          sentAt,
          chatId: row.id,
          clientTurnId: state.clientTurnId || null,
          outputs: quizOutput(quiz),
          metrics: {
            requested_protocol: "responses",
            effective_protocol: "responses",
          },
        }
      );
    }
    return { success: true, history };
  }
}

module.exports = {
  BACKGROUND_CONCURRENCY,
  ResponsesQuizRuntime,
  authorize,
  pendingJobs,
  quizStatus,
  requestBodyForScope,
  scope,
};
