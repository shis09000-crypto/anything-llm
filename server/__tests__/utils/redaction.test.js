const {
  redactFilePath,
  redactHeaders,
  redactLogObject,
  redactLogText,
  redactSensitiveText,
  redactUrl,
  sanitizeLogArgs,
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
    expect(redactFilePath("/Users/alice/private/source.pdf")).toMatch(
      /^\[redacted-path\]\/\[redacted-file:[a-f0-9]{12}:\.pdf\]$/
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
      absolutePath: expect.stringMatching(
        /^\[redacted-path\]\/\[redacted-file:[a-f0-9]{12}:\.pdf\]$/
      ),
      nested: {
        localPath: expect.stringMatching(
          /^\[redacted-path\]\/\[redacted-file:[a-f0-9]{12}:\.docx\]$/
        ),
        url: "https://example.com/doc?[redacted]",
      },
    });
  });

  it("redacts document titles and filenames in structured log objects", () => {
    const redacted = redactLogObject({
      title: "继承人的疲惫与困惑",
      filename: "private-plan.pdf",
      safeCount: 2,
    });
    expect(redacted.title).toMatch(/^\[redacted-title:[a-f0-9]{12}\]$/);
    expect(redacted.filename).toMatch(
      /^\[redacted-file:[a-f0-9]{12}:\.pdf\]$/
    );
    expect(redacted.safeCount).toBe(2);
  });

  it("sanitizes console args without preserving raw paths", () => {
    const [message, object] = sanitizeLogArgs([
      "Failed file:///Users/alice/private/source.pdf",
      {
        localPath: "/Users/alice/private/source.pdf",
        title: "Sensitive title",
      },
    ]);
    expect(message).not.toContain("/Users/alice");
    expect(object.localPath).not.toContain("/Users/alice");
    expect(object.title).toMatch(/^\[redacted-title:[a-f0-9]{12}\]$/);
  });

  it("redacts raw local paths in text", () => {
    expect(redactLogText("open /Users/alice/private/source.pdf")).not.toContain(
      "/Users/alice"
    );
  });
});
