jest.mock("../../utils/quiz/plan", () => ({
  draftQuizPlan: jest.fn((message = "") => ({
    topic: message.includes("历史") ? "历史" : message,
    keywords: ["历史"],
    totalQuestions: 1,
    questionTypeCounts: {
      single_choice: 1,
      multiple_choice: 0,
      fill_blank: 0,
    },
    difficulty: "high",
    searchQueries: ["历史"],
  })),
  extractQuizPlan: jest.fn().mockResolvedValue({
    plan: {
      topic: "历史",
      keywords: ["历史"],
      totalQuestions: 1,
      questionTypeCounts: {
        single_choice: 1,
        multiple_choice: 0,
        fill_blank: 0,
      },
      difficulty: "high",
      searchQueries: ["历史"],
    },
  }),
}));

jest.mock("../../utils/quiz/evidence", () => ({
  retrieveQuizEvidence: jest.fn().mockResolvedValue({
    evidenceMode: "general_knowledge",
    evidenceChunks: [
      {
        id: "general-knowledge",
        text: "model knowledge",
        sourceRef: {
          id: "general-knowledge",
          title: "模型通识",
          sourceType: "general_knowledge",
        },
      },
    ],
    sourceRefs: [
      {
        id: "general-knowledge",
        title: "模型通识",
        sourceType: "general_knowledge",
      },
    ],
  }),
}));

jest.mock("../../utils/quiz/generators", () => ({
  runGenerationJob: jest.fn().mockResolvedValue({
    questions: [
      {
        id: "history-1",
        type: "single_choice",
        question: "秦朝统一六国是哪一年？",
        options: [
          { id: "A", text: "公元前221年" },
          { id: "B", text: "公元前202年" },
          { id: "C", text: "公元前206年" },
          { id: "D", text: "公元前104年" },
        ],
        correctAnswer: "A",
        sourceRefs: ["general-knowledge"],
      },
    ],
  }),
}));

jest.mock("../../utils/quiz/analysis", () => ({
  analyzeQuizResults: jest.fn().mockResolvedValue({
    text: "# 本次测试总结\n答对 1 题。",
    metrics: { effective_protocol: "responses" },
    structuredResults: [
      {
        questionId: "history-1",
        isCorrect: true,
        score: 1,
        sourceRefs: ["general-knowledge"],
      },
    ],
    questionResultsReliable: true,
    questionResultsParseError: null,
  }),
}));

const {
  ResponsesQuizRuntime,
} = require("../../utils/responsesRuntime/quiz/runtime");

function memoryRepository() {
  const rows = new Map();
  const states = new Map();
  return {
    rows,
    states,
    nextId() {
      return "ath_quiz_test";
    },
    async create({ id, workspaceId, threadId, ownerUserId, state }) {
      const row = {
        id,
        workspaceId,
        threadId,
        ownerUserId,
        conversationType: "quiz",
        stateRevision: 0,
        status: "generating",
        createdAt: new Date("2026-08-13T00:00:00.000Z"),
      };
      rows.set(row.id, row);
      states.set(row.id, state);
      return row;
    },
    async find(id) {
      return rows.get(String(id)) || null;
    },
    async read(row) {
      return states.get(row.id) || null;
    },
    async mutate(id, updater) {
      const row = rows.get(String(id));
      if (!row) throw new Error("quiz_not_found");
      const change = await updater(states.get(row.id), row);
      if (!change) return { row, state: states.get(row.id) };
      const state = change.state || change;
      const nextRow = {
        ...row,
        stateRevision: row.stateRevision + 1,
        status: change.status || row.status,
      };
      rows.set(row.id, nextRow);
      states.set(row.id, state);
      return { row: nextRow, state };
    },
    async list({ workspaceId, threadId, ownerUserId }) {
      return [...rows.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.threadId === threadId &&
          row.ownerUserId === ownerUserId
      );
    },
  };
}

