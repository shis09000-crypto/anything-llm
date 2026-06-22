import { checkSessionToken } from "@/lib/communication/systemRuntimeClient";

// Checks current localstorage and validates the session based on that.
export default async function validateSessionTokenForUser() {
  const isValidSession = await checkSessionToken()
    .then(({ response }) => response.status === 200)
    .catch(() => false);

  return isValidSession;
}
