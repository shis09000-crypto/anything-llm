import { apiUrl, formDataHeaders, parseJsonResponse } from "./apiClient";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";

export const UPLOAD_KINDS = {
  workspaceFile: "workspace_file",
  readerDocument: "reader_document",
  avatar: "avatar",
  logo: "logo",
  visualAsset: "visual_asset",
  workspaceSupplement: "workspace_supplement",
  nodeSupplement: "node_supplement",
  uploadAndEmbed: "upload_and_embed",
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
  console.debug(`[uploadClient] ${phase}`, metadata);
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

function uploadDetails({
  requestId,
  uploadKind,
  path,
  status = 0,
  code = API_ERROR_CODES.API_ERROR,
  message = "Upload failed.",
  timeoutMs = undefined,
} = {}) {
  return {
    requestId,
    uploadKind,
    path,
    status,
    code,
    message,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function uploadLogPayload({
  requestId,
  uploadKind,
  path,
  status = 0,
  durationMs = 0,
  result,
  code,
  message,
} = {}) {
  return {
    requestId,
    uploadKind,
    path,
    status,
    durationMs,
    result,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

export async function uploadFormData(path, formData, options = {}) {
  const {
    signal,
    timeoutMs,
    headers = {},
    includeBaseHeaders = true,
    uploadKind = "unknown",
    method = "POST",
    ...rest
  } = options;
  const normalizedMethod = method.toUpperCase();
  const requestId = createRequestId();
  const startedAt = nowMs();
  const signalState = requestSignal({ signal, timeoutMs });

  devLog(
    "start",
    uploadLogPayload({
      requestId,
      uploadKind,
      path,
      result: "started",
    })
  );

  try {
    const response = await fetch(apiUrl(path), {
      method: normalizedMethod,
      headers: formDataHeaders(headers, { includeBaseHeaders }),
      body: formData,
      signal: signalState.signal,
      ...rest,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) {
      const message =
        data?.error ||
        data?.message ||
        `Upload failed with status ${response.status}.`;
      const apiError = normalizeApiError(null, response, {
        code: API_ERROR_CODES.HTTP_OPEN_ERROR,
        message,
        details: uploadDetails({
          requestId,
          uploadKind,
          path,
          status: response.status,
          code: API_ERROR_CODES.HTTP_OPEN_ERROR,
          message,
        }),
        raw: data,
      });
      devLog(
        "failure",
        uploadLogPayload({
          requestId,
          uploadKind,
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

    devLog(
      "success",
      uploadLogPayload({
        requestId,
        uploadKind,
        path,
        status: response.status,
        durationMs: durationSince(startedAt),
        result: data?.success === false ? "success_false" : "success",
      })
    );
    return { response, data, requestId };
  } catch (error) {
    if (signalState.didTimeout()) {
      const message = `Upload timed out after ${timeoutMs}ms.`;
      const apiError = createApiError({
        code: API_ERROR_CODES.API_TIMEOUT_ERROR,
        status: 0,
        message,
        details: uploadDetails({
          requestId,
          uploadKind,
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
        uploadLogPayload({
          requestId,
          uploadKind,
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
    if (error?.ok === false) throw error;

    const apiError = normalizeApiError(error, null, {
      details: uploadDetails({
        requestId,
        uploadKind,
        path,
        status: error?.status || 0,
        code: error?.code || API_ERROR_CODES.API_ERROR,
        message: error?.message || "Upload failed.",
      }),
    });
    devLog(
      "failure",
      uploadLogPayload({
        requestId,
        uploadKind,
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
