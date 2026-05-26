const {
  QUIZ_SCHEMA_VERSION,
  hydrateQuiz,
  normalizeQuizSnapshot,
  publicQuiz,
  snapshotFromQuiz,
} = require("../../../utils/quiz/snapshot");

describe("quiz snapshot compatibility", () => {
  const legacyQuiz = {
    id: "quiz-1",
    title: "Topic",
    plan: { topic: "Topic", difficulty: "high" },
    questions: [],
    pendingTypes: ["multiple_choice"],
    evidenceChunks: [
      {
        id: "evidence-1",
        text: "large private evidence text",
        sourceRef: { id: "evidence-1", title: "Doc" },
      },
    ],
    answers: { q1: "A" },
    currentIndex: 2,
  };

  it("normalizes legacy payloads to quiz-v1", () => {
    const snapshot = normalizeQuizSnapshot(legacyQuiz);

    expect(snapshot.schemaVersion).toBe(QUIZ_SCHEMA_VERSION);
    expect(snapshot.publicPayload.schemaVersion).toBe(QUIZ_SCHEMA_VERSION);
    expect(snapshot.publicPayload.state).toBe("generating");
    expect(snapshot.publicPayload.progress).toEqual(
      expect.objectContaining({
        answers: { q1: "A" },
        currentIndex: 2,
      })
    );
  });

  it("keeps evidence chunks out of public payload", () => {
    const snapshot = snapshotFromQuiz(legacyQuiz);

    expect(snapshot.publicPayload.evidenceChunks).toBeUndefined();
    expect(publicQuiz(snapshot).evidenceChunks).toBeUndefined();
    expect(snapshot.privateState.evidenceChunks[0].text).toContain("private");
  });

  it("hydrates server-side quiz state with private evidence", () => {
    const snapshot = snapshotFromQuiz(legacyQuiz);
    const quiz = hydrateQuiz(snapshot);

    expect(quiz.evidenceChunks).toHaveLength(1);
    expect(quiz.schemaVersion).toBe(QUIZ_SCHEMA_VERSION);
  });
});
