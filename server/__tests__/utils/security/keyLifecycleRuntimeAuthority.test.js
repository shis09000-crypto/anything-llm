const {
  resetKeyProviderForTests,
} = require("../../../utils/security/keyCustody");
const {
  selectRuntimeDescriptor,
} = require("../../../utils/security/keyLifecycle");

const PROVIDER_KEY = {
  keyId: "sdk_provider",
  purpose: "server-data-at-rest",
  material: Buffer.alloc(32, 2),
};
const REGISTRY_KEY = {
  keyId: "sdk_registry",
  purpose: "server-data-at-rest",
  material: Buffer.alloc(32, 1),
};

describe("Key Lifecycle runtime authority", () => {
  afterEach(() => resetKeyProviderForTests());

  test("fails closed until provider and registry active keys are reconciled", () => {
    resetKeyProviderForTests({
      resolveActiveKey: () => PROVIDER_KEY,
      resolveKey: (keyId) =>
        keyId === REGISTRY_KEY.keyId ? REGISTRY_KEY : null,
    });

    expect(() =>
      selectRuntimeDescriptor(PROVIDER_KEY, { keyId: REGISTRY_KEY.keyId })
    ).toThrow("key_provider_registry_active_mismatch");
  });

  test("fails closed when the registered key cannot be resolved", () => {
    resetKeyProviderForTests({
      resolveActiveKey: () => PROVIDER_KEY,
      resolveKey: () => null,
    });

    expect(() =>
      selectRuntimeDescriptor(PROVIDER_KEY, { keyId: "sdk_missing" })
    ).toThrow("key_registry_active_mismatch");
  });
});
