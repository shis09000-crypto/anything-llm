const OpenAI = require("openai");
const Provider = require("./ai-provider.js");
const InheritMultiple = require("./helpers/classes.js");
const UnTooled = require("./helpers/untooled.js");
const { tooledStream, tooledComplete } = require("./helpers/tooled.js");
const { RetryError } = require("../error.js");
const { toValidNumber } = require("../../../http/index.js");
const {
  deepSeekUsageMetrics,
  deepSeekPromptCacheDiagnostics,
} = require("../../../AiProviders/deepseek/promptCache.js");

const DEFAULT_DEEPSEEK_MAX_TOKENS = 65_536;
const DEFAULT_DEEPSEEK_REASONING_EFFORT = "high";
const DEFAULT_STRUCTURED_COMPLETION_MAX_TOKENS = 2_048;
const DEFAULT_STRUCTURED_COMPLETION_TIMEOUT_MS = 25_000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

class DeepSeekProvider extends InheritMultiple([Provider, UnTooled]) {
  model;

  constructor(config = {}) {
    super();
    const { model = "deepseek-chat" } = config;
    const client = new OpenAI({
      baseURL: "https://api.deepseek.com/v1",
      apiKey: process.env.DEEPSEEK_API_KEY ?? null,
      maxRetries: 3,
    });

    this._client = client;
    this.model = model;
    this.verbose = true;
    this.maxTokens = process.env.DEEPSEEK_MAX_TOKENS
      ? toValidNumber(
          process.env.DEEPSEEK_MAX_TOKENS,
          DEFAULT_DEEPSEEK_MAX_TOKENS
        )
      : DEFAULT_DEEPSEEK_MAX_TOKENS;
  }

  get client() {
    return this._client;
  }

  get supportsAgentStreaming() {
    return true;
  }

  get cacheStableHistory() {
    return true;
  }

  /**
   * All current DeepSeek models (deepseek-chat and deepseek-reasoner)
   * support native OpenAI-compatible tool calling.
   * @returns {boolean}
   */
  supportsNativeToolCalling() {
    return true;
  }

  /**
   * DeepSeek models do not support vision/image inputs.
   * Strip attachments from messages to prevent API errors.
   * @param {Object} message - Message with potential attachments
   * @returns {Object} Message without attachments
   */
  formatMessageWithAttachments(message) {
    const { attachments: _, ...rest } = message;
    return rest;
  }

