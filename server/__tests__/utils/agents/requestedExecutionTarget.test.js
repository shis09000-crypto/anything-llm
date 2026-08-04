const {
  requestedAgentExecutionTarget,
} = require("../../../utils/agents");

describe("requested agent execution target", () => {
  test("pins the model selected when the invocation was submitted", () => {
    expect(
      requestedAgentExecutionTarget({
        requestedProvider: "deepseek",
        requestedModel: "deepseek-v4-flash",
        workspace: {
          agentProvider: "deepseek",
          agentModel: "deepseek-v4-pro",
        },
      })
    ).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
  });

  test("keeps legacy invocations on the existing fallback path", () => {
    expect(requestedAgentExecutionTarget({ requestedModel: null })).toBeNull();
  });
});
