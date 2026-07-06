const {
  SENSITIVE_FIELD_KEY,
  sanitizeItems,
  sanitizePatch,
  sanitizeValue,
} = require("./dataAccessPolicy");

function sanitizeReaderLibraryItem(item = {}) {
  return sanitizeValue(item) || {};
}

function sanitizeReaderLibraryPatch(patch = {}) {
  return sanitizePatch(patch) || {};
}

function sanitizeReaderLibraryItems(items = []) {
  return sanitizeItems(items);
}

module.exports = {
  SENSITIVE_READER_LIBRARY_KEY: SENSITIVE_FIELD_KEY,
  sanitizeReaderLibraryItem,
  sanitizeReaderLibraryItems,
  sanitizeReaderLibraryPatch,
  sanitizeReaderLibraryValue: sanitizeValue,
};
