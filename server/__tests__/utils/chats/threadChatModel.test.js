const {
  THREAD_CHAT_MODELS,
  isSupportedThreadChatModel,
  resolveThreadChatModel,
  workspaceWithThreadChatModel,
} = require("../../../utils/chats/threadChatModel");

describe("thread chat model", () => {
  it("accepts only the two native thread models", () => {
    expect(isSupportedThreadChatModel(THREAD_CHAT_MODELS.flash)).toBe(true);
    expect(isSupportedThreadChatModel(THREAD_CHAT_MODELS.pro)).toBe(true);
    expect(isSupportedThreadChatModel("gpt-5")).toBe(false);
    expect(isSupportedThreadChatModel(null)).toBe(false);
  });

  it("prefers the thread model over the workspace model", () => {
    expect(
      resolveThreadChatModel(
        { chatModel: THREAD_CHAT_MODELS.pro },
        { chatModel: THREAD_CHAT_MODELS.flash }
      )
    ).toBe(THREAD_CHAT_MODELS.flash);
  });

  it("falls back through workspace model to pro", () => {
    expect(
      resolveThreadChatModel({ chatModel: THREAD_CHAT_MODELS.flash }, {})
    ).toBe(THREAD_CHAT_MODELS.flash);
    expect(resolveThreadChatModel({ chatModel: "unsupported" }, {})).toBe(
      THREAD_CHAT_MODELS.pro
    );
  });

  it("creates an effective workspace without mutating the source", () => {
    const workspace = { id: 1, chatModel: THREAD_CHAT_MODELS.pro };
    const effective = workspaceWithThreadChatModel(workspace, {
      chatModel: THREAD_CHAT_MODELS.flash,
    });
    expect(effective.chatModel).toBe(THREAD_CHAT_MODELS.flash);
    expect(workspace.chatModel).toBe(THREAD_CHAT_MODELS.pro);
  });
});
