/* eslint-env jest */

const {
  correlationCoverage,
  currentOperationContext,
  enrichOperationContext,
  runWithOperationContext,
} = require("../../utils/observability/operationContext");

describe("OperationContext", () => {
  test("propagates and enriches stable correlation identifiers", async () => {
    await runWithOperationContext(
      {
        operationId: "op-1",
        interactionId: "interaction-1",
        requestId: "request-1",
        traceId: "1".repeat(32),
        journey: "chat",
      },
      async () => {
        enrichOperationContext({
          clientTurnId: "turn-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
        });
        expect(currentOperationContext()).toMatchObject({
          operationId: "op-1",
          clientTurnId: "turn-1",
          workspaceId: "workspace-1",
          threadId: "thread-1",
        });
        expect(correlationCoverage(["requestId", "clientTurnId"])).toEqual(
          expect.objectContaining({ complete: true, missing: [] })
        );
      }
    );
    expect(currentOperationContext()).toBeNull();
  });

  test("reports missing journey identifiers without inventing them", () =>
    runWithOperationContext(
      { operationId: "op-2", traceId: "2".repeat(32) },
      () => {
        expect(correlationCoverage(["invocationId", "toolCallId"])).toEqual(
          expect.objectContaining({
            complete: false,
            missing: ["invocationId", "toolCallId"],
          })
        );
      }
    ));
});
