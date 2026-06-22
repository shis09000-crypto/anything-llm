const { v4: uuidv4 } = require("uuid");

const PUBLIC_CHAT_ID_PREFIX = "chat_";

function newPublicChatId() {
  return `${PUBLIC_CHAT_ID_PREFIX}${uuidv4()}`;
}

function normalizePublicChatId(value = null) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text.startsWith(PUBLIC_CHAT_ID_PREFIX)) return null;
  return text.length > PUBLIC_CHAT_ID_PREFIX.length ? text : null;
}

function normalizeNumericChatId(value = null) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && value.startsWith(PUBLIC_CHAT_ID_PREFIX))
    return null;
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function splitChatIdentifiers(values = []) {
  const identifiers = Array.isArray(values) ? values : [values];
  const numericIds = new Set();
  const publicIds = new Set();

  for (const value of identifiers) {
    const publicId = normalizePublicChatId(value);
    if (publicId) {
      publicIds.add(publicId);
      continue;
    }

    const numericId = normalizeNumericChatId(value);
    if (numericId) numericIds.add(numericId);
  }

  return {
    numericIds: [...numericIds],
    publicIds: [...publicIds],
  };
}

function chatIdentifierWhere(value = null) {
  const publicId = normalizePublicChatId(value);
  if (publicId) return { public_id: publicId };

  const numericId = normalizeNumericChatId(value);
  if (numericId) return { id: numericId };

  return null;
}

function chatIdentifiersWhere(values = []) {
  const { numericIds, publicIds } = splitChatIdentifiers(values);
  const clauses = [];
  if (numericIds.length > 0) clauses.push({ id: { in: numericIds } });
  if (publicIds.length > 0) clauses.push({ public_id: { in: publicIds } });
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0];
  return { OR: clauses };
}

function chatIdentityFromRequest({
  chatId = null,
  publicChatId = null,
  id = null,
} = {}) {
  return chatIdentifierWhere(publicChatId || chatId || id);
}

function chatIdentifierPayload({
  chatIds = [],
  publicChatIds = [],
  chatId = null,
  publicChatId = null,
} = {}) {
  return [
    ...(Array.isArray(publicChatIds) ? publicChatIds : []),
    ...(Array.isArray(chatIds) ? chatIds : []),
    publicChatId,
    chatId,
  ].filter((value) => value !== null && value !== undefined && value !== "");
}

function publicChatIdFor(chat = null) {
  return chat?.public_id || null;
}

module.exports = {
  PUBLIC_CHAT_ID_PREFIX,
  newPublicChatId,
  normalizeNumericChatId,
  normalizePublicChatId,
  splitChatIdentifiers,
  chatIdentifierWhere,
  chatIdentifiersWhere,
  chatIdentityFromRequest,
  chatIdentifierPayload,
  publicChatIdFor,
};
