const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const { v4: uuidv4 } = require("uuid");
const { MODEL_MAP } = require("../modelMap");
const {
  writeResponseChunk,
  clientAbortedHandler,
} = require("../../helpers/chat/responses");
const {
  deepSeekUsageMetrics,
  deepSeekPromptShape,
  deepSeekPromptFingerprint,
  deepSeekPromptCacheDiagnostics,
  deepSeekCacheDiagnosis,
  withDeepSeekCacheDiagnosis,
} = require("./promptCache");

const DEFAULT_DEEPSEEK_MAX_TOKENS = 65_536;
const DEFAULT_DEEPSEEK_REASONING_EFFORT = "high";
const DEEPSEEK_CHAT_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "deepseek-chat",
  "deepseek-reasoner",
]);

function isRecoverableDeepSeekStreamError(error = null) {
  const status = Number(error?.status || error?.httpStatus || 0);
  const code = String(error?.code || error?.cause?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  return (
    [
      "econnreset",
      "econnrefused",
      "enotfound",
      "etimedout",
      "und_err_connect_timeout",
      "und_err_socket",
    ].includes(code) ||
    /connection reset|fetch failed|socket|stream.*closed|timeout|timed out|temporarily unavailable/.test(
      message
    )
  );
}

function streamChunkHasVisiblePayload(chunk = null) {
  const delta = chunk?.choices?.[0]?.delta || {};
  return Boolean(delta.content || delta.tool_calls?.length);
}

function emptyDeepSeekStreamError() {
  const error = new Error("DeepSeek returned an empty response stream.");
  error.code = "DEEPSEEK_EMPTY_STREAM";
  return error;
}

async function resilientDeepSeekStream(
  createStream,
  { maxAttempts = 2, retryDelayMs = 150 } = {}
) {
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  let attempt = 0;
  let activeStream = null;

  const waitBeforeRetry = async () => {
    if (retryDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  };
  const openStream = async () => {
    while (attempt < attempts) {
      attempt += 1;
      try {
        activeStream = await createStream();
        return activeStream;
      } catch (error) {
        if (attempt >= attempts || !isRecoverableDeepSeekStreamError(error))
          throw error;
        await waitBeforeRetry();
      }
    }
    throw emptyDeepSeekStreamError();
  };

  await openStream();
  const resilient = {
    metrics: activeStream?.metrics || {},
    async *[Symbol.asyncIterator]() {
      while (activeStream) {
        let visiblePayloadReceived = false;
        try {
          for await (const chunk of activeStream) {
            if (streamChunkHasVisiblePayload(chunk))
              visiblePayloadReceived = true;
            yield chunk;
          }
          if (visiblePayloadReceived) return;
          const error = emptyDeepSeekStreamError();
          if (attempt >= attempts) throw error;
          activeStream?.endMeasurement?.({});
          await waitBeforeRetry();
          await openStream();
          resilient.metrics = activeStream?.metrics || {};
        } catch (error) {
          if (
            visiblePayloadReceived ||
            attempt >= attempts ||
            (error?.code !== "DEEPSEEK_EMPTY_STREAM" &&
              !isRecoverableDeepSeekStreamError(error))
          )
            throw error;
          activeStream?.endMeasurement?.({});
          await waitBeforeRetry();
          await openStream();
          resilient.metrics = activeStream?.metrics || {};
        }
      }
    },
    endMeasurement(usage = {}) {
      activeStream?.endMeasurement?.(usage);
      resilient.metrics = activeStream?.metrics || resilient.metrics;
      return resilient.metrics;
    },
  };
  return resilient;
}

function toValidDeepSeekMaxTokens(value = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_DEEPSEEK_MAX_TOKENS;
  return Math.floor(parsed);
}

function deepSeekCompletionOptions({
  temperature = 0.7,
  responseFormat = null,
  tools = null,
  toolChoice = null,
  thinking = "disabled",
  reasoningEffort = DEFAULT_DEEPSEEK_REASONING_EFFORT,
  maxTokens = process.env.DEEPSEEK_MAX_TOKENS,
} = {}) {
  const thinkingType = thinking === "enabled" ? "enabled" : "disabled";
  return {
    max_tokens: toValidDeepSeekMaxTokens(maxTokens),
    ...(thinkingType === "enabled" ? {} : { temperature }),
    // The JavaScript OpenAI client accepts DeepSeek's extension fields directly
    // on the request body. `extra_body` is the Python SDK escape hatch; sending
    // that literal wrapper from the JS SDK causes DeepSeek to ignore the toggle
    // and fall back to its default (thinking enabled).
    thinking: { type: thinkingType },
    ...(thinkingType === "enabled" && reasoningEffort
      ? { reasoning_effort: reasoningEffort }
      : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };
}

class DeepSeekLLM {
  constructor(
    embedder = null,
    modelPreference = null,
    { credentialMode = "local" } = {}
  ) {
    const usesRemoteTransport = credentialMode === "remote";
    if (!usesRemoteTransport && !process.env.DEEPSEEK_API_KEY)
      throw new Error("No DeepSeek API key was set.");
    this.className = "DeepSeekLLM";
    this.openai = null;
    if (!usesRemoteTransport) {
      const { OpenAI: OpenAIApi } = require("openai");
      this.openai = new OpenAIApi({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      });
    }
    this.credentialMode = credentialMode;
    this.model =
      modelPreference || process.env.DEEPSEEK_MODEL_PREF || "deepseek-chat";
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
    this.cacheStableHistory = true;
    this.log(
      `Initialized ${this.model} with context window ${this.promptWindowLimit()}`
    );
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  #formatContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "Context:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  #userPromptWithContext({ contextTexts = [], userPrompt = "" }) {
    const context = this.#formatContext(contextTexts);
    if (!context) return userPrompt;
    return `${context}${userPrompt}`;
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    return MODEL_MAP.get("deepseek", modelName) ?? 8192;
  }

  promptWindowLimit() {
    return MODEL_MAP.get("deepseek", this.model) ?? 8192;
  }

  async isValidChatCompletionModel(modelName = "") {
    // Do not turn a transient `/models` failure into a false model rejection.
    // These are the official chat model ids; the completion request remains the
    // authoritative validation for credentials and provider availability.
    if (DEEPSEEK_CHAT_MODELS.has(modelName)) return true;
    const models = await this.openai.models.list().catch(() => ({ data: [] }));
    return models.data.some((model) => model.id === modelName);
  }

  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
  }) {
    const prompt = {
      role: "system",
      content: systemPrompt,
    };
    return [
      prompt,
      ...chatHistory,
      {
        role: "user",
        content: this.#userPromptWithContext({ contextTexts, userPrompt }),
      },
    ];
  }

  promptCacheDiagnostics(
    messages = [],
    { historyWindow = null, compaction = null } = {}
  ) {
    return deepSeekPromptCacheDiagnostics({
      provider: this.className,
      model: this.model,
      messages,
      historyWindow,
      compaction,
      providerPath: "workspace-chat",
    });
  }

  #parseReasoningFromResponse({ message }) {
    return message?.content || "";
  }

  async getChatCompletion(
    messages = null,
    {
      temperature = 0.7,
      responseFormat = null,
      thinking = "disabled",
      reasoningEffort = DEFAULT_DEEPSEEK_REASONING_EFFORT,
      maxTokens = null,
    } = {}
  ) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `DeepSeek chat: ${this.model} is not valid for chat completion!`
      );

    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          ...deepSeekCompletionOptions({
            temperature,
            responseFormat,
            thinking,
            reasoningEffort,
            maxTokens,
          }),
        })
        .catch((e) => {
          throw new Error(e.message);
        })
    );

    if (
      !result?.output?.hasOwnProperty("choices") ||
      result?.output?.choices?.length === 0
    )
      throw new Error(
        `Invalid response body returned from DeepSeek: ${JSON.stringify(result.output)}`
      );

    const usage = result.output.usage || {};
    const choice = result.output.choices[0] || {};
    const completionTokens = usage.completion_tokens || 0;
    const reasoningTokens =
      usage?.completion_tokens_details?.reasoning_tokens ||
      usage?.reasoning_tokens ||
      0;
    const finishReason = choice.finish_reason || null;
    const requestedMaxTokens = toValidDeepSeekMaxTokens(maxTokens);
    const metrics = {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: completionTokens,
      total_tokens: usage.total_tokens || 0,
      ...deepSeekUsageMetrics(usage),
      reasoning_tokens: reasoningTokens,
      finish_reason: finishReason,
      thinking_mode: thinking === "enabled" ? "enabled" : "disabled",
      requested_max_tokens: requestedMaxTokens,
      hit_output_limit:
        finishReason === "length" || completionTokens >= requestedMaxTokens,
      outputTps: completionTokens / result.duration,
      duration: result.duration,
      model: this.model,
      provider: this.className,
      timestamp: new Date(),
    };

    return {
      textResponse: this.#parseReasoningFromResponse(choice),
      metrics,
    };
  }

  async streamGetChatCompletion(
    messages = null,
    {
      temperature = 0.7,
      responseFormat = null,
      tools = null,
      toolChoice = null,
      thinking = "disabled",
      reasoningEffort = DEFAULT_DEEPSEEK_REASONING_EFFORT,
      maxTokens = null,
    } = {}
  ) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `DeepSeek chat: ${this.model} is not valid for chat completion!`
      );

    const createMeasuredStream = () =>
      LLMPerformanceMonitor.measureStream({
        func: this.openai.chat.completions.create({
          model: this.model,
          stream: true,
          messages,
          stream_options: {
            include_usage: true,
          },
          ...deepSeekCompletionOptions({
            temperature,
            responseFormat,
            tools,
            toolChoice,
            thinking,
            reasoningEffort,
            maxTokens,
          }),
        }),
        messages,
        runPromptTokenCalculation: false,
        modelTag: this.model,
        provider: this.className,
      });

    return resilientDeepSeekStream(createMeasuredStream, {
      maxAttempts:
        this.model === "deepseek-v4-pro"
          ? Number(process.env.DEEPSEEK_PRO_STREAM_MAX_ATTEMPTS || 2)
          : 1,
      retryDelayMs: Number(process.env.DEEPSEEK_STREAM_RETRY_DELAY_MS || 150),
    });
  }

  // TODO: This is a copy of the generic handleStream function in responses.js
  // with DeepSeek-specific usage metrics and tool-call aggregation.
  // Reasoning chunks are intentionally ignored so chain-of-thought is not
  // streamed to clients or saved into chat history.
  handleStream(response, stream, responseProps) {
    const { uuid = uuidv4(), sources = [] } = responseProps;
    let hasUsageMetrics = false;
    let usage = {
      completion_tokens: 0,
    };

    return new Promise(async (resolve, reject) => {
      let fullText = "";
      const pendingToolCalls = new Map();

      // Establish listener to early-abort a streaming response
      // in case things go sideways or the user does not like the response.
      // We preserve the generated text but continue as if chat was completed
      // to preserve previously generated content.
      const handleAbort = () => {
        stream?.endMeasurement(usage);
        clientAbortedHandler(resolve, fullText);
      };
      response.on("close", handleAbort);

      try {
        for await (const chunk of stream) {
          const message = chunk?.choices?.[0];
          const token = message?.delta?.content;
          const toolCalls = message?.delta?.tool_calls || [];

          if (
            chunk.hasOwnProperty("usage") && // exists
            !!chunk.usage && // is not null
            Object.values(chunk.usage).length > 0 // has values
          ) {
            const usageMetrics = deepSeekUsageMetrics(chunk.usage);
            usage = {
              ...usage,
              ...usageMetrics,
            };

            if (usageMetrics.hasOwnProperty("completion_tokens")) {
              hasUsageMetrics = true; // to stop estimating counter
            }
          }

          if (Array.isArray(toolCalls) && toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
              const index = Number(toolCall.index || 0);
              const current = pendingToolCalls.get(index) || {
                id: toolCall.id || null,
                type: toolCall.type || "function",
                function: {
                  name: "",
                  arguments: "",
                },
              };

              if (toolCall.id) current.id = toolCall.id;
              if (toolCall.type) current.type = toolCall.type;
              if (toolCall.function?.name)
                current.function.name += toolCall.function.name;
              if (toolCall.function?.arguments)
                current.function.arguments += toolCall.function.arguments;

              pendingToolCalls.set(index, current);
            }
          }

          if (token) {
            fullText += token;
            // If we never saw a usage metric, we can estimate them by number of completion chunks
            if (!hasUsageMetrics) usage.completion_tokens++;
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: token,
              close: false,
              error: false,
            });
          }

          // LocalAi returns '' and others return null on chunks - the last chunk is not "" or null.
          // Either way, the key `finish_reason` must be present to determine ending chunk.
          if (
            message?.hasOwnProperty("finish_reason") && // Got valid message and it is an object with finish_reason
            message.finish_reason !== "" &&
            message.finish_reason !== null
          ) {
            continue;
          }
        }

        if (!fullText && pendingToolCalls.size === 0) {
          response.removeListener("close", handleAbort);
          stream?.endMeasurement(usage);
          reject(emptyDeepSeekStreamError());
          return;
        }

        if (pendingToolCalls.size > 0) {
          stream.toolCalls = Array.from(pendingToolCalls.entries())
            .sort(([left], [right]) => left - right)
            .map(([, call]) => call);
        } else {
          writeResponseChunk(response, {
            uuid,
            sources,
            type: "textResponseChunk",
            textResponse: "",
            close: true,
            error: false,
          });
        }
        response.removeListener("close", handleAbort);
        stream?.endMeasurement(usage);
        resolve(pendingToolCalls.size > 0 ? "" : fullText);
      } catch (e) {
        console.log(`\x1b[43m\x1b[34m[STREAMING ERROR]\x1b[0m ${e.message}`);
        response.removeListener("close", handleAbort);
        stream?.endMeasurement(usage);
        if (!fullText && pendingToolCalls.size === 0) {
          reject(e);
          return;
        }
        writeResponseChunk(response, {
          uuid,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        resolve(fullText); // Return what we currently have - if anything.
      }
    });
  }

  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  DeepSeekLLM,
  isRecoverableDeepSeekStreamError,
  resilientDeepSeekStream,
  deepSeekUsageMetrics,
  deepSeekPromptShape,
  deepSeekPromptFingerprint,
  deepSeekPromptCacheDiagnostics,
  deepSeekCacheDiagnosis,
  withDeepSeekCacheDiagnosis,
};
