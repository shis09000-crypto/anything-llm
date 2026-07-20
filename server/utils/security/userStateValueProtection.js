const { safeJsonParse } = require("../http");
const {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} = require("./encryption");

const PROTECTED_USER_STATE_VERSION = "athena-user-state-server:v1";
const CHAT_DRAFT_NAMESPACE = "chat.draft";
const CHAT_DRAFT_PURPOSE = "user-state:chat-draft";

function isProtectedUserStateValue(value = null) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.protectionVersion === PROTECTED_USER_STATE_VERSION &&
      isEncryptedSecret(value.envelope)
  );
}

function storageBinding({ userId, namespace, scope }) {
  return {
    userId: Number(userId),
    namespace: String(namespace),
    scope: String(scope || "global"),
  };
}

function encodeUserStateValue({ userId, namespace, scope, value } = {}) {
  if (namespace !== CHAT_DRAFT_NAMESPACE) return JSON.stringify(value ?? null);
  const binding = storageBinding({ userId, namespace, scope });
  const envelope = encryptSecret(
    JSON.stringify({ ...binding, value: value ?? null }),
    {
      domain: "user-state",
      purpose: CHAT_DRAFT_PURPOSE,
      operation: "encrypt-chat-draft",
      resource: `user:${binding.userId}`,
    }
  );
  return JSON.stringify({
    protectionVersion: PROTECTED_USER_STATE_VERSION,
    envelope,
  });
}

function decodeUserStateValue({ userId, namespace, scope, storedValue } = {}) {
  const parsed =
    typeof storedValue === "string"
      ? safeJsonParse(storedValue, null)
      : storedValue;
  if (!isProtectedUserStateValue(parsed)) return parsed;

  const binding = storageBinding({ userId, namespace, scope });
  const payload = safeJsonParse(
    decryptSecret(parsed.envelope, {
      domain: "user-state",
      purpose: CHAT_DRAFT_PURPOSE,
      operation: "decrypt-chat-draft",
      resource: `user:${binding.userId}`,
    }),
    null
  );
  if (
    !payload ||
    Number(payload.userId) !== binding.userId ||
    payload.namespace !== binding.namespace ||
    payload.scope !== binding.scope
  ) {
    const error = new Error("protected_user_state_binding_mismatch");
    error.code = "protected_user_state_binding_mismatch";
    throw error;
  }
  return payload.value ?? null;
}

module.exports = {
  CHAT_DRAFT_NAMESPACE,
  PROTECTED_USER_STATE_VERSION,
  decodeUserStateValue,
  encodeUserStateValue,
  isProtectedUserStateValue,
};
