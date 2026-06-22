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
      ? toValidNumber(process.env.DEEPSEEK_MAX_TOKENS, DEFAULT_DEEPSEEK_MAX_TOKENS)
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

  #historyWindow() {
    return this.handlerProps?.promptCacheDiagnostics?.historyWindow || null;
  }

  #compaction() {
    return this.handlerProps?.promptCacheDiagnostics?.compaction || null;
  }

  #recordPromptCacheDiagnostics(messages = [], functions = []) {
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

  async #handleFunctionCallChat({ messages = [] }) {
    return await this.client.chat.completions
      .create({
        model: this.model,
        messages,
        ...this.#completionOptions,
      })
      .then((result) => {
        if (result?.usage) this.recordUsage(result.usage);
        if (!result.hasOwnProperty("choices"))
          throw new Error("DeepSeek chat: No results!");
        if (result.choices.length === 0)
          throw new Error("DeepSeek chat: No results length!");
        return result.choices[0].message.content;
      })
      .catch((_) => {
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

  async complete(messages, functions = []) {
    const useNative = functions.length > 0 && this.supportsNativeToolCalling();
    const cleanedMessages = this.#stripAttachments(messages);

    if (!useNative) {
      this.resetUsage();
      const result = await UnTooled.prototype.complete.call(
        this,
        cleanedMessages,
        functions,
        this.#handleFunctionCallChat.bind(this)
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
