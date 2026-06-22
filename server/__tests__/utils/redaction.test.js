const {
  redactFilePath,
  redactHeaders,
  redactLogObject,
  redactSensitiveText,
  redactUrl,
} = require("../../utils/security/redaction");

describe("security redaction helpers", () => {
  it("redacts URL query strings and hashes", () => {
    expect(
      redactUrl("https://example.com/private/doc?token=secret#access-token")
    ).toBe("https://example.com/private/doc?[redacted]#[redacted]");
  });

  it("redacts sensitive header values", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer secret",
        Cookie: "sid=secret",
        "X-API-Key": "secret",
        Accept: "application/json",
      })
    ).toEqual({
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      "X-API-Key": "[redacted]",
      Accept: "application/json",
    });
  });

  it("replaces raw secrets in text with redacted URLs", () => {
    const link = "https://example.com/doc?token=secret";
    expect(redactSensitiveText(`Failed to process ${link}`, [link])).toBe(
      "Failed to process https://example.com/doc?[redacted]"
    );
  });

  it("redacts local file paths in structured log objects", () => {
    expect(redactFilePath("/Users/alice/private/source.pdf")).toBe(
      "[redacted-path]/source.pdf"
    );
    expect(
      redactLogObject({
        absolutePath: "/Users/alice/private/source.pdf",
        nested: {
          localPath: "/tmp/private/reader.docx",
          url: "https://example.com/doc?token=secret",
        },
      })
    ).toEqual({
      absolutePath: "[redacted-path]/source.pdf",
      nested: {
        localPath: "[redacted-path]/reader.docx",
        url: "https://example.com/doc?[redacted]",
      },
    });
  });
});
