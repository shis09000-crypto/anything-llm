const {
  redactFilename,
  redactHeaders,
  redactLogObject,
  redactLogText,
  redactSensitiveText,
  redactUrl,
  sanitizeLogArgs,
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

  it("redacts filenames, titles, and paths in collector conversion logs", () => {
    const text = [
      "-- Working private-plan.pdf --",
      "-- Working Raw Text doc Secret Market Notes --",
      '[SUCCESS]: private-plan.pdf converted & ready for embedding.',
      'Sheet "Bank Accounts" is empty. Skipping.',
      '-- Working on message "Confidential subject" --',
      "open /Users/alice/private/source.pdf",
    ].join("\n");
    const redacted = redactLogText(text);

    expect(redacted).not.toContain("private-plan.pdf");
    expect(redacted).not.toContain("Secret Market Notes");
    expect(redacted).not.toContain("Bank Accounts");
    expect(redacted).not.toContain("Confidential subject");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).toContain("[redacted-file:");
    expect(redacted).toContain("[redacted-title:");
  });

  it("redacts structured collector log objects", () => {
    const object = redactLogObject({
      filename: "private-plan.pdf",
      title: "Secret Market Notes",
      absolutePath: "/Users/alice/private/source.pdf",
      Authorization: "Bearer secret",
    });
    expect(object.filename).toBe(redactFilename("private-plan.pdf"));
    expect(object.title).toMatch(/^\[redacted-title:[a-f0-9]{12}\]$/);
    expect(object.absolutePath).not.toContain("/Users/alice");
    expect(object.Authorization).toBe("[redacted]");
  });

  it("sanitizes logger args before output", () => {
    const [message, object] = sanitizeLogArgs([
      "-- Working private-plan.pdf --",
      { metadataTitle: "Secret Market Notes", localPath: "/tmp/private.pdf" },
    ]);
    expect(message).not.toContain("private-plan.pdf");
    expect(object.metadataTitle).toMatch(/^\[redacted-title:[a-f0-9]{12}\]$/);
    expect(object.localPath).not.toContain("/tmp/private.pdf");
  });
});
