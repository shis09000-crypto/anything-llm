const { pendingJobsForQuiz } = require("../../../utils/quiz/orchestrator");

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
});
