/* eslint-env jest */

const { operationsServiceReady } = require("../../utils/operations/readiness");

describe("Operations Plane service readiness", () => {
  test("stays ready while an observed module is missing", () => {
    const moduleHealth = { complete: false, missing: ["browser-egress"] };
    const coverage = { complete: false, missing: ["browser-egress"] };

    expect(
      operationsServiceReady({
        plane: { ready: true },
        infrastructureHealth: { complete: true },
        moduleHealth,
        coverage,
      })
    ).toBe(true);
  });

  test.each([[{ ready: false }], [{ ready: null }]])(
    "fails closed when its own telemetry path is unavailable",
    (plane) => {
      expect(operationsServiceReady({ plane })).toBe(false);
    }
  );

  test("does not couple readiness to unrelated infrastructure probes", () => {
    expect(
      operationsServiceReady({
        plane: { ready: true },
        infrastructureHealth: { complete: false },
      })
    ).toBe(true);
  });
});
