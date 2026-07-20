const mockEncryptSecret = jest.fn((plainText) => {
  return `enc:v2:test:${Buffer.from(plainText, "utf8").toString("base64url")}`;
});
const mockDecryptSecret = jest.fn((envelope) => {
  return Buffer.from(String(envelope).split(":").at(-1), "base64url").toString(
    "utf8"
  );
});

jest.mock("../../utils/security/encryption", () => ({
  encryptSecret: (...args) => mockEncryptSecret(...args),
  decryptSecret: (...args) => mockDecryptSecret(...args),
  isEncryptedSecret: (value) => String(value || "").startsWith("enc:v2:"),
}));

const {
  decodeUserStateValue,
  encodeUserStateValue,
  isProtectedUserStateValue,
} = require("../../utils/security/userStateValueProtection");

describe("user state value protection", () => {
  beforeEach(() => jest.clearAllMocks());

  test("protects chat draft text at rest and restores it for another device", () => {
    const storedValue = encodeUserStateValue({
      userId: 7,
      namespace: "chat.draft",
      scope: "thread:ws-a:thread-a",
      value: { text: "draft from device A", expiresAt: 123 },
    });

    expect(storedValue).not.toContain("draft from device A");
    expect(isProtectedUserStateValue(JSON.parse(storedValue))).toBe(true);
    expect(
      decodeUserStateValue({
        userId: 7,
        namespace: "chat.draft",
        scope: "thread:ws-a:thread-a",
        storedValue,
      })
    ).toEqual({ text: "draft from device A", expiresAt: 123 });
  });

  test("rejects moving one protected draft to another account or scope", () => {
    const storedValue = encodeUserStateValue({
      userId: 7,
      namespace: "chat.draft",
      scope: "workspace:ws-a",
      value: { text: "bound draft" },
    });

    expect(() =>
      decodeUserStateValue({
        userId: 8,
        namespace: "chat.draft",
        scope: "workspace:ws-a",
        storedValue,
      })
    ).toThrow("protected_user_state_binding_mismatch");
  });

  test("keeps non-draft preference storage compatible", () => {
    const storedValue = encodeUserStateValue({
      userId: 7,
      namespace: "preferences.appearance",
      scope: "global",
      value: { theme: "dark" },
    });
    expect(storedValue).toBe('{"theme":"dark"}');
    expect(
      decodeUserStateValue({
        userId: 7,
        namespace: "preferences.appearance",
        scope: "global",
        storedValue,
      })
    ).toEqual({ theme: "dark" });
  });
});
