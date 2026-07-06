const {
  ReaderLibraryRepository,
} = require("../repositories/readerLibraryRepository");
const {
  sanitizeReaderLibraryItem,
  sanitizeReaderLibraryItems,
  sanitizeReaderLibraryPatch,
} = require("../utils/dataAccess/readerLibraryPolicy");

const ReaderDataAuthority = {
  UNKNOWN_CATEGORY_ID: ReaderLibraryRepository.UNKNOWN_CATEGORY_ID,
  catalogKey: ReaderLibraryRepository.catalogKey,

  ensureTable(options) {
    return ReaderLibraryRepository.ensureTable(options);
  },

  upsertCatalog(options) {
    return ReaderLibraryRepository.upsertCatalog({
      ...options,
      document: sanitizeReaderLibraryItem(options?.document || {}),
    });
  },

  ensureCategory(options) {
    return ReaderLibraryRepository.ensureCategory(options);
  },

  upsertItem(options) {
    return ReaderLibraryRepository.upsertItem({
      ...options,
      item: sanitizeReaderLibraryItem(options?.item || {}),
    });
  },

  bootstrap(options) {
    return ReaderLibraryRepository.bootstrap({
      ...options,
      bookshelf: sanitizeReaderLibraryItems(options?.bookshelf || []),
      categories: sanitizeReaderLibraryItems(options?.categories || []),
    });
  },

  listLibrary(options) {
    return ReaderLibraryRepository.listLibrary(options);
  },

  patchItem(options) {
    return ReaderLibraryRepository.patchItem({
      ...options,
      patch: sanitizeReaderLibraryPatch(options?.patch || {}),
    });
  },

  softDeleteItem(options) {
    return ReaderLibraryRepository.softDeleteItem(options);
  },

  restoreItem(options) {
    return ReaderLibraryRepository.restoreItem(options);
  },

  patchCategory(options) {
    return ReaderLibraryRepository.patchCategory({
      ...options,
      patch: sanitizeReaderLibraryPatch(options?.patch || {}),
    });
  },

  reconcileCatalog(options) {
    return ReaderLibraryRepository.reconcileCatalog({
      ...options,
      documents: sanitizeReaderLibraryItems(options?.documents || []),
    });
  },

  snapshot(options) {
    return ReaderLibraryRepository.snapshot(options);
  },
};

module.exports = { ReaderDataAuthority };
