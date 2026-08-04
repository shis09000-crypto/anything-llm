/* eslint-env jest */

const mockWrapMaterial = jest.fn(async (value) => `wrapped:${value}`);
const mockUnwrapMaterial = jest.fn(async () => "unwrapped");
const mockDecryptChatFieldCompat = jest.fn(async () => "legacy");

jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  wrapMaterial: mockWrapMaterial,
  unwrapMaterial: mockUnwrapMaterial,
}));
jest.mock("../../utils/security/chatHistorySerialEncryption", () => ({
  decryptChatFieldCompat: mockDecryptChatFieldCompat,
}));
jest.mock("../../utils/prisma", () => ({}));

const {
  AGENT_RUN_EVENT_PURPOSE,
  _internals,
} = require("../../models/agentRun");

describe("AgentRun event encryption boundary", () => {
  beforeEach(() => jest.clearAllMocks());

  test("wraps durable events in the Agent key domain", async () => {
    await _internals.encryptAgentRunEvent("payload", "invocation-1");

    expect(mockWrapMaterial).toHaveBeenCalledWith("payload", {
      purpose: AGENT_RUN_EVENT_PURPOSE,
      domain: "agent",
      resource: "agent-run:invocation-1",
      operation: "event-wrap",
    });
  });

  test("unwraps Agent envelopes without consulting Chat storage", async () => {
    const encodedPurpose = Buffer.from(AGENT_RUN_EVENT_PURPOSE).toString(
      "base64url"
    );
    const value = `enc:v2:key:${encodedPurpose}:iv:tag:ciphertext`;

    await expect(
      _internals.decryptAgentRunEvent(value, "invocation-1")
    ).resolves.toBe("unwrapped");
    expect(mockUnwrapMaterial).toHaveBeenCalledWith(value, {
      purpose: AGENT_RUN_EVENT_PURPOSE,
      domain: "agent",
      resource: "agent-run:invocation-1",
      operation: "event-unwrap",
    });
    expect(mockDecryptChatFieldCompat).not.toHaveBeenCalled();
  });

  test("keeps compatibility with legacy durable event envelopes", async () => {
    await expect(
      _internals.decryptAgentRunEvent("chat:v2:legacy", "invocation-1")
    ).resolves.toBe("legacy");
    expect(mockDecryptChatFieldCompat).toHaveBeenCalledWith("chat:v2:legacy");
  });
});
