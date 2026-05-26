const {
  FORMULA_VERSION,
  recommendationId,
} = require("../../../utils/workspaceOverview");

describe("workspace overview recommendations", () => {
  test("recommendationId is stable for the same target and formula version", () => {
    const input = {
      workspaceId: 1,
      type: "current_focus",
      targetType: "concept",
      targetId: "42",
    };

    expect(recommendationId(input)).toEqual(recommendationId(input));
    expect(recommendationId(input)).toHaveLength(64);
    expect(FORMULA_VERSION).toEqual("overview-rec-v1");
  });

  test("recommendationId changes when the stable target identity changes", () => {
    const base = {
      workspaceId: 1,
      type: "current_focus",
      targetType: "concept",
      targetId: "42",
    };

    expect(recommendationId(base)).not.toEqual(
      recommendationId({ ...base, targetId: "43" })
    );
    expect(recommendationId(base)).not.toEqual(
      recommendationId({ ...base, type: "evidence_gap" })
    );
    expect(recommendationId(base)).not.toEqual(
      recommendationId({ ...base, workspaceId: 2 })
    );
  });
});
