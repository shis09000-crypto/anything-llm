/* global describe, test, expect */

const {
  completedResponseText,
} = require("../../utils/responsesRuntime/agentAdapter");

describe("Responses Runtime Agent terminal text", () => {
  test("uses the completed response when compatible streams omit deltas", () => {
    expect(
      completedResponseText("", {
        type: "response.completed",
        response: { output_text: "FLASH terminal reply" },
      })
    ).toBe("FLASH terminal reply");
  });

  test("reconciles partial deltas to the authoritative completed response", () => {
    expect(
      completedResponseText("FLASH partial", {
        type: "response.completed",
        response: { output_text: "FLASH partial reply" },
      })
    ).toBe("FLASH partial reply");
  });

  test("keeps accumulated deltas when no terminal output is provided", () => {
    expect(completedResponseText("FLASH streamed reply", {})).toBe(
      "FLASH streamed reply"
    );
  });
});
