/* eslint-env jest */

const {
  isAuthEpochCompatible,
  tokenAuthEpoch,
} = require("../../utils/authz/authCompatibility");

describe("auth epoch compatibility", () => {
  test("legacy tokens remain epoch one until Identity raises the minimum", () => {
    expect(tokenAuthEpoch({})).toBe(1);
    expect(isAuthEpochCompatible({}, {})).toBe(true);
    expect(
      isAuthEpochCompatible({}, { ATHENA_MINIMUM_AUTH_EPOCH: "2" })
    ).toBe(false);
  });

  test("new tokens satisfy the declared minimum", () => {
    expect(
      isAuthEpochCompatible(
        { authEpoch: 3 },
        { ATHENA_MINIMUM_AUTH_EPOCH: "3" }
      )
    ).toBe(true);
  });
});
