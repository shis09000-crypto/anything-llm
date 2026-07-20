const {
  DATA_HANDLING_POLICIES,
  dataHandlingPolicy,
  dataSecurityCatalog,
} = require("../../utils/dataAccess/dataAccessPolicy");

describe("S0-S4 data security catalog", () => {
  it("gives every registered domain a complete handling policy", () => {
    expect(dataSecurityCatalog().length).toBeGreaterThan(20);
    for (const policy of Object.values(DATA_HANDLING_POLICIES)) {
      expect(policy).toEqual(
        expect.objectContaining({
          exportPolicy: expect.any(String),
          logPolicy: expect.any(String),
          defaultRetention: expect.any(String),
          residencyPolicy: expect.any(String),
          dlpPolicy: expect.any(String),
          watermarkPolicy: expect.any(String),
        })
      );
    }
  });

  it("classifies credential stores as non-exportable S4", () => {
    expect(dataHandlingPolicy("vault")).toMatchObject({
      securityLevel: "S4",
      exportPolicy: "non-exportable-by-default",
      dlpPolicy: "non-exportable",
    });
  });
});