describe("Responses Runtime native quiz state", () => {
  const athena = { workspaceId: 7, threadId: 9, userId: 42 };
  const workspace = { id: 7, slug: "history" };

  test("generates and persists a quiz without workspace chat storage", async () => {
    const repository = memoryRepository();
    const runtime = new ResponsesQuizRuntime({ repository });
    runtime.enqueue = jest.fn();

    const result = await runtime.generate({
      message: "出一道历史题",
      clientTurnId: "turn-1",
      workspace,
      athena,
    });

    expect(result).toMatchObject({
      success: true,
      quizId: "ath_quiz_test",
      status: "generating",
      quiz: {
        id: "ath_quiz_test",
        evidenceMode: "pending",
        generationPhase: "planning",
      },
    });
    expect(repository.states.get("ath_quiz_test")).toMatchObject({
      prompt: "出一道历史题",
      clientTurnId: "turn-1",
      quiz: { id: "ath_quiz_test", questions: [] },
    });
  });

  test("keeps the authenticated owner when a queued generation resumes", async () => {
    const repository = memoryRepository();
    const runtime = new ResponsesQuizRuntime({ repository });
    runtime.enqueue = jest.fn();
    await runtime.generate({ message: "出一道历史题", workspace, athena });

    await runtime.runGeneration("ath_quiz_test", {
      workspaceId: athena.workspaceId,
      threadId: athena.threadId,
      ownerUserId: athena.userId,
    });

    expect(repository.states.get("ath_quiz_test").quiz).toMatchObject({
      generationPhase: "ready",
      generationStatus: { status: "ready" },
      pendingTypes: [],
    });
  });

  test("keeps progress, grading, wrong questions and favorites in Responses state", async () => {
    const repository = memoryRepository();
    const runtime = new ResponsesQuizRuntime({ repository });
    runtime.enqueue = jest.fn();
    runtime.enqueueAnalysis = jest.fn();
    await runtime.generate({ message: "出一道历史题", workspace, athena });
    await runtime.runGeneration("ath_quiz_test", athena);
    expect(repository.states.get("ath_quiz_test").quiz).toMatchObject({
      generationPhase: "ready",
      generationStatus: { status: "ready" },
      pendingTypes: [],
    });

    await runtime.progress("ath_quiz_test", {
      athena,
      answers: { "history-1": "A" },
      currentIndex: 0,
    });
    const submitted = await runtime.submit("ath_quiz_test", {
      athena,
      answers: { "history-1": "A" },
    });
    expect(submitted).toMatchObject({
      success: true,
      accepted: true,
      analysis: "",
      analysisStatus: "running",
      quickGrade: {
        gradedQuestionCount: 1,
        correctCount: 1,
        incorrectCount: 0,
      },
      quiz: {
        submitted: true,
        score: null,
        accuracy: null,
        questionResultsReliable: false,
      },
    });
    expect(runtime.enqueueAnalysis).toHaveBeenCalledWith(
      "ath_quiz_test",
      expect.objectContaining({ ownerUserId: athena.userId })
    );
    await expect(
      runtime.progress("ath_quiz_test", {
        athena,
        answers: { "history-1": "B" },
        currentIndex: 0,
      })
    ).rejects.toMatchObject({
      code: "quiz_already_submitted",
      httpStatus: 409,
    });
    expect(repository.states.get("ath_quiz_test").quiz.answers).toEqual({
      "history-1": "A",
    });

    await runtime.runAnalysis("ath_quiz_test", {
      workspaceId: athena.workspaceId,
      threadId: athena.threadId,
      ownerUserId: athena.userId,
    });
    expect(repository.states.get("ath_quiz_test").quiz).toMatchObject({
      analysis: expect.stringContaining("本次测试总结"),
      analysisStatus: "completed",
      submitted: true,
      score: 1,
      accuracy: 1,
    });

    const wrong = await runtime.wrongQuestions("ath_quiz_test", { athena });
    expect(wrong.count).toBe(0);
    const favorite = await runtime.favorite("ath_quiz_test", {
      athena,
      questionId: "history-1",
    });
    expect(favorite.quiz.favoritedQuestionIds).toEqual(["history-1"]);
    expect(repository.states.get("ath_quiz_test").quiz).toMatchObject({
      wrongQuestionsSaved: true,
      favoritedQuestionIds: ["history-1"],
    });
  });

  test("persists a user's decision not to save wrong questions", async () => {
    const repository = memoryRepository();
    const runtime = new ResponsesQuizRuntime({ repository });
    runtime.enqueue = jest.fn();
    runtime.enqueueAnalysis = jest.fn();
    await runtime.generate({ message: "出一道历史题", workspace, athena });
    await runtime.runGeneration("ath_quiz_test", athena);
    await runtime.submit("ath_quiz_test", {
      athena,
      answers: { "history-1": "B" },
    });

    const dismissed = await runtime.dismissWrongQuestions("ath_quiz_test", {
      athena,
    });

    expect(dismissed).toMatchObject({
      success: true,
      quiz: { wrongQuestionsDismissed: true },
    });
  });

  test("returns durable synthetic history and hides another user's quiz", async () => {
    const repository = memoryRepository();
    const runtime = new ResponsesQuizRuntime({ repository });
    runtime.enqueue = jest.fn();
    await runtime.generate({
      message: "出一道历史题",
      clientTurnId: "turn-1",
      workspace,
      athena,
    });
    await runtime.runGeneration("ath_quiz_test", athena);

    const result = await runtime.history({ athena });
    expect(result.history).toEqual([
      expect.objectContaining({ role: "user", chatId: "ath_quiz_test" }),
      expect.objectContaining({
        role: "assistant",
        chatId: "ath_quiz_test",
        outputs: [expect.objectContaining({ type: "QuizCard" })],
      }),
    ]);
    await expect(
      runtime.status("ath_quiz_test", {
        athena: { ...athena, userId: 99 },
      })
    ).rejects.toMatchObject({ code: "quiz_not_found", httpStatus: 404 });
  });
});
