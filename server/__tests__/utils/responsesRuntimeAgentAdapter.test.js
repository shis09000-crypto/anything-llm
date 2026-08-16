const mockRequestInternalService = jest.fn();
const mockRequestInternalStream = jest.fn();

jest.mock("../../utils/microModules", () => ({
  requestInternalService: (...args) => mockRequestInternalService(...args),
  requestInternalStream: (...args) => mockRequestInternalStream(...args),
}));

const {
  createResponsesAgentProvider,
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
});
