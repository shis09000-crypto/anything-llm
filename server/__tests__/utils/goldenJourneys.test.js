/* eslint-env jest */

const {
  GOLDEN_JOURNEYS,
  classifyGoldenJourney,
  requirementsForJourney,
} = require("../../utils/observability/goldenJourneys");
const {
  correlationCoverage,
  runWithOperationContext,
} = require("../../utils/observability/operationContext");

describe("golden journey correlation", () => {
  test.each([
    ["POST", "/api/request-token", GOLDEN_JOURNEYS.login],
    [
      "POST",
      "/api/auth/session/recovery/finish",
      GOLDEN_JOURNEYS.login,
    ],
    ["POST", "/api/workspace/a/stream-chat", GOLDEN_JOURNEYS.chat],
    [
      "POST",
      "/api/workspace/a/upload-and-embed",
      GOLDEN_JOURNEYS.knowledgeIngest,
    ],
    ["GET", "/api/sync/events/replay", GOLDEN_JOURNEYS.crossDeviceSync],
  ])("classifies %s %s", (method, path, journey) => {
    expect(classifyGoldenJourney({ method, path })).toBe(journey);
  });

  test("all five critical flows exceed the 95 percent correlation gate", () => {
    const contexts = {
      login: { requestId: "r1", interactionId: "i1" },
      chat: { requestId: "r2", clientTurnId: "c2" },
      agent_tool: { invocationId: "a3", toolCallId: "t3" },
      knowledge_ingest: { requestId: "r4" },
      cross_device_sync: { requestId: "r5", clientId: "c5" },
    };
    const results = Object.entries(contexts).map(([journey, values], index) =>
      runWithOperationContext(
        {
          operationId: `op-${index}`,
          traceId: String(index + 1).repeat(32),
          journey,
          ...values,
        },
        () => correlationCoverage(requirementsForJourney(journey)).complete
      )
    );
    const coverage = results.filter(Boolean).length / results.length;
    expect(coverage).toBeGreaterThanOrEqual(0.95);
    expect(coverage).toBe(1);
  });
});
