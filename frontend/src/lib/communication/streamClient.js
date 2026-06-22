import { fetchEventSource } from "@microsoft/fetch-event-source";
import { apiUrl, jsonHeaders } from "./apiClient";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";

function parseSseJsonMessage(msg) {
  try {
    return JSON.parse(msg.data);
  } catch (error) {
    throw createApiError({
      code: API_ERROR_CODES.STREAM_PARSE_ERROR,
      message: "Failed to parse stream message.",
      details: { data: msg?.data ?? null },
      raw: error,
    });
  }
}

function isAbort(signal, error) {
  return signal?.aborted || error?.name === "AbortError";
}

async function jsonSse({
  method = "GET",
  path,
  body = {},
  signal,
  headers = {},
  openWhenHidden = true,
  onOpen,
  onRawMessage,
  onMessage,
  onClose,
  onError,
  retryOnError = false,
} = {}) {
  const normalizedMethod = method.toUpperCase();
  await fetchEventSource(apiUrl(path), {
    method: normalizedMethod,
    body: normalizedMethod === "GET" ? undefined : JSON.stringify(body),
    headers: jsonHeaders(headers),
    signal,
    openWhenHidden,
    async onopen(response) {
      if (response.ok) {
        await onOpen?.(response);
        return;
      }

      throw normalizeApiError(null, response, {
        code: API_ERROR_CODES.HTTP_OPEN_ERROR,
        status: response.status,
        message:
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
            ? `An error occurred while streaming response. Code ${response.status}`
            : "An error occurred while streaming response. Unknown Error.",
        raw: response,
      });
    },
    async onmessage(msg) {
      await onRawMessage?.(msg);
      const payload = parseSseJsonMessage(msg);
      await onMessage?.(payload, msg);
    },
    onclose() {
      onClose?.();
    },
    onerror(error) {
      if (isAbort(signal, error)) return;

      const apiError =
        error?.code === API_ERROR_CODES.HTTP_OPEN_ERROR ||
        error?.code === API_ERROR_CODES.STREAM_PARSE_ERROR
          ? normalizeApiError(error)
          : normalizeApiError(error, null, {
              code: API_ERROR_CODES.STREAM_RUNTIME_ERROR,
              message: `An error occurred while streaming response. ${
                error?.message || "Unknown error"
              }`,
              raw: error,
            });

      const retryValue = onError?.(apiError);
      if (retryOnError && typeof retryValue === "number") return retryValue;
      throw apiError;
    },
  });
}

export async function getJsonSse(options = {}) {
  return jsonSse({ ...options, method: "GET" });
}

export async function postJsonSse(options = {}) {
  return jsonSse({ ...options, method: "POST" });
}
