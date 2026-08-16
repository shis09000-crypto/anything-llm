const path = require("path");

const streamModulePath = path.resolve(
  __dirname,
  "../../../utils/chats/stream.js"
);

function loadStreamModule({ bypass }) {
  jest.resetModules();
  jest.doMock("../../../utils/dataAccess/lazyFacade", () => ({
    lazyDataAccessFacade: () => ({}),
    lazyDataAccessProperty: () => ({}),
  }));
  jest.doMock("../../../utils/helpers", () => ({
    getLLMProvider: jest.fn(() => ({})),
    getVectorDbClass: jest.fn(() => {
      throw new Error("vector_db_should_not_initialize");
    }),
  }));
  jest.doMock("../../../utils/chats/agents", () => ({
    grepAgents: jest.fn(async () => true),
  }));
  jest.doMock("../../../utils/chats", () => ({
    grepCommand: jest.fn(async (message) => message),
    VALID_COMMANDS: {},
    chatPrompt: jest.fn(async () => ""),
    sourceIdentifier: jest.fn(),
    cacheStableHistoryStrategyFor: jest.fn(),
  }));
  jest.doMock("../../../utils/chats/automaticAgentRouting", () => ({
    shouldBypassAutomaticAgentRouting: jest.fn(() => bypass),
  }));
  jest.doMock(
    "../../../utils/chats/hotTurnBuffer",
    () => ({
      finalizedTurnPersister: {},
      hotTurnBuffer: {},
      scopeKey: jest.fn(),
    }),
    { virtual: true }
  );
  return require(streamModulePath);
}

describe("social chat fast path", () => {
  it("does not initialize the vector database for a short social message", async () => {
    const { streamChatWithWorkspace } = loadStreamModule({ bypass: true });
    const response = { on: jest.fn() };

    await expect(
      streamChatWithWorkspace(
        response,
        { id: 1, slug: "social", chatMode: "automatic" },
        "哈咯",
        "automatic",
        { id: 1 },
        null,
        []
      )
    ).resolves.toBeUndefined();

    const { getVectorDbClass } = require("../../../utils/helpers");
    expect(getVectorDbClass).not.toHaveBeenCalled();
  });
});
