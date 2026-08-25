const {
  normalizeTurnContext,
  ResponsesTurnProjector,
} = require("../../utils/responsesTurn/runtime");
const {
  planReadOnlyFunctions,
} = require("../../utils/responsesTurn/planToolPolicy");

describe("Responses turn goal and plan contract", () => {
  test("normalizes goal and one-turn plan metadata", () => {
    expect(
      normalizeTurnContext({
        mode: "plan",
        goal: {
          action: "replace",
          goalId: "goal-old",
          expectedActiveGoalId: "goal-old",
        },
      })
    ).toEqual({
      mode: "plan",
      goal: {
        action: "replace",
        goalId: "goal-old",
        expectedActiveGoalId: "goal-old",
      },
      plan: { action: "create", planId: null },
    });
    expect(() => normalizeTurnContext({ mode: "execute" })).toThrow(
      "turn_mode_invalid"
    );
  });

  test("accepts persisted plan revision and execution actions", () => {
    expect(
      normalizeTurnContext({
        mode: "plan",
        plan: { action: "revise", planId: "plan-1" },
      })
    ).toMatchObject({
      mode: "plan",
      plan: { action: "revise", planId: "plan-1" },
    });
    expect(
      normalizeTurnContext({
        mode: "normal",
        plan: { action: "execute", planId: "plan-1" },
      })
    ).toMatchObject({
      mode: "normal",
      plan: { action: "execute", planId: "plan-1" },
    });
    expect(() =>
      normalizeTurnContext({
        mode: "plan",
        plan: { action: "execute", planId: "plan-1" },
      })
    ).toThrow("plan_execute_mode_invalid");
  });

  test("closes plan mode to explicitly read-only tools", () => {
    expect(
      planReadOnlyFunctions([
        "workspace_search",
        "web-browsing",
        "shell",
        "save-file-to-browser",
        "unknown-tool",
      ])
    ).toEqual(["workspace_search", "web-browsing"]);
  });

  test("publishes the durable identity and composer metadata immediately", () => {
    const events = [];
    new ResponsesTurnProjector({
      responseId: "ath_resp_test",
      clientTurnId: "turn-1",
      metadata: {
        requestedModel: "deepseek-v4-flash",
        effectiveModel: "vision-live",
        turnMode: "plan",
        goalId: "goal-1",
      },
      emit: (event) => events.push(event),
    });
    expect(events[0]).toMatchObject({
      type: "response.created",
      sequence_number: 1,
      response_id: "ath_resp_test",
      response: {
        metadata: {
          clientTurnId: "turn-1",
          requestedModel: "deepseek-v4-flash",
          effectiveModel: "vision-live",
          turnMode: "plan",
          goalId: "goal-1",
        },
      },
    });
    expect(events[1].sequence_number).toBe(2);
  });
});
