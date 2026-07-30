/* eslint-env jest */

const { projectFlows } = require("../../utils/operations/flowProjection");

describe("Operations flow projection", () => {
  test("correlates an approved private-account tool flow across modules", () => {
    const base = {
      sensitivity: "metadata_only",
      severity: "info",
      correlation: {
        operationId: "operation-crypto",
        invocationId: "invocation-1",
        toolCallId: "tool-call-1",
      },
    };
    const result = projectFlows([
      {
        ...base,
        eventId: "1",
        eventType: "agent.invocation_created",
        category: "agent",
        outcome: "started",
        occurredAt: "2026-07-31T00:00:00.000Z",
        subject: { component: "agent-runtime" },
      },
      {
        ...base,
        eventId: "2",
        eventType: "approval.resolved",
        category: "agent_tool",
        outcome: "approved",
        occurredAt: "2026-07-31T00:00:01.000Z",
        subject: { component: "tool-runtime" },
      },
      {
        ...base,
        eventId: "3",
        eventType: "crypto.account.read.completed",
        category: "crypto-account-access",
        outcome: "completed",
        occurredAt: "2026-07-31T00:00:02.000Z",
        subject: { component: "crypto-account-access" },
      },
    ]);

    expect(result).toMatchObject({
      summary: { total: 1, completed: 1, failed: 0, successful: 1 },
      flows: [
        {
          correlationKey: "operationId:operation-crypto",
          kind: "crypto-account",
          status: "completed",
          durationMs: 2000,
          effectiveness: {
            terminalObserved: true,
            successful: true,
            metadataOnly: true,
          },
        },
      ],
    });
    expect(result.flows[0].modules).toEqual(
      expect.arrayContaining([
        "agent-runtime",
        "tool-runtime",
        "crypto-account-access",
      ])
    );
  });
});
