import { fetchEventSource } from "@microsoft/fetch-event-source";
import { apiUrl, jsonHeaders } from "./apiClient";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";
import { createCommunicationRequestId } from "./clientIdentity";
import {
  communicationByteLength,
  recordCommunicationEvent,
} from "./communicationMetrics";

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function parseSseJsonMessage(msg, { requestId, path } = {}) {
  try {
    return JSON.parse(msg.data);
  } catch (error) {
    throw createApiError({
      code: API_ERROR_CODES.STREAM_PARSE_ERROR,
      message: "Failed to parse stream message.",
      details: { requestId, path, data: msg?.data ?? null },
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
  communicationScene = null,
} = {}) {
  const normalizedMethod = method.toUpperCase();
  const requestId = createCommunicationRequestId();
  const startedAt = nowMs();
  const bodyString = normalizedMethod === "GET" ? "" : JSON.stringify(body);
  let eventCount = 0;
  await fetchEventSource(apiUrl(path), {
    method: normalizedMethod,
    body: bodyString || undefined,
    headers: jsonHeaders(headers, { requestId }),
    signal,
    openWhenHidden,
    async onopen(response) {
      if (response.ok) {
        recordCommunicationEvent({
          requestId,
          type: "sse-open",
          method: normalizedMethod,
          path,
          status: response.status,
          durationMs: Math.round(nowMs() - startedAt),
          requestBytes: communicationByteLength(bodyString),
          responseBytes: 0,
          communicationScene,
          serverTiming: response.headers?.get?.("Server-Timing") || null,
          ok: true,
        });
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
        details: { requestId, method: normalizedMethod, path },
      });
    },
    async onmessage(msg) {
      eventCount += 1;
      await onRawMessage?.(msg);
      const payload = parseSseJsonMessage(msg, { requestId, path });
      await onMessage?.(payload, msg);
    },
    onclose() {
      recordCommunicationEvent({
        requestId,
        type: "sse-close",
        method: normalizedMethod,
        path,
        status: 200,
        durationMs: Math.round(nowMs() - startedAt),
        requestBytes: communicationByteLength(bodyString),
        responseBytes: 0,
        eventCount,
        communicationScene,
        ok: true,
      });
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
              details: { requestId, method: normalizedMethod, path },
              raw: error,
            });

      const retryValue = onError?.(apiError);
      recordCommunicationEvent({
        requestId,
        type: "sse-error",
        method: normalizedMethod,
        path,
        status: apiError.status,
        durationMs: Math.round(nowMs() - startedAt),
        requestBytes: communicationByteLength(bodyString),
        responseBytes: 0,
        eventCount,
        communicationScene,
        ok: false,
        error: apiError.message,
      });
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
