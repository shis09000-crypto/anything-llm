const {
  redactHeaders,
  redactSensitiveText,
  redactUrl,
} = require("../../../utils/security/redaction");

describe("collector redaction helpers", () => {
  it("redacts URL query strings and hashes", () => {
    expect(redactUrl("https://example.com/path?token=secret#frag")).toBe(
      "https://example.com/path?[redacted]#[redacted]"
    );
  });

  it("redacts sensitive headers", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret",
        Cookie: "sid=secret",
        Accept: "application/json",
      })
    ).toEqual({
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      Accept: "application/json",
    });
  });

  it("redacts raw URL secrets inside log text", () => {
    const url = "https://example.com/private?apiKey=secret";
    expect(redactSensitiveText(`Failed ${url}`, [url])).toBe(
      "Failed https://example.com/private?[redacted]"
    );
  });
});
