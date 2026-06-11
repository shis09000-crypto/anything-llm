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
} = require("./promptCache");

class DeepSeekLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.DEEPSEEK_API_KEY)
      throw new Error("No DeepSeek API key was set.");
    this.className = "DeepSeekLLM";
    const { OpenAI: OpenAIApi } = require("openai");

    this.openai = new OpenAIApi({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com/v1",
    });
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

  promptCacheDiagnostics(messages = [], { historyWindow = null } = {}) {
    return deepSeekPromptCacheDiagnostics({
      provider: this.className,
      model: this.model,
      messages,
      historyWindow,
      providerPath: "workspace-chat",
    });
  }

  /**
   * Parses and prepends reasoning from the response and returns the full text response.
   * @param {Object} response
   * @returns {string}
   */
  #parseReasoningFromResponse({ message }) {
    let textResponse = message?.content;
    if (
      !!message?.reasoning_content &&
      message.reasoning_content.trim().length > 0
    )
      textResponse = `<think>${message.reasoning_content}</think>${textResponse}`;
    return textResponse;
  }

  async getChatCompletion(
    messages = null,
    { temperature = 0.7, responseFormat = null } = {}
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
          temperature,
          ...(responseFormat ? { response_format: responseFormat } : {}),
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
    const completionTokens = usage.completion_tokens || 0;
    const metrics = {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: completionTokens,
      total_tokens: usage.total_tokens || 0,
      ...deepSeekUsageMetrics(usage),
      outputTps: completionTokens / result.duration,
      duration: result.duration,
      model: this.model,
      provider: this.className,
      timestamp: new Date(),
    };

    return {
      textResponse: this.#parseReasoningFromResponse(result.output.choices[0]),
      metrics,
    };
  }

  async streamGetChatCompletion(
    messages = null,
    { temperature = 0.7, responseFormat = null } = {}
  ) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `DeepSeek chat: ${this.model} is not valid for chat completion!`
      );

    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream({
      func: this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        temperature,
        stream_options: {
          include_usage: true,
        },
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
      messages,
      runPromptTokenCalculation: false,
      modelTag: this.model,
      provider: this.className,
    });

    return measuredStreamRequest;
  }

  // TODO: This is a copy of the generic handleStream function in responses.js
  // to specifically handle the DeepSeek reasoning model `reasoning_content` field.
  // When or if ever possible, we should refactor this to be in the generic function.
  handleStream(response, stream, responseProps) {
    const { uuid = uuidv4(), sources = [] } = responseProps;
    let hasUsageMetrics = false;
    let usage = {
      completion_tokens: 0,
    };

    return new Promise(async (resolve) => {
      let fullText = "";
      let reasoningText = "";

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
          const reasoningToken = message?.delta?.reasoning_content;

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

          // Reasoning models will always return the reasoning text before the token text.
          if (reasoningToken) {
            // If the reasoning text is empty (''), we need to initialize it
            // and send the first chunk of reasoning text.
            if (reasoningText.length === 0) {
              writeResponseChunk(response, {
                uuid,
                sources: [],
                type: "textResponseChunk",
                textResponse: `<think>${reasoningToken}`,
                close: false,
                error: false,
              });
              reasoningText += `<think>${reasoningToken}`;
              continue;
            } else {
              writeResponseChunk(response, {
                uuid,
                sources: [],
                type: "textResponseChunk",
                textResponse: reasoningToken,
                close: false,
                error: false,
              });
              reasoningText += reasoningToken;
            }
          }

          // If the reasoning text is not empty, but the reasoning token is empty
          // and the token text is not empty we need to close the reasoning text and begin sending the token text.
          if (!!reasoningText && !reasoningToken && token) {
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: `</think>`,
              close: false,
              error: false,
            });
            fullText += `${reasoningText}</think>`;
            reasoningText = "";
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

        writeResponseChunk(response, {
          uuid,
          sources,
          type: "textResponseChunk",
          textResponse: "",
          close: true,
          error: false,
        });
        response.removeListener("close", handleAbort);
        stream?.endMeasurement(usage);
        resolve(fullText);
      } catch (e) {
        console.log(`\x1b[43m\x1b[34m[STREAMING ERROR]\x1b[0m ${e.message}`);
        writeResponseChunk(response, {
          uuid,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        stream?.endMeasurement(usage);
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
  deepSeekUsageMetrics,
  deepSeekPromptShape,
  deepSeekPromptFingerprint,
  deepSeekPromptCacheDiagnostics,
};
