const {
  pendingJobsForQuiz,
  visibleAndDeferredQuestions,
  QUIZ_BACKGROUND_GENERATION_CONCURRENCY,
} = require("../../../utils/quiz/orchestrator");

const evidenceChunks = [
  {
    id: "evidence-1",
    text: "Evidence",
    score: 1,
    sourceRef: { id: "evidence-1", title: "Doc" },
  },
];

const plan = {
  topic: "Topic",
  keywords: [],
  difficulty: "high",
  totalQuestions: 3,
  questionTypeCounts: {
    single_choice: 1,
    multiple_choice: 1,
    fill_blank: 1,
  },
};

describe("quiz background generation recovery helpers", () => {
  it("rebuilds pending background jobs from quiz plan and evidence", () => {
    const jobs = pendingJobsForQuiz({
      plan,
      evidenceChunks,
      pendingTypes: ["multiple_choice", "fill_blank"],
      failedTypes: [],
      questions: [
        {
          id: "q1",
          type: "single_choice",
        },
      ],
    });

    expect(jobs.map((job) => job.type)).toEqual([
      "multiple_choice",
      "fill_blank",
    ]);
    expect(jobs[0].evidenceChunks).toEqual(evidenceChunks);
  });

  it("does not recover abandoned or submitted quizzes", () => {
    expect(
      pendingJobsForQuiz({
        plan,
        evidenceChunks,
        pendingTypes: ["multiple_choice"],
        abandoned: true,
      })
    ).toEqual([]);
    expect(
      pendingJobsForQuiz({
        plan,
        evidenceChunks,
        pendingTypes: ["multiple_choice"],
        submitted: true,
      })
    ).toEqual([]);
  });

  it("does not rebuild already satisfied or failed jobs", () => {
    const jobs = pendingJobsForQuiz({
      plan,
      evidenceChunks,
      pendingTypes: ["multiple_choice", "fill_blank"],
      failedTypes: ["fill_blank"],
      questions: [
        {
          id: "q1",
          type: "multiple_choice",
        },
      ],
    });

    expect(jobs).toEqual([]);
  });

  it("counts deferred questions as satisfied during status recovery", () => {
    const jobs = pendingJobsForQuiz({
      plan,
      evidenceChunks,
      pendingTypes: ["multiple_choice", "fill_blank"],
      failedTypes: [],
      questions: [{ id: "q1", type: "single_choice" }],
      deferredQuestions: [{ id: "q3", type: "fill_blank" }],
    });

    expect(jobs.map((job) => job.type)).toEqual(["multiple_choice"]);
  });

  it("defers later question types until earlier pending types finish", () => {
    const result = visibleAndDeferredQuestions({
      quiz: {
        plan,
        generationStatus: {
          jobs: [
            { type: "single_choice", count: 1 },
            { type: "multiple_choice", count: 1 },
            { type: "fill_blank", count: 1 },
          ],
        },
        questions: [{ id: "q1", type: "single_choice" }],
        pendingTypes: ["multiple_choice", "fill_blank"],
        failedTypes: [],
      },
      incoming: [{ id: "q3", type: "fill_blank" }],
    });

    expect(result.visible.map((question) => question.id)).toEqual(["q1"]);
    expect(result.deferred.map((question) => question.id)).toEqual(["q3"]);
  });

  it("releases deferred later questions when an earlier type fails", () => {
    const result = visibleAndDeferredQuestions({
      quiz: {
        plan,
        generationStatus: {
          jobs: [
            { type: "single_choice", count: 1 },
            { type: "multiple_choice", count: 1 },
            { type: "fill_blank", count: 1 },
          ],
        },
        questions: [{ id: "q1", type: "single_choice" }],
        deferredQuestions: [{ id: "q3", type: "fill_blank" }],
        failedTypes: ["multiple_choice"],
      },
    });

    expect(result.visible.map((question) => question.id)).toEqual(["q1", "q3"]);
    expect(result.deferred).toEqual([]);
  });

  it("uses conservative background generation concurrency", () => {
    expect(QUIZ_BACKGROUND_GENERATION_CONCURRENCY).toBe(2);
  });
});
