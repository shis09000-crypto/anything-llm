/* global jest, describe, beforeEach, test, expect */

const { Readable } = require("stream");
const mockRequestInternalService = jest.fn();
const mockRequestInternalStream = jest.fn();

jest.mock("../../utils/microModules", () => ({
  requestInternalService: mockRequestInternalService,
  requestInternalStream: mockRequestInternalStream,
}));

const {
  createRemoteAgentProvider,
  sanitizedFunctions,
  wrapAgentProviderWithModelGateway,
} = require("../../utils/modelGateway/agentRemoteProvider");

describe("Agent Model Gateway adapter", () => {
  const env = {
    ATHENA_RUNTIME_ROLE: "agent-runtime",
    ATHENA_MODEL_GATEWAY_CUTOVER: "true",
    ATHENA_MODEL_GATEWAY_URL: "http://model-gateway.test",
    ATHENA_RUNTIME_TOPOLOGY: "local",
  };

  beforeEach(() => jest.clearAllMocks());

  test("sends only function schemas and preserves the completion contract", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      result: {
        textResponse: "",
        functionCall: { name: "lookup", arguments: { symbol: "BTC" } },
      },
      usage: { total_tokens: 12 },
    });
    const remote = wrapAgentProviderWithModelGateway(
      { supportsAgentStreaming: true, lastUsage: {} },
      { provider: "deepseek", model: "deepseek-v4-pro", env }
    );
    const result = await remote.complete(
      [{ role: "user", content: "hello" }],
      [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
          handler: () => "must-not-cross-rpc",
        },
      ]
    );
    expect(result.functionCall.name).toBe("lookup");
    expect(
      mockRequestInternalService.mock.calls[0][0].body.functions[0]
    ).not.toHaveProperty("handler");
    expect(remote.lastUsage).toEqual({ total_tokens: 12 });
  });

  test("replays remote stream events through the existing Agent callback", async () => {
    mockRequestInternalStream.mockResolvedValueOnce(
      Readable.from([
        `${JSON.stringify({
          event: {
            type: "reportStreamEvent",
            data: { type: "textResponseChunk", content: "hello" },
          },
        })}\n`,
        `${JSON.stringify({
          result: { textResponse: "hello", functionCall: null },
          usage: { total_tokens: 5 },
        })}\n`,
        `${JSON.stringify({ end: true })}\n`,
      ])
    );
    const events = [];
    const remote = wrapAgentProviderWithModelGateway(
      { supportsAgentStreaming: true, lastUsage: {} },
      { provider: "deepseek", model: "deepseek-v4-pro", env }
    );
    await expect(
      remote.stream([], [], (type, data) => events.push({ type, data }))
    ).resolves.toEqual({ textResponse: "hello", functionCall: null });
    expect(events).toEqual([
      {
        type: "reportStreamEvent",
        data: { type: "textResponseChunk", content: "hello" },
      },
    ]);
    expect(remote.lastUsage).toEqual({ total_tokens: 5 });
  });

  test("bounds and strips executable tool definitions", () => {
    expect(
      sanitizedFunctions([
        {
          name: "tool",
          description: "description",
          parameters: { type: "object" },
          handler: () => {},
        },
      ])
    ).toEqual([
      {
        name: "tool",
        description: "description",
        parameters: { type: "object" },
      },
    ]);
  });

  test("creates a metadata-only proxy without a local provider delegate", async () => {
    mockRequestInternalService.mockResolvedValueOnce({
      success: true,
      result: { textResponse: "remote-only", functionCall: null },
      usage: { total_tokens: 3 },
    });
    const remote = createRemoteAgentProvider({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      env: { ...env, DEEPSEEK_API_KEY: "" },
    });

    expect(remote).not.toHaveProperty("_client");
    expect(remote.modelGateway).toBe(true);
    await expect(
      remote.complete([{ role: "user", content: "hi" }])
    ).resolves.toEqual({
      textResponse: "remote-only",
      functionCall: null,
    });
    expect(remote.getUsage()).toEqual({ total_tokens: 3 });
  });
});
