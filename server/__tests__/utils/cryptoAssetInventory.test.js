const {
  CRYPTO_ASSETS,
  validateCryptoAssetInventory,
} = require("../../utils/security/cryptoAssetInventory");

describe("global cryptographic asset inventory", () => {
  test("is complete, unique and references registered suites", () => {
    expect(validateCryptoAssetInventory()).toEqual({
      valid: true,
      findings: [],
    });
    expect(CRYPTO_ASSETS.length).toBeGreaterThanOrEqual(20);
  });

  test("records legacy CBC only as a disabled or migration target", () => {
    const legacy = CRYPTO_ASSETS.filter((asset) =>
      (asset.algorithms || []).some((algorithm) => algorithm.includes("CBC"))
    );
    expect(legacy.length).toBeGreaterThan(0);
    expect(
      legacy.every((asset) => /disabled|legacy|migration/.test(asset.status))
    ).toBe(true);
  });
});
