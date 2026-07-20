const mockGovernance = {
  reserve: jest.fn(),
  settle: jest.fn(),
  release: jest.fn(),
};

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: { aiGovernance: mockGovernance },
}));

const {
  beginModelExecution,
  estimatedTokens,
} = require("../../utils/aiGovernance");

describe("ModelExecutionContext", () => {
  const originalMode = process.env.ATHENA_AI_GOVERNANCE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ATHENA_AI_GOVERNANCE = "observe";
    mockGovernance.reserve.mockResolvedValue({
      mode: "observe",
      reservation: { id: "reservation-1" },
    });
    mockGovernance.settle.mockResolvedValue({ id: "usage-1" });
    mockGovernance.release.mockResolvedValue({ count: 1 });
  });

  afterAll(() => {
    if (originalMode === undefined) delete process.env.ATHENA_AI_GOVERNANCE;
    else process.env.ATHENA_AI_GOVERNANCE = originalMode;
  });

  it("reserves before execution and settles exactly once", async () => {
    const execution = await beginModelExecution(
      {
        ownerType: "workspace",
        ownerId: "10",
        taskType: "workspace_chat",
        provider: "test",
        model: "model",
      },
      { messages: [{ role: "user", content: "hello" }] }
    );
    expect(mockGovernance.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "10",
        inputTokens: expect.any(Number),
        outputTokens: 2048,
        durationMs: 120000,
      })
    );
    await execution.settle({ prompt_tokens: 4 }, { transport: "test" });
    await execution.settle({ prompt_tokens: 4 });
    expect(mockGovernance.settle).toHaveBeenCalledTimes(1);
    expect(mockGovernance.release).not.toHaveBeenCalled();
  });

  it("releases a failed reservation exactly once", async () => {
    const execution = await beginModelExecution(
      { taskType: "workspace_chat" },
      { inputTokens: 2 }
    );
    const error = new Error("provider failed");
    await execution.fail(error);
    await execution.fail(error);
    expect(mockGovernance.release).toHaveBeenCalledTimes(1);
  });

  it("uses a deterministic bounded input estimate", () => {
    expect(estimatedTokens([{ role: "user", content: "12345678" }])).toBe(9);
  });
});
