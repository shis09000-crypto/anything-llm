const {
  canonicalJson,
  commonPrefixLength,
  DEEPSEEK_RESPONSE_MODELS,
  normalizeUsage,
  stateItemFingerprint,
  validateCreateRequest,
} = require("../../utils/responsesRuntime/contract");
const {
  wrapWithResponsesRuntime,
  enabled: responsesRuntimeEnabled,
  requestBody: responsesRuntimeRequestBody,
  toChatStream,
} = require("../../utils/responsesRuntime/chatAdapter");
const {
  agentEnabled,
  responsesInput,
} = require("../../utils/responsesRuntime/agentAdapter");
const {
  normalizeHostedTool,
  withNativeWebSearch,
} = require("../../utils/responsesRuntime/hostedTools");
const {
  deepSeekResponsesComplete,
  deepSeekResponsesStream,
  providerRequest,
  validateProviderRequest,
} = require("../../utils/modelGateway/deepSeekResponses");

describe("managed Responses protocol contracts", () => {
  const baseRequest = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    input: [{ role: "user", content: "hello" }],
  };

  test("uses one Responses route for every non-empty DeepSeek model id", () => {
    expect(DEEPSEEK_RESPONSE_MODELS).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(validateCreateRequest(baseRequest).model).toBe("deepseek-v4-flash");
    expect(
      validateCreateRequest({ ...baseRequest, model: "deepseek-v4-pro" }).model
    ).toBe("deepseek-v4-pro");
    expect(
      validateCreateRequest({ ...baseRequest, model: "next-model" }).model
    ).toBe("next-model");
  });

  test("enables native web search first for every Responses request", () => {
    const request = validateCreateRequest({
      ...baseRequest,
      provider: "future-responses-provider",
      tools: [{ type: "function", name: "workspace_search" }],
    });
    expect(request).toMatchObject({
      provider: "future-responses-provider",
      tools: [
        { type: "web_search" },
        { type: "function", name: "workspace_search" },
      ],
      toolChoice: "auto",
    });
    expect(
      providerRequest({
        ...request,
        tool_choice: request.toolChoice,
      })
    ).toMatchObject({
      tools: [
        { type: "web_search" },
        { type: "function", name: "workspace_search" },
      ],
      tool_choice: "auto",
    });
  });

  test("routes Pro chat through Responses Runtime without rewriting its model", () => {
    const env = {
      ATHENA_RUNTIME_ROLE: "chat-runtime",
      ATHENA_RESPONSES_RUNTIME_URL: "http://responses-runtime:3034",
    };
    expect(
      responsesRuntimeEnabled({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        env,
      })
    ).toBe(true);
    expect(
      responsesRuntimeRequestBody(
        baseRequest.input,
        { thinking: "enabled", reasoningEffort: "max" },
        { chatRunId: "chat-pro" },
        { provider: "deepseek", model: "deepseek-v4-pro" }
      )
    ).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoning: { effort: "max" },
      athena: { chatRunId: "chat-pro" },
    });
  });

  test("forwards structured response formats through Responses Runtime", () => {
    const request = responsesRuntimeRequestBody(
      baseRequest.input,
      {
        responseFormat: { type: "json_object" },
        store: false,
      },
      { taskName: "quiz_generation" },
      { provider: "deepseek", model: "deepseek-v4-pro" }
    );

    expect(request).toMatchObject({
      response_format: { type: "json_object" },
      store: false,
      athena: { taskName: "quiz_generation" },
    });
    expect(validateCreateRequest(request).responseFormat).toEqual({
      type: "json_object",
    });
    expect(providerRequest(request)).toMatchObject({
      text: { format: { type: "json_object" } },
    });
  });

  test("keeps the real provider receiver for private class methods", () => {
    class PrivateProvider {
      #prefix = "provider";

      constructPrompt(value) {
        return `${this.#prefix}:${value}`;
      }
    }

    const delegate = new PrivateProvider();
    const wrapped = wrapWithResponsesRuntime(delegate, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      env: {
        ATHENA_RUNTIME_ROLE: "chat-runtime",
        ATHENA_RESPONSES_RUNTIME_URL: "http://responses-runtime:3034",
      },
    });

    expect(wrapped).not.toBe(delegate);
    expect(wrapped.constructPrompt("ok")).toBe("provider:ok");
    expect(wrapped.responsesRuntime).toBe(true);
  });

  test("does not let a disabled cutover flag send DeepSeek back to Chat", () => {
    expect(
      responsesRuntimeEnabled({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        env: {
          ATHENA_RUNTIME_ROLE: "agent-runtime",
          ATHENA_RESPONSES_RUNTIME_CUTOVER: "false",
        },
      })
    ).toBe(true);
  });

  test("forces Agent tool turns through the same Responses input contract", async () => {
    expect(
      agentEnabled({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        env: {
          ATHENA_RUNTIME_ROLE: "agent-runtime",
          ATHENA_RESPONSES_RUNTIME_CUTOVER: "false",
        },
      })
    ).toBe(true);
    await expect(
      responsesInput(
        [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "probe", arguments: '{"ok":true}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "done" },
        ],
        { model: "deepseek-v4-pro" }
      )
    ).resolves.toMatchObject({
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "probe",
          arguments: '{"ok":true}',
        },
        { type: "function_call_output", call_id: "call_1", output: "done" },
      ],
    });
  });

  test("accepts native Responses image parts only on user messages", () => {
    expect(
      validateCreateRequest({
        ...baseRequest,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "describe" },
              { type: "input_image", file_id: "file-api-1" },
            ],
          },
        ],
      }).input
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe" },
          { type: "input_image", file_id: "file-api-1" },
        ],
      },
    ]);
    expect(() =>
      validateCreateRequest({
        ...baseRequest,
        input: [
          {
            role: "assistant",
            content: [{ type: "input_image", file_id: "file-api-1" }],
          },
        ],
      })
    ).toThrow("response_input_image_role_invalid");
  });

  test("accepts turn-scoped images inside function call output", () => {
    const imageUrl = "data:image/jpeg;base64,ZmFrZQ==";
    expect(
      validateCreateRequest({
        ...baseRequest,
        input: [
          {
            type: "function_call_output",
            call_id: "call_capture",
            output: [
              { type: "input_text", text: '{"captured":true}' },
              { type: "input_image", image_url: imageUrl, detail: "original" },
            ],
          },
        ],
      }).input
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "call_capture",
        output: [
          { type: "input_text", text: '{"captured":true}' },
          { type: "input_image", image_url: imageUrl, detail: "original" },
        ],
      },
    ]);
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

  test("keeps dynamic current-time prompt changes on the same state branch", () => {
    const earlier = {
      type: "message",
      role: "user",
      content:
        "哈咯\n\n<current_datetime>\nUse this as the current date and time for this request.\nCurrent date: 2026-08-12\nCurrent time: 03:58:00\nTime zone: Asia/Shanghai\nISO timestamp: 2026-08-12T19:58:00.000Z\n</current_datetime>",
    };
    const later = {
      ...earlier,
      content:
        "哈咯\n\n<current_datetime>\nUse this as the current date and time for this request.\nCurrent date: 2026-08-12\nCurrent time: 03:59:00\nTime zone: Asia/Shanghai\nISO timestamp: 2026-08-12T19:59:00.000Z\n</current_datetime>",
    };
    expect(stateItemFingerprint(earlier)).toBe(stateItemFingerprint(later));
    expect(commonPrefixLength([earlier], [later])).toBe(1);
  });

  test("canonical JSON follows JSON semantics for undefined values", () => {
    expect(canonicalJson({ z: undefined, b: [1, undefined], a: "kept" })).toBe(
      '{"a":"kept","b":[1,null]}'
    );
    expect(() =>
      JSON.parse(canonicalJson({ temperature: undefined }))
    ).not.toThrow();
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

  test("preserves DeepSeek native web search and maps other governed tools", () => {
    expect(normalizeHostedTool({ type: "web_search" })).toEqual({
      type: "web_search",
    });
    expect(normalizeHostedTool({ type: "web_search_2025_08_26" })).toEqual({
      type: "web_search_2025_08_26",
    });
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

  test("adds native web search once to every unified Responses turn", () => {
    expect(withNativeWebSearch([])).toEqual([{ type: "web_search" }]);
    expect(
      withNativeWebSearch([
        { type: "function", name: "workspace_search" },
        { type: "web_search" },
      ])
    ).toEqual([
      { type: "web_search" },
      { type: "function", name: "workspace_search" },
    ]);
  });

  test("rejects unsupported provider parameters before execution", () => {
    expect(() =>
      validateProviderRequest({ ...baseRequest, unsupported: true })
    ).toThrow("provider_protocol_incompatible");
  });

  test("maps JSON Output to the official Responses text.format field", async () => {
    const responsesCreate = jest.fn().mockResolvedValue({
      status: "completed",
      output_text: '{"ok":true}',
      output: [],
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    const result = await deepSeekResponsesComplete(
      { ...baseRequest, response_format: { type: "json_object" } },
      {
        providerFactory: () => ({
          openai: { responses: { create: responsesCreate } },
        }),
      }
    );
    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ text: { format: { type: "json_object" } } })
    );
    expect(result).toMatchObject({
      effectiveProtocol: "responses",
      degradedReason: null,
      output_text: '{"ok":true}',
    });
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

  test("uses official Responses for Pro without falling back", async () => {
    const create = jest.fn().mockResolvedValue({
      status: "completed",
      model: "deepseek-v4-pro",
      output_text: "pro-ok",
      output: [],
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    const getChatCompletion = jest.fn();
    const result = await deepSeekResponsesComplete(
      { ...baseRequest, model: "deepseek-v4-pro" },
      {
        providerFactory: () => ({
          openai: { responses: { create } },
          getChatCompletion,
        }),
      }
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "deepseek-v4-pro" })
    );
    expect(getChatCompletion).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      effectiveProtocol: "responses",
      output_text: "pro-ok",
    });
  });

  test("preserves the Pro model in streamed chat usage", async () => {
    async function* events() {
      yield {
        type: "response.completed",
        response: {
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          athena: { effectiveProtocol: "responses" },
        },
      };
    }
    const stream = toChatStream(events(), {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.at(-1).usage).toMatchObject({
      model: "deepseek-v4-pro",
      provider: "deepseek",
      effective_protocol: "responses",
    });
  });

  test("never degrades Responses failures to Chat Completions", async () => {
    const getChatCompletion = jest.fn();
    await expect(
      deepSeekResponsesComplete(baseRequest, {
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
          getChatCompletion,
        }),
      })
    ).rejects.toMatchObject({ status: 503 });
    expect(getChatCompletion).not.toHaveBeenCalled();
  });

  test("streams native semantic Responses events without Chat conversion", async () => {
    async function* responseStream() {
      yield {
        type: "response.output_text.delta",
        sequence_number: 0,
        delta: "A",
      };
      yield {
        type: "response.completed",
        sequence_number: 1,
        response: { output_text: "A" },
      };
    }
    const events = [];
    for await (const event of deepSeekResponsesStream(
      { ...baseRequest, stream: true },
      {
        providerFactory: () => ({
          openai: {
            responses: {
              create: jest.fn().mockResolvedValue(responseStream()),
            },
          },
        }),
      }
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "response.output_text.delta", sequence_number: 0, delta: "A" },
      {
        type: "response.completed",
        sequence_number: 1,
        response: { output_text: "A" },
      },
    ]);
  });

  test("keeps model routing independent from protocol routing", () => {
    expect(
      providerRequest({
        ...baseRequest,
        model: "deepseek-future-model",
        reasoning: {},
      })
    ).toMatchObject({
      model: "deepseek-future-model",
      input: baseRequest.input,
    });
  });
});
