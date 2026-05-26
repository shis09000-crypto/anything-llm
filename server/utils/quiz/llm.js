const { DeepSeekLLM } = require("../AiProviders/deepseek");
const { safeJsonParse } = require("../http");
const {
  QUIZ_JSON_RESPONSE_FORMAT,
  QUIZ_PLAN_MODEL,
  QUIZ_GENERATION_MODEL,
  QUIZ_GENERATION_FALLBACK_MODEL,
  QUIZ_ANALYSIS_MODEL,
} = require("./constants");

const DEFAULT_RETRY_DELAYS_MS = [800, 1600];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_STREAM_TIMEOUT_MS = 210_000;

function quizLLM(model) {
  return new DeepSeekLLM(null, model);
}

function stripThinkBlocks(text = "") {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function parseJsonResponse(text = "", fallback = null) {
  return safeJsonParse(stripThinkBlocks(text), fallback);
}

async function completeJson({
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.1,
}) {
  const LLMConnector = quizLLM(model);
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const { textResponse, metrics } = await LLMConnector.getChatCompletion(
    messages,
    {
      temperature,
      responseFormat: QUIZ_JSON_RESPONSE_FORMAT,
    }
  );
  return {
    json: parseJsonResponse(textResponse, null),
    textResponse: stripThinkBlocks(textResponse),
    metrics,
    model,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(timeoutMs, phase = "first_token") {
  const error = new Error(`quiz_llm_timeout_after_${timeoutMs}ms`);
  error.code = "quiz_llm_timeout";
  error.quizErrorCode = "QUIZ_GENERATION_TIMEOUT";
  error.phase = phase;
  return error;
}

async function withTimeout(
  promise,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  phase = "first_token"
) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(timeoutError(timeoutMs, phase)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function completeJsonWithRetry({
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.1,
  label = "quiz_json",
  maxAttempts = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        completeJson({ model, systemPrompt, userPrompt, temperature }),
        timeoutMs
      );
      console.log(
        `[QuizLLM] ${label} succeeded model=${model} attempt=${attempt} durationMs=${Date.now() - startedAt}`
      );
      return result;
    } catch (error) {
      lastError = error;
      console.error(
        `[QuizLLM] ${label} failed model=${model} attempt=${attempt} durationMs=${Date.now() - startedAt}`,
        error
      );
      if (attempt >= maxAttempts) break;
      const delay = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0;
      console.log(
        `[QuizLLM] ${label} retrying model=${model} nextAttempt=${attempt + 1} delayMs=${delay}`
      );
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError || new Error(`${label}_failed`);
}

async function completeJsonStream({
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_STREAM_TIMEOUT_MS,
}) {
  const LLMConnector = quizLLM(model);
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const stream = await LLMConnector.streamGetChatCompletion(messages, {
    temperature,
    responseFormat: QUIZ_JSON_RESPONSE_FORMAT,
  });

  let textResponse = "";
  let sawOutput = false;
  const usage = { completion_tokens: 0 };
  const iterator = stream[Symbol.asyncIterator]();
  const startedAt = Date.now();

  function remainingTotalMs() {
    return Math.max(0, totalTimeoutMs - (Date.now() - startedAt));
  }

  try {
    while (true) {
      const remaining = remainingTotalMs();
      if (remaining <= 0) throw timeoutError(totalTimeoutMs, "total_stream");
      const nextTimeout = sawOutput
        ? remaining
        : Math.min(timeoutMs, remaining);
      const next = await withTimeout(
        iterator.next(),
        nextTimeout,
        sawOutput ? "total_stream" : "first_token"
      );
      if (next.done) break;

      const message = next.value?.choices?.[0];
      const token = message?.delta?.content;
      const reasoningToken = message?.delta?.reasoning_content;
      if (token || reasoningToken) sawOutput = true;
      if (token) {
        textResponse += token;
        usage.completion_tokens++;
      }
      if (
        message?.hasOwnProperty("finish_reason") &&
        message.finish_reason !== "" &&
        message.finish_reason !== null
      ) {
        break;
      }
    }
  } finally {
    stream?.endMeasurement?.(usage);
  }

  return {
    json: parseJsonResponse(textResponse, null),
    textResponse: stripThinkBlocks(textResponse),
    metrics: {},
    model,
  };
}

function isTimeoutError(error) {
  return error?.code === "quiz_llm_timeout";
}

async function completeJsonStreamAttempts({
  model,
  systemPrompt,
  userPrompt,
  temperature,
  label,
  maxAttempts,
  timeoutMs,
  totalTimeoutMs,
  retryDelaysMs,
}) {
  const errors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await completeJsonStream({
        model,
        systemPrompt,
        userPrompt,
        temperature,
        timeoutMs,
        totalTimeoutMs,
      });
      console.log(
        `[QuizLLM] ${label} stream succeeded model=${model} attempt=${attempt} durationMs=${Date.now() - startedAt}`
      );
      return { result, errors };
    } catch (error) {
      errors.push(error);
      console.error(
        `[QuizLLM] ${label} stream failed model=${model} attempt=${attempt} durationMs=${Date.now() - startedAt}`,
        error
      );
      if (attempt >= maxAttempts) break;
      const delay = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0;
      console.log(
        `[QuizLLM] ${label} stream retrying model=${model} nextAttempt=${attempt + 1} delayMs=${delay}`
      );
      if (delay > 0) await sleep(delay);
    }
  }
  return { result: null, errors };
}

async function completeJsonStreamWithRetry({
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.1,
  label = "quiz_json_stream",
  maxAttempts = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_STREAM_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  fallbackModel = QUIZ_GENERATION_FALLBACK_MODEL,
}) {
  const primary = await completeJsonStreamAttempts({
    model,
    systemPrompt,
    userPrompt,
    temperature,
    label,
    maxAttempts,
    timeoutMs,
    totalTimeoutMs,
    retryDelaysMs,
  });
  if (primary.result) return primary.result;

  const onlyTimeouts =
    primary.errors.length === maxAttempts &&
    primary.errors.every(isTimeoutError);
  if (onlyTimeouts && fallbackModel && fallbackModel !== model) {
    console.warn(
      `[QuizLLM] ${label} falling back after timeouts primaryModel=${model} fallbackModel=${fallbackModel}`
    );
    const fallback = await completeJsonStreamAttempts({
      model: fallbackModel,
      systemPrompt,
      userPrompt,
      temperature,
      label: `${label}_fallback`,
      maxAttempts: 1,
      timeoutMs,
      totalTimeoutMs,
      retryDelaysMs: [],
    });
    if (fallback.result) return fallback.result;
    throw (
      fallback.errors[0] ||
      primary.errors.at(-1) ||
      new Error(`${label}_failed`)
    );
  }

  throw primary.errors.at(-1) || new Error(`${label}_failed`);
}

async function completeText({
  model,
  systemPrompt,
  userPrompt,
  temperature = 0.2,
}) {
  const LLMConnector = quizLLM(model);
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt,
      userPrompt,
      contextTexts: [],
      chatHistory: [],
      attachments: [],
    },
    []
  );
  const { textResponse, metrics } = await LLMConnector.getChatCompletion(
    messages,
    { temperature }
  );
  return { text: stripThinkBlocks(textResponse), metrics, model };
}

module.exports = {
  quizLLM,
  completeJson,
  completeJsonWithRetry,
  completeJsonStream,
  completeJsonStreamWithRetry,
  completeText,
  parseJsonResponse,
  stripThinkBlocks,
  QUIZ_PLAN_MODEL,
  QUIZ_GENERATION_MODEL,
  QUIZ_GENERATION_FALLBACK_MODEL,
  QUIZ_ANALYSIS_MODEL,
};
