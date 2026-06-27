import { apiUrl, formDataHeaders, parseJsonResponse } from "./apiClient";
import { API_ERROR_CODES, createApiError, normalizeApiError } from "./apiError";
import { createCommunicationRequestId } from "./clientIdentity";
import {
  communicationResponseSize,
  recordCommunicationEvent,
} from "./communicationMetrics";

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

function formDataSize(formData) {
  if (!formData?.entries) return 0;
  let size = 0;
  for (const [, value] of formData.entries()) {
    if (value instanceof Blob) {
      size += value.size || 0;
    } else {
      size += String(value ?? "").length;
    }
  }
  return size;
}

function headersFromXhr(xhr) {
  const headers = new Headers();
  const rawHeaders = xhr.getAllResponseHeaders?.() || "";
  rawHeaders
    .trim()
    .split(/[\r\n]+/)
    .filter(Boolean)
    .forEach((line) => {
      const index = line.indexOf(":");
      if (index === -1) return;
      headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    });
  return headers;
}

function uploadWithProgress({
  path,
  formData,
  method,
  headers,
  includeBaseHeaders,
  requestId,
  signal,
  timeoutMs,
  onUploadProgress,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const uploadStartedAt = nowMs();
    let lastProgressAt = uploadStartedAt;
    let lastLoaded = 0;
    let uploadCompletedAt = null;

    const abortFromSignal = () => xhr.abort();
    if (signal?.aborted)
      return reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abortFromSignal, { once: true });

    xhr.open(method, apiUrl(path), true);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) xhr.timeout = timeoutMs;
    Object.entries(formDataHeaders(headers, { includeBaseHeaders, requestId }))
      .filter(([, value]) => value !== undefined && value !== null)
      .forEach(([key, value]) => xhr.setRequestHeader(key, value));

    xhr.upload.onprogress = (event) => {
      const now = nowMs();
      const elapsedMs = Math.max(1, now - uploadStartedAt);
      const deltaMs = Math.max(1, now - lastProgressAt);
      const deltaBytes = Math.max(0, event.loaded - lastLoaded);
      lastProgressAt = now;
      lastLoaded = event.loaded;
      const total = event.lengthComputable
        ? event.total
        : formDataSize(formData);
      const percent = total ? Math.min(100, (event.loaded / total) * 100) : 0;
      const progress = {
        loaded: event.loaded,
        total,
        percent,
        speedBps: Math.round((deltaBytes / deltaMs) * 1000),
        averageSpeedBps: Math.round((event.loaded / elapsedMs) * 1000),
        elapsedMs: Math.round(elapsedMs),
      };
      onUploadProgress?.(progress);
      recordCommunicationEvent({
        requestId,
        type: "reader_upload:progress",
        path,
        loaded: progress.loaded,
        total: progress.total,
        percent: Math.round(progress.percent),
        speedBps: progress.speedBps,
        ok: true,
      });
    };

    xhr.upload.onload = () => {
      uploadCompletedAt = nowMs();
      recordCommunicationEvent({
        requestId,
        type: "reader_upload:server_wait",
        path,
        ok: true,
      });
    };

    xhr.onload = () => {
      signal?.removeEventListener("abort", abortFromSignal);
      const response = new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: headersFromXhr(xhr),
      });
      resolve({
        response,
        uploadDurationMs: uploadCompletedAt
          ? Math.round(uploadCompletedAt - uploadStartedAt)
          : null,
      });
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", abortFromSignal);
      reject(new Error("Upload network error."));
    };
    xhr.ontimeout = () => {
      signal?.removeEventListener("abort", abortFromSignal);
      reject(
        createApiError({
          code: API_ERROR_CODES.API_TIMEOUT_ERROR,
          status: 0,
          message: `Upload timed out after ${timeoutMs}ms.`,
        })
      );
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", abortFromSignal);
      reject(new DOMException("Aborted", "AbortError"));
    };

    xhr.send(formData);
  });
}

export async function uploadFormData(path, formData, options = {}) {
  const {
    signal,
    timeoutMs,
    headers = {},
    includeBaseHeaders = true,
    uploadKind = "unknown",
    method = "POST",
    onUploadProgress,
    ...rest
  } = options;
  const normalizedMethod = method.toUpperCase();
  const requestId = createCommunicationRequestId();
  const startedAt = nowMs();
  const signalState = requestSignal({ signal, timeoutMs });
  const useProgressUpload = typeof onUploadProgress === "function";

  devLog(
    "start",
    uploadLogPayload({
      requestId,
      uploadKind,
      path,
      result: "started",
    })
  );
  if (useProgressUpload) {
    recordCommunicationEvent({
      requestId,
      type: "reader_upload:start",
      method: normalizedMethod,
      path,
      uploadKind,
      requestBytes: formDataSize(formData),
      ok: true,
    });
  }

  try {
    const result = useProgressUpload
      ? await uploadWithProgress({
          path,
          formData,
          method: normalizedMethod,
          headers,
          includeBaseHeaders,
          requestId,
          signal: signalState.signal,
          timeoutMs,
          onUploadProgress,
        })
      : {
          response: await fetch(apiUrl(path), {
            method: normalizedMethod,
            headers: formDataHeaders(headers, {
              includeBaseHeaders,
              requestId,
            }),
            body: formData,
            signal: signalState.signal,
            ...rest,
          }),
        };
    const response = result.response;
    const data = await parseJsonResponse(response);
    const durationMs = durationSince(startedAt);
    const requestBytes = formDataSize(formData);
    const responseBytes = communicationResponseSize(response, data);
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
          durationMs,
          result: "failure",
          code: apiError.code,
          message: apiError.message,
        })
      );
      recordCommunicationEvent({
        requestId,
        type: useProgressUpload ? "reader_upload:fail" : "upload",
        method: normalizedMethod,
        path,
        uploadKind,
        status: response.status,
        durationMs,
        requestBytes,
        responseBytes,
        serverTiming: response.headers?.get?.("Server-Timing") || null,
        ok: false,
      });
      throw apiError;
    }

    devLog(
      "success",
      uploadLogPayload({
        requestId,
        uploadKind,
        path,
        status: response.status,
        durationMs,
        result: data?.success === false ? "success_false" : "success",
      })
    );
    recordCommunicationEvent({
      requestId,
      type: useProgressUpload ? "reader_upload:complete" : "upload",
      method: normalizedMethod,
      path,
      uploadKind,
      status: response.status,
      durationMs,
      requestBytes,
      responseBytes,
      uploadDurationMs: result.uploadDurationMs || null,
      serverWaitMs: result.uploadDurationMs
        ? Math.max(0, durationMs - result.uploadDurationMs)
        : null,
      serverTiming: response.headers?.get?.("Server-Timing") || null,
      ok: true,
    });
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
    recordCommunicationEvent({
      requestId,
      type: "upload",
      method: normalizedMethod,
      path,
      uploadKind,
      status: apiError.status,
      durationMs: durationSince(startedAt),
      requestBytes: formDataSize(formData),
      responseBytes: 0,
      ok: false,
      error: apiError.message,
    });
    throw apiError;
  } finally {
    signalState.cleanup();
  }
}
