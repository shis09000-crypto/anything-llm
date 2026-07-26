const {
  USER_KEY_DOMAINS,
  USER_ROOT_DERIVATION_SUITE_ID,
  USER_ROOT_TRANSPORT_SUITE_ID,
  deriveUserDomainKey,
  generateUserRootKey,
  userRootEnvelopeContext,
} = require("../../utils/security/userKeyDerivation");

describe("User Root Key derivation", () => {
  test("generates random 256-bit roots and deterministic domain keys", () => {
    const root = generateUserRootKey();
    const anotherRoot = generateUserRootKey();
    const input = { userRootKey: root, authUserId: 42, keyEpoch: 1 };
    const dataKey = deriveUserDomainKey({
      ...input,
      domain: USER_KEY_DOMAINS.DATA,
    });

    expect(root).toHaveLength(32);
    expect(anotherRoot).toHaveLength(32);
    expect(root.equals(anotherRoot)).toBe(false);
    expect(dataKey).toHaveLength(32);
    expect(
      dataKey.equals(
        deriveUserDomainKey({ ...input, domain: USER_KEY_DOMAINS.DATA })
      )
    ).toBe(true);
  });

  test("separates domains, users and key epochs", () => {
    const root = Buffer.alloc(32, 7);
    const derive = (overrides = {}) =>
      deriveUserDomainKey({
        userRootKey: root,
        authUserId: 42,
        keyEpoch: 1,
        domain: USER_KEY_DOMAINS.DATA,
        ...overrides,
      });
    const keys = [
      derive(),
      derive({ domain: USER_KEY_DOMAINS.FILE }),
      derive({ domain: USER_KEY_DOMAINS.AGENT }),
      derive({ domain: USER_KEY_DOMAINS.VAULT }),
      derive({ authUserId: 43 }),
      derive({ keyEpoch: 2 }),
    ].map((key) => key.toString("hex"));

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("binds future root envelopes to the active X-Wing transport suite", () => {
    expect(
      userRootEnvelopeContext({
        authUserId: 42,
        keyEpoch: 3,
        targetClientId: "ios-device:primary",
      })
    ).toEqual({
      version: "athena-user-root-envelope-context:v1",
      derivationSuiteId: USER_ROOT_DERIVATION_SUITE_ID,
      transportSuiteId: USER_ROOT_TRANSPORT_SUITE_ID,
      authUserId: 42,
      keyEpoch: 3,
      targetClientId: "ios-device:primary",
    });
    expect(() =>
      userRootEnvelopeContext({
        authUserId: 42,
        keyEpoch: 3,
        targetClientId: "ios-device:primary",
        transportSuiteId: "ml-kem-only",
      })
    ).toThrow("unsupported_user_root_transport_suite");
  });

  test("rejects malformed roots and unregistered derivation domains", () => {
    expect(() =>
      deriveUserDomainKey({
        userRootKey: Buffer.alloc(31),
        authUserId: 42,
        keyEpoch: 1,
        domain: USER_KEY_DOMAINS.DATA,
      })
    ).toThrow("invalid_user_root_key");
    expect(() =>
      deriveUserDomainKey({
        userRootKey: Buffer.alloc(32),
        authUserId: 42,
        keyEpoch: 1,
        domain: "unknown",
      })
    ).toThrow("invalid_user_key_domain");
  });
});
