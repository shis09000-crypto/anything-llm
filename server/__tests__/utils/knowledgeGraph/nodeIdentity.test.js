const {
  buildNodeKey,
  isStableNodeKey,
  nodeKeyCandidates,
  parseNodeKey,
} = require("../../../utils/knowledgeGraph/nodeIdentity");

describe("nodeIdentity", () => {
  it("builds stable kg-prefixed node keys", () => {
    expect(
      buildNodeKey({
        entityType: "Person",
        canonicalKey: "  Plato / Theory  ",
      })
    ).toBe("kg:person:plato-theory");
  });

  it("parses legacy keys while offering canonical candidates", () => {
    expect(parseNodeKey("person:thales")).toEqual(
      expect.objectContaining({
        source: "kg",
        entityType: "person",
        canonicalKey: "thales",
        legacy: true,
      })
    );
    expect(nodeKeyCandidates("person:thales")).toContain("kg:person:thales");
    expect(isStableNodeKey("kg:concept:theory-of-forms")).toBe(true);
  });
});
