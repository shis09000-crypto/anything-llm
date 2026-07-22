/* eslint-env jest */

const {
  boundedLimit,
  filtersFromQuery,
  operationsEndpoints,
} = require("../../endpoints/operations");

describe("Operations endpoints", () => {
  test("registers every Operations Plane API behind both auth guards", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    expect(routes.map(([path]) => path)).toEqual([
      "/operations/health",
      "/operations/schemas",
      "/operations/schemas/:name/:version",
      "/operations/services",
      "/operations/agents",
      "/operations/shadow-agents",
      "/operations/evaluations/latest",
      "/operations/evaluations/corpus",
      "/operations/actions/catalog",
      "/operations/actions/runs",
      "/operations/actions/runs/:runId",
      "/operations/actions/runs",
      "/operations/actions/runs/:runId/approve",
      "/operations/actions/runs/:runId/reject",
      "/operations/actions/runs/:runId/execute",
      "/operations/actions/runs/:runId/reconcile",
      "/operations/timeline",
      "/operations/state-graph",
      "/operations/explain",
    ]);
    for (const [, guards, handler] of routes) {
      expect(guards).toHaveLength(3);
      expect(guards.every((guard) => typeof guard === "function")).toBe(true);
      expect(typeof handler).toBe("function");
    }
  });

  test("bounds timeline requests and only projects supported filters", () => {
    expect(boundedLimit("900")).toBe(500);
    expect(
      filtersFromQuery({
        eventId: "event-1",
        operationId: "operation-1",
        limit: "0",
        prompt: "must-not-pass",
      })
    ).toEqual({
      after: undefined,
      before: undefined,
      eventId: "event-1",
      eventType: undefined,
      subjectId: undefined,
      operationId: "operation-1",
      limit: 100,
    });
  });

  test("exposes only read-only shadow state and a redacted corpus manifest", () => {
    const routes = [];
    operationsEndpoints({
      get: (...args) => routes.push(args),
      post: (...args) => routes.push(args),
    });
    const invoke = (path) => {
      const route = routes.find(([candidate]) => candidate === path);
      const json = jest.fn();
      const response = { status: jest.fn(() => ({ json })) };
      route.at(-1)({}, response);
      return json.mock.calls[0][0];
    };

    const shadow = invoke("/operations/shadow-agents");
    const evaluation = invoke("/operations/evaluations/latest");
    const corpus = invoke("/operations/evaluations/corpus");

    expect(shadow).toMatchObject({
      success: true,
      mode: "shadow",
      actionPolicy: "observe_only",
      canExecuteActions: false,
    });
    expect(evaluation.report.canExecuteActions).toBe(false);
    expect(
      corpus.manifest.cases.every(
        (testCase) =>
          testCase.observations === undefined && testCase.expected === undefined
      )
    ).toBe(true);
  });
});
