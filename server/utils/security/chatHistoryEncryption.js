const {
  decryptSecretIfNeeded,
  encryptSecret,
  isEncryptedSecret,
} = require("./encryption");
const { MASTER_KEY_ENV } = require("./constants");

function chatHistoryEncryptionEnabled(env = process.env) {
  if (String(env.CHAT_HISTORY_ENCRYPTION || "").toLowerCase() === "false")
    return false;
  if (
    String(env.CHAT_HISTORY_ENCRYPTION_DISABLED || "").toLowerCase() === "true"
  )
    return false;
  return Boolean(String(env[MASTER_KEY_ENV] || "").trim());
}

function encryptWorkspaceChatField(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!chatHistoryEncryptionEnabled()) return text;
  return encryptSecret(text);
}

function decryptWorkspaceChatField(value) {
  if (value === null || value === undefined) return value;
  return decryptSecretIfNeeded(value);
}

function workspaceChatFieldIsEncrypted(value) {
  return isEncryptedSecret(value);
}

function decryptWorkspaceChatRecord(chat = null) {
  if (!chat) return chat;
  return {
    ...chat,
    prompt: decryptWorkspaceChatField(chat.prompt),
    response: decryptWorkspaceChatField(chat.response),
  };
}

function decryptWorkspaceChatRecords(chats = []) {
  if (!Array.isArray(chats)) return [];
  return chats.map(decryptWorkspaceChatRecord);
}

function encryptWorkspaceChatWrite(data = {}) {
  const next = { ...(data || {}) };
  if (Object.prototype.hasOwnProperty.call(next, "prompt")) {
    next.prompt = encryptWorkspaceChatField(next.prompt);
  }
  if (Object.prototype.hasOwnProperty.call(next, "response")) {
    next.response = encryptWorkspaceChatField(next.response);
  }
  return next;
}

module.exports = {
  chatHistoryEncryptionEnabled,
  decryptWorkspaceChatField,
  decryptWorkspaceChatRecord,
  decryptWorkspaceChatRecords,
  encryptWorkspaceChatField,
  encryptWorkspaceChatWrite,
  workspaceChatFieldIsEncrypted,
};
