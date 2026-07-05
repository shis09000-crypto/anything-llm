const crypto = require("crypto");
const {
  commandSigningString,
  createDeveloperSession,
  verifyDeveloperCommandEnvelope,
} = require("../../utils/devControl/developerSession");
const { verifyAgreementKey } = require("../../utils/devControl/codexAuth");
const { CommandRegistry } = require("../../utils/devControl/commandRegistry");
const { redactDeveloperObject } = require("../../utils/devControl/redactor");

function sign(secret, payload) {
  return crypto
    .createHmac("sha256", secret)
    .update(commandSigningString(payload))
    .digest("base64url");
}

describe("Developer Control Center", () => {
  beforeEach(() => {
    process.env.ATHENA_CODEX_AGREEMENT_KEY = "test-agreement-key";
  });

  test("requires the Codex agreement key", () => {
    expect(verifyAgreementKey("wrong")).toBe(false);
    expect(verifyAgreementKey("test-agreement-key")).toBe(true);
  });

  test("verifies signed command envelopes and rejects nonce replay", () => {
    const { publicSession } = createDeveloperSession({
      userId: 7,
      clientId: "client-a",
      requestId: "session-request",
    });
    const payload = {
      command: "reader.snapshot",
      sessionId: publicSession.sessionId,
      requestId: "command-request",
      timestamp: new Date().toISOString(),
      nonce: "nonce-1",
      scope: { readerDocumentId: "reader-doc-1" },
      params: { detail: "summary" },
    };
    const body = {
      ...payload,
      signature: sign(publicSession.sessionSecret, payload),
    };

    expect(
      verifyDeveloperCommandEnvelope(body, {
        userId: 7,
        clientId: "client-a",
      }).ok
    ).toBe(true);

    expect(
      verifyDeveloperCommandEnvelope(body, {
        userId: 7,
        clientId: "client-a",
      }).code
    ).toBe("developer_command_nonce_replay");
  });

  test("rejects command signatures bound to another client", () => {
    const { publicSession } = createDeveloperSession({
      userId: 7,
      clientId: "client-a",
    });
    const payload = {
      command: "reader.snapshot",
      sessionId: publicSession.sessionId,
      requestId: "command-request",
      timestamp: new Date().toISOString(),
      nonce: "nonce-client-mismatch",
      scope: {},
      params: {},
    };
    const body = {
      ...payload,
      signature: sign(publicSession.sessionSecret, payload),
    };

    expect(
      verifyDeveloperCommandEnvelope(body, {
        userId: 7,
        clientId: "client-b",
      }).code
    ).toBe("developer_session_client_mismatch");
  });

  test("command registry rejects unregistered commands", async () => {
    const registry = new CommandRegistry();
    registry.register("reader.snapshot", async () => ({ ok: true }));

    await expect(
      registry.execute("workspace.delete", {})
    ).rejects.toMatchObject({
      code: "developer_command_not_registered",
    });
  });

  test("redacts sensitive reader fields from command output", () => {
    const redacted = redactDeveloperObject({
      readerDocumentId: "reader-doc-1",
      originalUrl: "https://example.test/original.pdf?token=secret",
      absolutePath: "/Users/shijie/private/original.pdf",
      sessionSecret: "dev-secret",
      nested: {
        Authorization: "Bearer abc",
        text: "document body",
      },
    });

    expect(redacted.readerDocumentId).toBe("reader-doc-1");
    expect(JSON.stringify(redacted)).not.toContain("original.pdf");
    expect(JSON.stringify(redacted)).not.toContain("dev-secret");
    expect(JSON.stringify(redacted)).not.toContain("Bearer abc");
    expect(JSON.stringify(redacted)).not.toContain("document body");
  });
});
