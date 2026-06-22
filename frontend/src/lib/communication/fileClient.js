import { jsonHeaders } from "./apiClient";
import {
  BLOB_KINDS,
  downloadUrl,
  requestBlob,
  requestText,
} from "./blobClient";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";

export const FILE_KINDS = {
  generatedFile: BLOB_KINDS.generatedFile,
  exportText: BLOB_KINDS.exportText,
  modelDownloadStream: BLOB_KINDS.modelDownloadStream,
};

function createRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function durationSince(startedAt) {
  return Math.round(nowMs() - startedAt);
}

function devLog(phase, metadata = {}) {
  if (!import.meta.env.DEV) return;
  console.debug(`[fileClient] ${phase}`, metadata);
}

function requestSignal({ signal, timeoutMs }) {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout) {
    return {
      signal,
      cleanup: () => {},
      didTimeout: () => false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort(signal?.reason);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (signal?.aborted) {
    abortFromExternal();
  } else {
    signal?.addEventListener("abort", abortFromExternal, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromExternal);
    },
    didTimeout: () => timedOut,
  };
}

export function getResponseFilename(response) {
  const header = response?.headers?.get?.("Content-Disposition");
  if (!header) return null;

  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return utf8Match[1].trim().replace(/^"|"$/g, "");
    }
  }

  const filenameMatch = header.match(/filename\s*=\s*("([^"]+)"|[^;]+)/i);
  if (!filenameMatch?.[1]) return null;
  return (filenameMatch[2] || filenameMatch[1]).trim().replace(/^"|"$/g, "");
}

export function getResponseContentType(response) {
  return response?.headers?.get?.("Content-Type") || null;
}

export function downloadBlobFile(path, options = {}) {
  return requestBlob(path, {
    blobKind: FILE_KINDS.generatedFile,
    ...options,
  });
}

export function downloadTextFile(path, options = {}) {
  return requestText(path, {
    blobKind: FILE_KINDS.exportText,
    ...options,
  });
}

async function parseErrorBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text || response.statusText };
  }
}

