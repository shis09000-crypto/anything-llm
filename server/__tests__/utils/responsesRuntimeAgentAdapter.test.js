const mockRequestInternalService = jest.fn();
const mockRequestInternalStream = jest.fn();

jest.mock("../../utils/microModules", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
  requestInternalStream: (...args) => mockRequestInternalStream(...args),
}));

const {
  createResponsesAgentProvider,
  functionsVisibleToResponsesModel,
} = require("../../utils/responsesRuntime/agentAdapter");

function eventStream(events = []) {
  return (async function* () {
    for (const event of events)
      yield Buffer.from(`${JSON.stringify({ event })}\n`, "utf8");
  })();
}

function provider() {
  const instance = createResponsesAgentProvider({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env: {
      ATHENA_RUNTIME_ROLE: "agent-runtime",
      ATHENA_RESPONSES_RUNTIME_CUTOVER: "true",
      ATHENA_RESPONSES_RUNTIME_URL: "http://responses-runtime:8898",
    },
  });
  instance.attachHandlerProps({
    invocation: {
      workspace_id: 1,
      thread_id: 2,
      user_id: 3,
      clientTurnId: "turn-1",
      uuid: "agent-1",
    },
  });
  return instance;
}

describe("Responses Runtime Agent adapter", () => {
  beforeEach(() => {
    mockRequestInternalService.mockReset();
    mockRequestInternalStream.mockReset();
  });

  test("does not add a persistence barrier to a text-only terminal", async () => {
    mockRequestInternalStream.mockResolvedValue(
      eventStream([
        {
          type: "response.output_text.delta",
          response_id: "ath_resp_text",
          delta: "hello",
        },
        {
          type: "response.completed",
          response: {
            id: "ath_resp_text",
            model: "deepseek-v4-flash",
            usage: {},
            athena: { persistenceStatus: "pending" },
          },
        },
      ])
    );

    await expect(
      provider().complete([{ role: "user", content: "hi" }])
    ).resolves.toMatchObject({ textResponse: "hello", functionCall: null });
    expect(mockRequestInternalService).not.toHaveBeenCalled();
  });

  test("never exposes legacy visual tool schemas to the Responses model", async () => {
    const functions = [
      {
        name: "analyze_image",
        description: "Legacy image recognition tool",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "workspace_search",
        description: "Search workspace knowledge",
        parameters: { type: "object", properties: {} },
      },
    ];

    expect(functionsVisibleToResponsesModel(functions)).toEqual([functions[1]]);

    mockRequestInternalStream.mockResolvedValue(
      eventStream([
        {
          type: "response.output_text.delta",
          response_id: "ath_resp_hidden_vision",
          delta: "ok",
        },
        {
          type: "response.completed",
          response: {
            id: "ath_resp_hidden_vision",
            model: "deepseek-v4-flash",
            usage: {},
          },
        },
      ])
    );

    await provider().complete(
      [{ role: "user", content: "inspect this" }],
      functions
    );

    const requestBody = mockRequestInternalStream.mock.calls[0][0].body;
    expect(JSON.stringify(requestBody.tools)).not.toContain("analyze_image");
    expect(JSON.stringify(requestBody.tools)).not.toContain(
      "Legacy image recognition tool"
    );
    expect(JSON.stringify(requestBody.tools)).toContain("workspace_search");
    expect(requestBody.tool_choice).toBe("auto");
  });

  test("waits for an encrypted checkpoint before returning a tool call", async () => {
    mockRequestInternalStream.mockResolvedValue(
      eventStream([
        {
          type: "response.output_item.added",
          response_id: "ath_resp_tool",
          item: {
            type: "function_call",
            id: "item-1",
            call_id: "call-1",
            name: "lookup",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          response_id: "ath_resp_tool",
          call_id: "call-1",
          delta: '{"query":"athena"}',
        },
        {
          type: "response.completed",
          response: {
            id: "ath_resp_tool",
            model: "deepseek-v4-flash",
            usage: {},
            athena: { persistenceStatus: "pending" },
          },
        },
      ])
    );
    mockRequestInternalService
      .mockResolvedValueOnce({
        response: { athena: { persistenceStatus: "pending" } },
      })
      .mockResolvedValueOnce({
        response: { athena: { persistenceStatus: "saved" } },
      });

    await expect(
      provider().complete([{ role: "user", content: "use tool" }])
    ).resolves.toMatchObject({
      functionCall: {
        id: "call-1",
        name: "lookup",
        arguments: { query: "athena" },
      },
    });
    expect(mockRequestInternalService).toHaveBeenCalledTimes(2);
    expect(mockRequestInternalService).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callerRole: "agent-runtime",
        capability: "responses.retrieve",
        method: "GET",
      })
    );
  });

  test("streams sanitized reasoning before answer text and preserves raw tool continuation state", async () => {
    mockRequestInternalStream.mockResolvedValue(
      eventStream([
        {
          type: "response.reasoning_text.delta",
          response_id: "ath_resp_reasoning",
          delta: "先检查 token=private-value。",
        },
        {
          type: "response.output_item.added",
          response_id: "ath_resp_reasoning",
          item: {
            type: "function_call",
            id: "item-r",
            call_id: "call-r",
            name: "lookup",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          response_id: "ath_resp_reasoning",
          call_id: "call-r",
          delta: "{}",
        },
        {
          type: "response.completed",
          response: {
            id: "ath_resp_reasoning",
            model: "deepseek-v4-flash",
            usage: {},
          },
        },
      ])
    );
    mockRequestInternalService.mockResolvedValue({
      response: { athena: { persistenceStatus: "saved" } },
    });
    const streamed = [];

    const result = await provider().stream(
      [{ role: "user", content: "use tool" }],
      [],
      (type, content) => streamed.push({ type, content })
    );

    expect(streamed.map((event) => event.content.type)).toEqual([
      "reasoningContentStart",
      "reasoningContentChunk",
      "toolCallInvocation",
      "reasoningContentDone",
    ]);
    expect(JSON.stringify(streamed)).not.toContain("private-value");
    expect(result.functionCall.reasoning_content).toContain("private-value");
  });
});
