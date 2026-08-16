/* eslint-env jest */

const mockRequestInternalService = jest.fn(async () => ({ success: true }));

jest.mock("../../../utils/microModules/internalClient", () => ({
  requestInternalService: mockRequestInternalService,
}));

const {
  finalizeAgentChatTurn,
  remoteAgentChatPersistenceEnabled,
  reserveAgentChatTurn,
} = require("../../../utils/agents/agentChatPersistenceClient");

describe("agentChatPersistenceClient", () => {
  const env = {
    ATHENA_RUNTIME_ROLE: "agent-runtime",
    ATHENA_CHAT_RUNTIME_URL: "https://chat-runtime.test:3016/",
  };

  beforeEach(() => mockRequestInternalService.mockClear());

  test("is enabled only for the extracted Agent Runtime", () => {
    expect(remoteAgentChatPersistenceEnabled(env)).toBe(true);
    expect(
      remoteAgentChatPersistenceEnabled({
        ...env,
        ATHENA_RUNTIME_ROLE: "api",
      })
    ).toBe(false);
  });

  test("reserves and finalizes through declared Chat Runtime contracts", async () => {
    await reserveAgentChatTurn({ clientTurnId: "turn-1" }, env);
    await finalizeAgentChatTurn({ chatId: 7, clientTurnId: "turn-1" }, env);

    expect(mockRequestInternalService).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        callerModule: "agent-runtime",
        targetModule: "chat-runtime",
        capability: "chat.agent-turn.reserve",
        url: "https://chat-runtime.test:3016/internal/v1/chat/agent-turns/reserve",
        idempotencyKey: "turn-1",
      })
    );
    expect(mockRequestInternalService).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        capability: "chat.agent-turn.finalize",
        url: "https://chat-runtime.test:3016/internal/v1/chat/agent-turns/finalize",
        idempotencyKey: "turn-1",
      })
    );
  });
});
