const {
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  REQUEST_USER_INPUT_TOOL_EXECUTION_TIMEOUT_MS,
  REQUEST_USER_INPUT_TOOL_NAME,
  toolExecutionTimeoutMs,
} = require("../../../utils/agents/aibitat/toolTimeouts");

describe("AIbitat tool timeouts", () => {
  it("uses the default timeout for ordinary tools", () => {
    expect(toolExecutionTimeoutMs("shell", {})).toBe(
      DEFAULT_TOOL_EXECUTION_TIMEOUT_MS
    );
  });

  it("lets request-user-input wait for the clarification card", () => {
    expect(toolExecutionTimeoutMs(REQUEST_USER_INPUT_TOOL_NAME, {})).toBe(
      REQUEST_USER_INPUT_TOOL_EXECUTION_TIMEOUT_MS
    );
  });

  it("honors higher explicit AGENT_TOOL_TIMEOUT_MS values", () => {
    expect(
      toolExecutionTimeoutMs(REQUEST_USER_INPUT_TOOL_NAME, {
        AGENT_TOOL_TIMEOUT_MS: "190000",
      })
    ).toBe(190_000);
  });
});
