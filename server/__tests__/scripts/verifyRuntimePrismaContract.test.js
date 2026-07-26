/* eslint-env jest */
const {
  REQUIRED_MODELS,
  validateDmmfContract,
} = require("../../scripts/verify-runtime-prisma-contract");

function datamodel(overrides = {}) {
  return {
    models: Object.entries(REQUIRED_MODELS).map(([name, fields]) => ({
      name,
      fields: (overrides[name] || fields).map((field) => ({ name: field })),
    })),
  };
}

describe("runtime Prisma contract", () => {
  it("accepts a generated client that contains every runtime model and field", () => {
    expect(() => validateDmmfContract(datamodel())).not.toThrow();
  });

  it("fails closed when a generated client is missing a required field", () => {
    const fields = REQUIRED_MODELS.athena_clients.filter(
      (field) => field !== "publicKeyAlgorithm"
    );

    expect(() =>
      validateDmmfContract(datamodel({ athena_clients: fields }))
    ).toThrow(/athena_clients\.publicKeyAlgorithm/);
  });
});
