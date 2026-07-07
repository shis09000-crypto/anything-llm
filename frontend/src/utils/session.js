import { checkSessionToken } from "@/lib/communication/systemRuntimeClient";
import { AUTH_TIMESTAMP } from "@/utils/constants";
import { shouldPreserveLocalAuthOnFailure } from "@/utils/authSessionMaintenance";

const SESSION_VALIDATION_TTL_MS = 60 * 5 * 1000;
export const SESSION_VALIDATION_STATE = {
  VALID: "valid",
  TRANSIENT: "transient",
  INVALID: "invalid",
};

function hasRecentSessionValidation() {
  if (typeof window === "undefined") return false;
  const lastAuthCheck = window.localStorage.getItem(AUTH_TIMESTAMP);
  if (!lastAuthCheck) return false;
  const checkedAt = Number(lastAuthCheck);
  if (!Number.isFinite(checkedAt)) return false;
  return Date.now() - checkedAt < SESSION_VALIDATION_TTL_MS;
}

// Checks current localstorage and validates the session based on that.
export async function validateSessionTokenForUserDetailed() {
  if (hasRecentSessionValidation()) {
    return {
      state: SESSION_VALIDATION_STATE.VALID,
      valid: true,
      transient: false,
      reason: "recent",
    };
  }

  try {
    const { response } = await checkSessionToken({
      timeoutMs: 8_000,
      communicationScene: "auth-bootstrap",
    });
    const isValid = response.status === 200;

    if (isValid) {
      window.localStorage.setItem(AUTH_TIMESTAMP, Number(new Date()));
      return {
        state: SESSION_VALIDATION_STATE.VALID,
        valid: true,
        transient: false,
        reason: "server",
      };
    }

    return {
      state: SESSION_VALIDATION_STATE.INVALID,
      valid: false,
      transient: false,
      reason: `status:${response.status}`,
    };
  } catch (error) {
    if (shouldPreserveLocalAuthOnFailure(error)) {
      return {
        state: SESSION_VALIDATION_STATE.TRANSIENT,
        valid: true,
        transient: true,
        reason: "transient",
      };
    }

    return {
      state: SESSION_VALIDATION_STATE.INVALID,
      valid: false,
      transient: false,
      reason: "error",
    };
  }
}

export default async function validateSessionTokenForUser() {
  const result = await validateSessionTokenForUserDetailed();
  return result.valid;
}
