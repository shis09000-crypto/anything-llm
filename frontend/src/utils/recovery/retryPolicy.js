import { API_ERROR_CODES } from "../../lib/communication/apiError.js";
import {
  RECOVERY_CLASSIFICATIONS,
  recoveryErrorCode,
  recoveryErrorMessage,
} from "./errorClassifier.js";

const SIGNING_RETRY_CODES = new Set([
  API_ERROR_CODES.INVALID_SIGNATURE,
  API_ERROR_CODES.SIGNING_SECRET_ROTATED,
]);

function retryAttemptFrom(error = null, context = {}) {
  const attempt = Number(
    context.retryAttempt ??
      error?.details?.retryAttempt ??
      error?.retryAttempt ??
      0
  );
  return Number.isFinite(attempt) && attempt >= 0 ? attempt : 0;
}

function retryableNetwork(error = null) {
  const message = recoveryErrorMessage(error);
  return /failed to fetch|network|timeout|timed out|connection|stream|websocket|sse/i.test(
    message
  );
}

export function retryPolicyFor(error = null, context = {}, classified = {}) {
  const code = recoveryErrorCode(error);
  const classification = classified.classification;
  const attempt = retryAttemptFrom(error, context);
  const signingRetry = SIGNING_RETRY_CODES.has(code);
  const backgroundRetry =
    classification === RECOVERY_CLASSIFICATIONS.background &&
    (retryableNetwork(error) || classified.reason === "background");
  const foregroundRetry =
    classification === RECOVERY_CLASSIFICATIONS.retryable ||
    retryableNetwork(error);
  const maxAttempts = signingRetry
    ? 1
    : (context.maxRetryAttempts ??
      (context.source === "agent" || context.source === "crypto" ? 3 : 1));
  const shouldRetry =
    !classified.silent &&
    !classified.shouldReauth &&
    (signingRetry || foregroundRetry || backgroundRetry) &&
    attempt < maxAttempts;

  return {
    shouldRetry,
    retryAttempt: attempt,
    maxAttempts,
    delayMs: signingRetry ? 0 : Math.min(1_000 * 2 ** attempt, 8_000),
    recoveryAction: signingRetry
      ? "refresh-signing-secret"
      : shouldRetry
        ? "retry"
        : classified.recoveryAction || null,
  };
}
