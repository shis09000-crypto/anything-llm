const { User } = require("../../models/user");

describe("username validation restrictions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const failureMessages = [
    "Username cannot be longer than 32 characters",
    "Username must be at least 3 characters",
    "Username can only contain letters, numbers, underscores, and hyphens",
  ];

  it("should throw an error if the username is longer than 32 characters", () => {
    expect(() => User.validations.username("a".repeat(33))).toThrow(failureMessages[0]);
  });

  it("should throw an error if the username is less than 3 characters", () => {
    expect(() => User.validations.username("ab")).toThrow(failureMessages[1]);
  });

  it("accepts upper and lowercase account names", () => {
    expect(User.validations.username("Aa1")).toBe("Aa1");
  });

  it("should throw an error if the username contains invalid characters", () => {
    expect(() => User.validations.username("ad-123_456.789")).toThrow(failureMessages[2]);
    expect(() => User.validations.username("ad-123_456#456")).toThrow(failureMessages[2]);
    expect(() => User.validations.username("ad-123_456!456")).toThrow(failureMessages[2]);
  });

  it("returns a normalized valid account name and rejects email syntax", () => {
    expect(User.validations.username("  a123_456-789  ")).toBe(
      "a123_456-789"
    );
    expect(() =>
      User.validations.username("a123_456@example.com")
    ).toThrow(failureMessages[2]);
  });

  it("coerces scalar values but rejects empty and object-like values", () => {
    expect(User.validations.username(123)).toBe("123");
    expect(() => User.validations.username(null)).toThrow(failureMessages[1]);
    expect(() => User.validations.username(undefined)).toThrow(
      failureMessages[1]
    );
    expect(() => User.validations.username({})).toThrow(failureMessages[2]);
    expect(() => User.validations.username([])).toThrow(failureMessages[1]);
    expect(User.validations.username(true)).toBe("true");
    expect(() => User.validations.username(false)).toThrow(failureMessages[1]);
  });
});
