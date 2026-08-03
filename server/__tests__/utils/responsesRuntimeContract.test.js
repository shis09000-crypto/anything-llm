const {
  commonPrefixLength,
  normalizeUsage,
  validateCreateRequest,
} = require("../../utils/responsesRuntime/contract");
const {
  normalizeHostedTool,
} = require("../../utils/responsesRuntime/hostedTools");
const {
  chatCompletionToResponse,
  deepSeekResponsesComplete,
  deepSeekResponsesStream,
  isRecoverableResponsesFailure,
  validateProviderRequest,
} = require("../../utils/modelGateway/deepSeekResponses");

describe("managed Responses protocol contracts", () => {
  const baseRequest = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    input: [{ role: "user", content: "hello" }],
  };

  test("only enables the DeepSeek flash model", () => {
    expect(validateCreateRequest(baseRequest).model).toBe("deepseek-v4-flash");
    expect(() =>
      validateCreateRequest({ ...baseRequest, model: "deepseek-v4-pro" })
    ).toThrow("responses_model_not_supported");
  });

  test("rejects conflicting or non-stored state references", () => {
    expect(() =>
      validateCreateRequest({
        ...baseRequest,
        conversation: "ath_conv_1",
        previous_response_id: "ath_resp_1",
      })
    ).toThrow("response_state_conflict");
    expect(() =>
      validateCreateRequest({
        ...baseRequest,
        store: false,
        previous_response_id: "ath_resp_1",
      })
    ).toThrow("previous_response_mismatch");
  });

  test("compares normalized full-history prefixes deterministically", () => {
    const left = [{ role: "user", content: "one" }];
    const right = [...left, { role: "assistant", content: "two" }];
    expect(commonPrefixLength(left, right)).toBe(1);
    expect(
      commonPrefixLength(right, [
        left[0],
        { role: "assistant", content: "edited" },
      ])
    ).toBe(1);
  });

  test("normalizes DeepSeek cache and reasoning accounting", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 30,
        prompt_cache_hit_tokens: 20,
        prompt_cache_miss_tokens: 10,
        completion_tokens: 7,
        reasoning_tokens: 3,
      })
    ).toEqual({
      input_tokens: 30,
      input_tokens_details: { cached_tokens: 20, cache_miss_tokens: 10 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 37,
    });
  });

  test("maps only Athena-governed hosted tools", () => {
    expect(normalizeHostedTool({ type: "web_search" }).name).toBe(
      "browser_search"
    );
    expect(normalizeHostedTool({ type: "file_search" }).name).toBe(
      "get_workspace_supplement"
    );
    expect(normalizeHostedTool({ type: "computer" }).name).toBe(
      "browser_interact"
    );
    expect(() => normalizeHostedTool({ type: "shell" })).toThrow(
      "hosted_tool_not_supported"
    );
  });

  test("only recoverable endpoint failures may degrade to Chat Completions", () => {
    expect(isRecoverableResponsesFailure({ status: 503 })).toBe(true);
    expect(isRecoverableResponsesFailure({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRecoverableResponsesFailure({ status: 401 })).toBe(false);
    expect(isRecoverableResponsesFailure({ status: 422 })).toBe(false);
  });

  test("rejects unsupported provider parameters before execution", () => {
    expect(() =>
      validateProviderRequest({ ...baseRequest, unsupported: true })
    ).toThrow("provider_protocol_incompatible");
  });

  test("uses official Responses when available", async () => {
    const create = jest.fn().mockResolvedValue({
      status: "completed",
      output_text: "ok",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = await deepSeekResponsesComplete(baseRequest, {
      providerFactory: () => ({ openai: { responses: { create } } }),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.effectiveProtocol).toBe("responses");
    expect(result.output_text).toBe("ok");
  });

  test("degrades recoverable Responses failures inside Model Gateway", async () => {
    const result = await deepSeekResponsesComplete(baseRequest, {
      providerFactory: () => ({
        openai: {
          responses: {
            create: jest
              .fn()
              .mockRejectedValue(
                Object.assign(new Error("down"), { status: 503 })
              ),
          },
        },
        getChatCompletion: jest.fn().mockResolvedValue({
          textResponse: "fallback",
          metrics: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      }),
    });
    expect(result.effectiveProtocol).toBe("chat_completions");
    expect(result.degradedReason).toBe("provider_responses_unavailable");
  });

  test("does not degrade authentication failures", async () => {
    await expect(
      deepSeekResponsesComplete(baseRequest, {
        providerFactory: () => ({
          openai: {
            responses: {
              create: jest
                .fn()
                .mockRejectedValue(
                  Object.assign(new Error("denied"), { status: 401 })
                ),
            },
          },
        }),
      })
    ).rejects.toMatchObject({ status: 401 });
  });

  test("fallback streaming preserves monotonic Responses events", async () => {
    async function* chatStream() {
      yield { choices: [{ delta: { content: "A" } }] };
      yield {
        choices: [{ delta: { content: "B" } }],
        usage: { prompt_tokens: 2 },
      };
    }
    const events = [];
    for await (const event of deepSeekResponsesStream(
      { ...baseRequest, stream: true },
      {
        providerFactory: () => ({
          openai: {
            responses: {
              create: jest
                .fn()
                .mockRejectedValue(
                  Object.assign(new Error("down"), { status: 503 })
                ),
            },
          },
          streamGetChatCompletion: jest.fn().mockResolvedValue(chatStream()),
        }),
      }
    ))
      events.push(event);
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_event, index) => index)
    );
    expect(events.at(-1).type).toBe("response.completed");
    expect(events.at(-1).response.output_text).toBe("AB");
  });

  test("Chat fallback creates an OpenAI-shaped output item", () => {
    const result = chatCompletionToResponse({ textResponse: "hello" });
    expect(result.output[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
    });
  });
});
