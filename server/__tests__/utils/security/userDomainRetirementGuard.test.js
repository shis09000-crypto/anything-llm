const {
  RETIREMENT_PROOF_VERSION,
  assertPlatformKeyRetirementProof,
} = require("../../../utils/security/userDomainRetirementGuard");

describe("user domain retirement guard", () => {
  test("requires a fresh zero-blocker migration proof", () => {
    const keyId = "sdk_123456789abc";
    expect(() => assertPlatformKeyRetirementProof(null, keyId)).toThrow(
      "platform_key_retirement_migration_incomplete"
    );
    const proof = {
      version: RETIREMENT_PROOF_VERSION,
      keyId,
      generatedAt: new Date().toISOString(),
      retirementAllowed: true,
      blockers: {
        auditErrors: 0,
        platformReferences: 0,
        usersWithoutSharedIdentity: 0,
        usersWithoutRoot: 0,
        usersWithIncompleteWrapCoverage: 0,
      },
    };
    expect(assertPlatformKeyRetirementProof(proof, keyId)).toBe(true);
    expect(() =>
      assertPlatformKeyRetirementProof(
        {
          ...proof,
          blockers: { ...proof.blockers, platformReferences: 1 },
        },
        keyId
      )
    ).toThrow("platform_key_retirement_migration_incomplete");
  });
});