function streamDetails({
  requestId,
  blobKind,
  path,
  status = 0,
  code = API_ERROR_CODES.STREAM_RUNTIME_ERROR,
  message = "Download stream failed.",
  timeoutMs = undefined,
} = {}) {
  return {
    requestId,
    blobKind,
    path,
    status,
    code,
    message,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function logPayload({
  requestId,
  blobKind,
  path,
  status = 0,
  durationMs = 0,
  result,
  code,
  message,
} = {}) {
  return {
    requestId,
    blobKind,
    path,
    status,
    durationMs,
    result,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function parseSseEvent(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data);
}

export async function postJsonDownloadEventStream(
  path,
  body = {},
  options = {}
) {
  const {
    signal,
    timeoutMs,
    headers = {},
    includeBaseHeaders = true,
    blobKind = FILE_KINDS.modelDownloadStream,
    onEvent = () => {},
    onChunk = null,
    ...rest
  } = options;
  const requestId = createRequestId();
  const startedAt = nowMs();
  const signalState = requestSignal({ signal, timeoutMs });

  devLog(
    "start",
    logPayload({
      requestId,
      blobKind,
      path,
      result: "started",
    })
  );

  try {
    const response = await fetch(downloadUrl(path), {
      method: "POST",
      headers: jsonHeaders(headers, { includeBaseHeaders }),
      body: JSON.stringify(body),
      signal: signalState.signal,
      ...rest,
    });

    if (!response.ok) {
      const raw = await parseErrorBody(response.clone());
      const message =
        raw?.error ||
        raw?.message ||
        `Download stream failed with status ${response.status}.`;
      const apiError = normalizeApiError(null, response, {
        code: API_ERROR_CODES.HTTP_OPEN_ERROR,
        message,
        details: streamDetails({
          requestId,
          blobKind,
          path,
          status: response.status,
          code: API_ERROR_CODES.HTTP_OPEN_ERROR,
          message,
        }),
        raw,
      });
      devLog(
        "failure",
        logPayload({
          requestId,
          blobKind,
          path,
          status: response.status,
          durationMs: durationSince(startedAt),
          result: "failure",
          code: apiError.code,
          message: apiError.message,
        })
      );
      throw apiError;
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      throw createApiError({
        code: API_ERROR_CODES.STREAM_RUNTIME_ERROR,
        status: response.status,
        message: "Download stream body is unavailable.",
        details: streamDetails({
          requestId,
          blobKind,
          path,
          status: response.status,
          code: API_ERROR_CODES.STREAM_RUNTIME_ERROR,
          message: "Download stream body is unavailable.",
        }),
        raw: response,
      });
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let eventCount = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      onChunk?.(chunk);
      buffer += chunk;

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (!block.trim()) continue;
        let event;
        try {
          event = parseSseEvent(block);
        } catch (error) {
          throw createApiError({
            code: API_ERROR_CODES.STREAM_PARSE_ERROR,
            status: response.status,
            message: error?.message || "Download stream event parse failed.",
            details: streamDetails({
              requestId,
              blobKind,
              path,
              status: response.status,
              code: API_ERROR_CODES.STREAM_PARSE_ERROR,
              message: error?.message || "Download stream event parse failed.",
            }),
            raw: { block, error },
          });
        }
        if (!event) continue;
        eventCount += 1;
        onEvent(event);
      }
    }

    const tail = `${buffer}${decoder.decode()}`.trim();
    if (tail) {
      let event;
      try {
        event = parseSseEvent(tail);
      } catch (error) {
        throw createApiError({
          code: API_ERROR_CODES.STREAM_PARSE_ERROR,
          status: response.status,
          message: error?.message || "Download stream event parse failed.",
          details: streamDetails({
            requestId,
            blobKind,
            path,
            status: response.status,
            code: API_ERROR_CODES.STREAM_PARSE_ERROR,
            message: error?.message || "Download stream event parse failed.",
          }),
          raw: { block: tail, error },
        });
      }
      if (event) {
        eventCount += 1;
        onEvent(event);
      }
    }

    devLog(
      "success",
      logPayload({
        requestId,
        blobKind,
        path,
        status: response.status,
        durationMs: durationSince(startedAt),
        result: "success",
      })
    );

    return { response, requestId, eventCount };
  } catch (error) {
    if (signalState.didTimeout()) {
      const message = `Download stream timed out after ${timeoutMs}ms.`;
      const apiError = createApiError({
        code: API_ERROR_CODES.API_TIMEOUT_ERROR,
        status: 0,
        message,
        details: streamDetails({
          requestId,
          blobKind,
          path,
          status: 0,
          code: API_ERROR_CODES.API_TIMEOUT_ERROR,
          message,
          timeoutMs,
        }),
        raw: error,
      });
      devLog(
        "timeout",
        logPayload({
          requestId,
          blobKind,
          path,
          status: 0,
          durationMs: durationSince(startedAt),
          result: "timeout",
          code: apiError.code,
          message: apiError.message,
        })
      );
      throw apiError;
    }
    if (error?.name === "AbortError") throw error;
    if (error?.ok === false) {
      if (error.code !== API_ERROR_CODES.HTTP_OPEN_ERROR) {
        devLog(
          "failure",
          logPayload({
            requestId,
            blobKind,
            path,
            status: error.status,
            durationMs: durationSince(startedAt),
            result: "failure",
            code: error.code,
            message: error.message,
          })
        );
      }
      throw error;
    }

    const apiError = normalizeApiError(error, null, {
      code: API_ERROR_CODES.STREAM_RUNTIME_ERROR,
      details: streamDetails({
        requestId,
        blobKind,
        path,
        status: error?.status || 0,
        code: API_ERROR_CODES.STREAM_RUNTIME_ERROR,
        message: error?.message || "Download stream failed.",
      }),
    });
    devLog(
      "failure",
      logPayload({
        requestId,
        blobKind,
        path,
        status: apiError.status,
        durationMs: durationSince(startedAt),
        result: "failure",
        code: apiError.code,
        message: apiError.message,
      })
    );
    throw apiError;
  } finally {
    signalState.cleanup();
  }
}
