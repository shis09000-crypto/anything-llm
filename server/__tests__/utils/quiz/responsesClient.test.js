const mockRequestInternalService = jest.fn();

jest.mock("../../../utils/microModules", () => ({
  requestInternalService: mockRequestInternalService,
}));

jest.mock("../../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: () => ({ workspaceThread: { get: jest.fn() } }),
}));

jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn(),
}));

const {
  generateQuiz,
  quizStatus,
} = require("../../../utils/quiz/responsesClient");

describe("Responses quiz client", () => {
  const previousUrl = process.env.ATHENA_RESPONSES_RUNTIME_URL;

  beforeAll(() => {
    process.env.ATHENA_RESPONSES_RUNTIME_URL = "https://responses-runtime:3034";
  });

  afterAll(() => {
    if (previousUrl === undefined)
      delete process.env.ATHENA_RESPONSES_RUNTIME_URL;
    else process.env.ATHENA_RESPONSES_RUNTIME_URL = previousUrl;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestInternalService.mockResolvedValue({ success: true });
  });

  it("sends quiz generation as a bounded Responses AICP task", async () => {
    const started = Date.now();
    await generateQuiz({
      workspace: { id: 28, slug: "ws" },
      message: "出十道地理题",
      clientTurnId: "turn-1",
    });

    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerModule: "athena-api",
        targetModule: "responses-runtime",
        capability: "responses.quiz.execute",
        idempotencyKey: "turn-1",
        timeoutMs: 20_000,
        coordinationContext: expect.objectContaining({
          coordinationRunId: "quiz-turn-1",
          correlationId: "turn-1",
          center: "task",
          priority: "P0",
        }),
      })
    );
    const context =
      mockRequestInternalService.mock.calls[0][0].coordinationContext;
    expect(Date.parse(context.deadlineAt)).toBeGreaterThanOrEqual(
      started + 19_000
    );
  });

  it("does not inherit an expired context for quiz status", async () => {
    await quizStatus({
      workspace: { id: 28, slug: "ws" },
      quizId: "ath_quiz_1",
    });

    expect(mockRequestInternalService.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        url: expect.stringContaining("/ath_quiz_1/status"),
        coordinationContext: expect.objectContaining({
          deadlineAt: expect.any(String),
        }),
      })
    );
  });
});
