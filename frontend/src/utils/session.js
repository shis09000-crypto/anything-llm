import { checkSessionToken } from "@/lib/communication/systemRuntimeClient";
import { AUTH_TIMESTAMP } from "@/utils/constants";
import { shouldPreserveLocalAuthOnFailure } from "@/utils/authSessionMaintenance";

const SESSION_VALIDATION_TTL_MS = 60 * 5 * 1000;

function hasRecentSessionValidation() {
  if (typeof window === "undefined") return false;
  const lastAuthCheck = window.localStorage.getItem(AUTH_TIMESTAMP);
  if (!lastAuthCheck) return false;
  const checkedAt = Number(lastAuthCheck);
  if (!Number.isFinite(checkedAt)) return false;
  return Date.now() - checkedAt < SESSION_VALIDATION_TTL_MS;
}

// Checks current localstorage and validates the session based on that.
export default async function validateSessionTokenForUser() {
  if (hasRecentSessionValidation()) return true;

  const isValidSession = await checkSessionToken()
    .then(({ response }) => response.status === 200)
    .catch((error) => {
      if (shouldPreserveLocalAuthOnFailure(error)) return true;
      return false;
    });

  if (isValidSession) {
    window.localStorage.setItem(AUTH_TIMESTAMP, Number(new Date()));
  }
  return isValidSession;
}
