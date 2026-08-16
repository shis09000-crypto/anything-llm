const {
  cacheInvocationAttachments,
  cacheInvocationExecutionTarget,
  cacheInvocationFileAccess,
  clearInvocationFileAccess,
  getAndClearInvocationAttachments,
  getInvocationExecutionTarget,
  getInvocationFileAccess,
} = require("../../../utils/chats/agents");

describe("Agent invocation cache contract", () => {
  test("exports the complete cache contract consumed by Agent Runtime", () => {
    const invocationId = "invocation-cache-contract";

    expect(cacheInvocationAttachments).toEqual(expect.any(Function));
    cacheInvocationAttachments(invocationId, {
      llmAttachments: [{ name: "source.txt" }],
      displayPrompt: "hello",
    });
    cacheInvocationFileAccess(invocationId, { mode: "sandbox" });
    cacheInvocationExecutionTarget(invocationId, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    expect(getAndClearInvocationAttachments(invocationId)).toEqual(
      expect.objectContaining({
        llmAttachments: [{ name: "source.txt" }],
        displayPrompt: "hello",
      })
    );
    expect(getInvocationFileAccess(invocationId)).toEqual({ mode: "sandbox" });
    expect(getInvocationExecutionTarget(invocationId)).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });

    clearInvocationFileAccess(invocationId);
    expect(getInvocationFileAccess(invocationId)).toEqual({});
    expect(getInvocationExecutionTarget(invocationId)).toBeNull();
  });
});