  /**
   * Check if the model is a thinking model
   * because we need to inject reasoning content into the messages
   * or else the DeepSeek API will return an error for specific models.
   * There is no official way to predetect if a model will require this
   * so we have to hardcode the list of thinking models.
   * @returns {boolean}
   */
  get #isThinkingModel() {
    return [
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ].includes(this.model);
  }

  get #tooledOptions() {
    return {
      provider: this,
      requestOptions: this.#completionOptions,
      ...(this.#isThinkingModel ? { injectReasoningContent: true } : {}),
    };
  }

  get #completionOptions() {
    return {
      max_tokens: this.maxTokens,
      extra_body: {
        thinking: { type: "enabled" },
        reasoning_effort:
          process.env.DEEPSEEK_REASONING_EFFORT ||
          DEFAULT_DEEPSEEK_REASONING_EFFORT,
      },
    };
  }

  #completionOptionsFor(overrides = null) {
    if (
      !overrides ||
      typeof overrides !== "object" ||
      Array.isArray(overrides) ||
      Object.keys(overrides).length === 0
    )
      return this.#completionOptions;

    const thinking = overrides.thinking === "enabled" ? "enabled" : "disabled";
    const maxTokens = boundedInteger(
      overrides.maxTokens,
      DEFAULT_STRUCTURED_COMPLETION_MAX_TOKENS,
      256,
      4_096
    );
    const options = {
      max_tokens: maxTokens,
      // The JavaScript OpenAI client forwards extension fields directly.
      // `extra_body` is the Python SDK escape hatch and would be sent as a
      // literal wrapper here, causing DeepSeek to keep its default thinking
      // mode and spend the whole bounded output on reasoning.
      thinking: { type: thinking },
      ...(thinking === "enabled"
        ? {
            reasoning_effort:
              overrides.reasoningEffort ||
              process.env.DEEPSEEK_REASONING_EFFORT ||
              DEFAULT_DEEPSEEK_REASONING_EFFORT,
          }
        : {}),
    };

    if (thinking === "disabled")
      options.temperature = Number.isFinite(Number(overrides.temperature))
        ? Number(overrides.temperature)
        : 0;
    if (overrides.responseFormat?.type === "json_object")
      options.response_format = { type: "json_object" };
    return options;
  }

  #requestOptionsFor(overrides = null) {
    if (
      !overrides ||
      typeof overrides !== "object" ||
      Array.isArray(overrides) ||
      Object.keys(overrides).length === 0
    )
      return null;
    return {
      timeout: boundedInteger(
        overrides.timeoutMs,
        DEFAULT_STRUCTURED_COMPLETION_TIMEOUT_MS,
        1_000,
        60_000
      ),
      maxRetries: boundedInteger(overrides.maxRetries, 0, 0, 2),
    };
  }

  #historyWindow() {
    return this.handlerProps?.promptCacheDiagnostics?.historyWindow || null;
  }

  #compaction() {
    return this.handlerProps?.promptCacheDiagnostics?.compaction || null;
  }

  #recordPromptCacheDiagnostics(messages = [], functions = []) {
    try {
      const promptCacheDiagnostics = deepSeekPromptCacheDiagnostics({
        provider: this.constructor.name,
        model: this.model,
        messages,
        functions,
        historyWindow: this.#historyWindow(),
        compaction: this.#compaction(),
        providerPath: "agent",
      });
      this.lastUsage = {
        ...this.lastUsage,
        promptCacheDiagnostics,
        historyWindow: promptCacheDiagnostics.historyWindow,
      };
      return promptCacheDiagnostics;
    } catch (error) {
      // Diagnostics are metadata-only observability. They must never turn a
      // successfully generated model response into a failed invocation.
      console.warn(
        `[DeepSeekPromptCache] Diagnostics skipped: ${error?.message || "invalid diagnostics input"}`
      );
      return null;
    }
  }

  recordUsage(usage = {}) {
    Provider.prototype.recordUsage.call(this, usage);
    this.lastUsage = {
      ...this.lastUsage,
      ...deepSeekUsageMetrics(usage),
    };
  }

  #usageRecordingStream(stream) {
    const provider = this;
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk?.usage) provider.recordUsage(chunk.usage);
        yield chunk;
      }
    })();
  }

  async #handleFunctionCallChat({ messages = [], completionOptions = null }) {
    const body = {
      model: this.model,
      messages,
      ...this.#completionOptionsFor(completionOptions),
    };
    const requestOptions = this.#requestOptionsFor(completionOptions);
    const request = requestOptions
      ? this.client.chat.completions.create(body, requestOptions)
      : this.client.chat.completions.create(body);
    return await request
      .then((result) => {
        if (result?.usage) this.recordUsage(result.usage);
        if (!result.hasOwnProperty("choices"))
          throw new Error("DeepSeek chat: No results!");
        if (result.choices.length === 0)
          throw new Error("DeepSeek chat: No results length!");
        return result.choices[0].message.content;
      })
      .catch((error) => {
        if (completionOptions) throw error;
        return null;
      });
  }

  async #handleFunctionCallStream({ messages = [] }) {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      messages,
      ...this.#completionOptions,
    });
    return this.#usageRecordingStream(stream);
  }

  /**
   * Strip attachments from all messages since DeepSeek doesn't support vision.
   * @param {Array} messages - Array of messages
   * @returns {Array} Messages with attachments removed
   */
  #stripAttachments(messages) {
    let hasAttachments = false;
    const stripped = messages.map((msg) => {
      if (msg.attachments && msg.attachments.length > 0) {
        hasAttachments = true;
        const { attachments: _, ...rest } = msg;
        return rest;
      }
      return msg;
    });
    if (hasAttachments) {
      this.providerLog(
        "DeepSeek does not support vision - stripped image attachments from messages."
      );
    }
    return stripped;
  }

  async stream(messages, functions = [], eventHandler = null) {
    const useNative = functions.length > 0 && this.supportsNativeToolCalling();
    const cleanedMessages = this.#stripAttachments(messages);

    if (!useNative) {
      this.resetUsage();
      const result = await UnTooled.prototype.stream.call(
        this,
        cleanedMessages,
        functions,
        this.#handleFunctionCallStream.bind(this),
        eventHandler
      );
      this.#recordPromptCacheDiagnostics(cleanedMessages, functions);
      return result;
    }

    this.providerLog(
      "Provider.stream (tooled) - will process this chat completion."
    );

    try {
      const result = await tooledStream(
        this.client,
        this.model,
        cleanedMessages,
        functions,
        eventHandler,
        this.#tooledOptions
      );
      this.#recordPromptCacheDiagnostics(cleanedMessages, functions);
      return result;
    } catch (error) {
      console.error(error.message, error);
      if (error instanceof OpenAI.AuthenticationError) throw error;
      if (
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIError
      ) {
        throw new RetryError(error.message);
      }
      throw error;
    }
  }

  async complete(messages, functions = [], completionOptions = null) {
    const useNative = functions.length > 0 && this.supportsNativeToolCalling();
    const cleanedMessages = this.#stripAttachments(messages);

    if (!useNative) {
      this.resetUsage();
      const result = await UnTooled.prototype.complete.call(
        this,
        cleanedMessages,
        functions,
        ({ messages: callbackMessages }) =>
          this.#handleFunctionCallChat({
            messages: callbackMessages,
            completionOptions,
          })
      );
      this.#recordPromptCacheDiagnostics(cleanedMessages, functions);
      return result;
    }

    try {
      const result = await tooledComplete(
        this.client,
        this.model,
        cleanedMessages,
        functions,
        this.getCost.bind(this),
        this.#tooledOptions
      );

      if (result.retryWithError) {
        return this.complete([...messages, result.retryWithError], functions);
      }

      this.#recordPromptCacheDiagnostics(cleanedMessages, functions);
      return result;
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) throw error;
      if (
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIError
      ) {
        throw new RetryError(error.message);
      }
      throw error;
    }
  }

  /**
   * Get the cost of the completion.
   *
   * @param _usage The completion to get the cost for.
   * @returns The cost of the completion.
   */
  getCost(_usage) {
    return 0;
  }
}

module.exports = DeepSeekProvider;
