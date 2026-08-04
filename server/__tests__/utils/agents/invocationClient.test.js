const mockRequestInternalService = jest.fn();

jest.mock("../../../utils/microModules", () => ({
  requestInternalService: mockRequestInternalService,
}));

const {
  createRemoteAgentInvocation,
  remoteAgentInvocationEnabled,
} = require("../../../utils/agents/invocationClient");

describe("Chat to Agent invocation client", () => {
  const env = {
    ATHENA_RUNTIME_ROLE: "chat-runtime",
    ATHENA_RUNTIME_TOPOLOGY: "micro-modules",
    ATHENA_AGENT_RUNTIME_URL: "https://agent-runtime.test:3017",
  };

  beforeEach(() => jest.clearAllMocks());

  test("only enables the remote boundary in distributed Chat Runtime", () => {
    expect(remoteAgentInvocationEnabled(env)).toBe(true);
    expect(
      remoteAgentInvocationEnabled({ ...env, ATHENA_RUNTIME_ROLE: "api" })
    ).toBe(false);
  });

  test("submits the minimal idempotent agent contract", async () => {
    mockRequestInternalService.mockResolvedValue({
      success: true,
      invocation: { uuid: "invocation-1", clientTurnId: "turn-1" },
      replayed: false,
    });
    await expect(
      createRemoteAgentInvocation(
        {
          prompt: "hello",
          workspace: {
            id: 4,
            name: "not-forwarded",
            chatProvider: "deepseek",
            chatModel: "deepseek-v4-flash",
          },
          user: { id: 7, username: "not-forwarded" },
          thread: { id: 11, name: "not-forwarded" },
          clientTurnId: "turn-1",
        },
        env
      )
    ).resolves.toEqual({
      invocation: { uuid: "invocation-1", clientTurnId: "turn-1" },
      message: null,
      replayed: false,
    });
    expect(mockRequestInternalService).toHaveBeenCalledWith(
      expect.objectContaining({
        callerRole: "chat-runtime",
        targetModule: "agent-runtime",
        capability: "agent.submit",
        contractVersion: "1.0",
        url: "https://agent-runtime.test:3017/internal/v1/agent/invocations",
        idempotencyKey: "turn-1",
        body: {
          prompt: "hello",
          workspaceId: 4,
          userId: 7,
          threadId: 11,
          clientTurnId: "turn-1",
          requestedProvider: "deepseek",
          requestedModel: "deepseek-v4-flash",
        },
      })
    );
  });
});
