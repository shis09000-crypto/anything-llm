const JWT = require("jsonwebtoken");

describe("http JWT fallback verification", () => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalJwtSecretPrevious = process.env.JWT_SECRET_PREVIOUS;
  const originalJwtSecretFallbacks = process.env.JWT_SECRET_FALLBACKS;

  beforeEach(() => {
    jest.resetModules();
    process.env.JWT_SECRET = "current-jwt-secret-value-that-is-long-enough";
    process.env.JWT_SECRET_PREVIOUS = "previous-jwt-secret";
    delete process.env.JWT_SECRET_FALLBACKS;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;

    if (originalJwtSecretPrevious === undefined)
      delete process.env.JWT_SECRET_PREVIOUS;
    else process.env.JWT_SECRET_PREVIOUS = originalJwtSecretPrevious;

    if (originalJwtSecretFallbacks === undefined)
      delete process.env.JWT_SECRET_FALLBACKS;
    else process.env.JWT_SECRET_FALLBACKS = originalJwtSecretFallbacks;
  });

  test("makeJWT signs with the current secret only", () => {
    const {
      makeJWT,
      decodeJWT,
      SESSION_JWT_ALGORITHMS,
    } = require("../../utils/http");
    const token = makeJWT({ id: 7, username: "athena" }, "1h");

    expect(SESSION_JWT_ALGORITHMS).toEqual(["HS256"]);
    expect(JWT.decode(token, { complete: true }).header.alg).toBe("HS256");
    expect(decodeJWT(token).id).toBe(7);
    expect(() => JWT.verify(token, process.env.JWT_SECRET_PREVIOUS)).toThrow();
  });

  test("decodeJWT accepts a previous secret for existing sessions", () => {
    const { decodeJWT } = require("../../utils/http");
    const legacyToken = JWT.sign(
      { id: 9, username: "legacy" },
      process.env.JWT_SECRET_PREVIOUS,
      { expiresIn: "1h" }
    );

    expect(decodeJWT(legacyToken)).toMatchObject({
      id: 9,
      username: "legacy",
    });
  });

  test("decodeJWT still rejects invalid tokens", () => {
    const { decodeJWT } = require("../../utils/http");
    const token = JWT.sign({ id: 11 }, "untrusted-secret", {
      expiresIn: "1h",
    });

    expect(decodeJWT(token)).toMatchObject({ id: null, p: null });
  });

  test("decodeJWT rejects a valid token that uses an unregistered algorithm", () => {
    const { decodeJWT } = require("../../utils/http");
    const token = JWT.sign({ id: 12 }, process.env.JWT_SECRET, {
      algorithm: "HS384",
      expiresIn: "1h",
    });

    expect(decodeJWT(token)).toMatchObject({ id: null, p: null });
  });
});
