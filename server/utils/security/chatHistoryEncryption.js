const { decryptSecretIfNeeded, encryptSecret } = require("./encryption");
const { resolveActiveKey } = require("./keyCustody");
const {
  appendChatCryptoMetadataForRows,
  chatHistorySerialEncryptionEnabled,
  decryptChatRecordCompat,
  decryptChatRecordsCompat,
  encryptSerialChatField,
  isAnyEncryptedChatField,
  rebuildChatCryptoChainForScope,
  rebuildChatCryptoChainFromChatId,
  scopeFromChat,
} = require("./chatHistorySerialEncryption");

function chatHistoryEncryptionEnabled(env = process.env) {
  if (String(env.CHAT_HISTORY_ENCRYPTION || "").toLowerCase() === "false")
    return false;
  if (
    String(env.CHAT_HISTORY_ENCRYPTION_DISABLED || "").toLowerCase() === "true"
  )
    return false;
  try {
    return Boolean(resolveActiveKey());
  } catch {
    return false;
  }
}

function encryptWorkspaceChatField(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!chatHistoryEncryptionEnabled()) return text;
  return encryptSecret(text);
}

async function encryptWorkspaceChatFieldAsync(value, scope = {}) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!chatHistoryEncryptionEnabled()) return text;
  if (chatHistorySerialEncryptionEnabled()) {
    return encryptSerialChatField(text, scope);
  }
  return encryptSecret(text);
}

function decryptWorkspaceChatField(value) {
  if (value === null || value === undefined) return value;
  return decryptSecretIfNeeded(value);
}

function workspaceChatFieldIsEncrypted(value) {
  return isAnyEncryptedChatField(value);
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

async function decryptWorkspaceChatRecordAsync(chat = null) {
  return decryptChatRecordCompat(chat);
}

async function decryptWorkspaceChatRecordsAsync(chats = []) {
  return decryptChatRecordsCompat(chats);
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

async function encryptWorkspaceChatWriteAsync(data = {}, scope = {}) {
  const next = { ...(data || {}) };
  if (Object.prototype.hasOwnProperty.call(next, "prompt")) {
    next.prompt = await encryptWorkspaceChatFieldAsync(next.prompt, scope);
  }
  if (Object.prototype.hasOwnProperty.call(next, "response")) {
    next.response = await encryptWorkspaceChatFieldAsync(next.response, scope);
  }
  return next;
}

module.exports = {
  appendChatCryptoMetadataForRows,
  chatHistoryEncryptionEnabled,
  decryptWorkspaceChatField,
  decryptWorkspaceChatRecord,
  decryptWorkspaceChatRecordAsync,
  decryptWorkspaceChatRecords,
  decryptWorkspaceChatRecordsAsync,
  encryptWorkspaceChatField,
  encryptWorkspaceChatFieldAsync,
  encryptWorkspaceChatWrite,
  encryptWorkspaceChatWriteAsync,
  rebuildChatCryptoChainForScope,
  rebuildChatCryptoChainFromChatId,
  scopeFromChat,
  workspaceChatFieldIsEncrypted,
};
