const DEFAULT_PROVIDER_TIMEOUT_MS = 8_000;

class MarketDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MarketDataError";
    this.code = code;
    this.details = details;
  }
}

function normalizedTimeout(value = process.env.AGENT_MARKET_DATA_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000 || parsed > 25_000)
    return DEFAULT_PROVIDER_TIMEOUT_MS;
  return Math.floor(parsed);
}

async function fixedFetch(url, options = {}, fetchImpl = global.fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), normalizedTimeout());
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError")
      throw new MarketDataError(
        "provider_timeout",
        "The data provider timed out."
      );
    throw new MarketDataError(
      "provider_unavailable",
      "The data provider could not be reached."
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, fetchImpl = global.fetch) {
  const response = await fixedFetch(url, options, fetchImpl);
  const text = await response.text();
  if (!response.ok) {
    throw new MarketDataError(
      "provider_http_error",
      `The data provider returned HTTP ${response.status}.`,
      { status: response.status }
    );
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new MarketDataError(
      "provider_invalid_response",
      "The data provider returned invalid JSON."
    );
  }
}

async function fetchText(url, options = {}, fetchImpl = global.fetch) {
  const response = await fixedFetch(url, options, fetchImpl);
  const text = await response.text();
  if (!response.ok) {
    throw new MarketDataError(
      "provider_http_error",
      `The data provider returned HTTP ${response.status}.`,
      { status: response.status }
    );
  }
  return text;
}

function requiredString(input, key) {
  const value = String(input?.[key] || "").trim();
  if (!value) throw new MarketDataError("invalid_input", `${key} is required.`);
  return value;
}

function optionalString(input, key, fallback = "") {
  const value = input?.[key];
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).trim();
}

function numberString(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimal(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits)).toString();
}

function safeError(error, tool) {
  return {
    tool,
    ok: false,
    error: error?.code || "market_data_failed",
    message:
      error instanceof MarketDataError
        ? error.message
        : "The market data request failed.",
    timestamp: new Date().toISOString(),
  };
}

function jsonTool({ name, description, examples = [], parameters, execute }) {
  return {
    name,
    startupConfig: { params: {} },
    plugin: function () {
      return {
        name,
        setup(aibitat) {
          aibitat.function({
            super: aibitat,
            name,
            description,
            examples,
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              ...parameters,
            },
            handler: async function (input = {}) {
              const startedAt = Date.now();
              try {
                return JSON.stringify({
                  ...(await execute(input)),
                  latency_ms: Date.now() - startedAt,
                });
              } catch (error) {
                this.super?.handlerProps?.log?.(
                  `[${name}] ${error?.code || "market_data_failed"}`
                );
                return JSON.stringify({
                  ...safeError(error, name),
                  latency_ms: Date.now() - startedAt,
                });
              }
            },
          });
        },
      };
    },
  };
}

module.exports = {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  MarketDataError,
  decimal,
  fetchJson,
  fetchText,
  jsonTool,
  numberString,
  numeric,
  optionalString,
  requiredString,
  safeError,
};
