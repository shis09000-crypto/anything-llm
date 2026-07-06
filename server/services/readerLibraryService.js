const { DataAccessCenter } = require("../utils/dataAccess");
const { publishBroadcastEvent } = require("../utils/broadcast");

function publishReaderLibraryEvent({
  userId,
  type = "library.updated",
  payload = {},
}) {
  if (!userId) return;
  publishBroadcastEvent(
    {
      namespace: "reader",
      type,
      eventPriority: "normal",
      visibility: "reader",
      scope: { userId: Number(userId) },
      resource: { kind: "reader-library", id: String(userId) },
      payload: {
        reason: type,
        ...payload,
      },
    },
    { coalesce: true }
  );
}

function libraryResponse(result = {}) {
  return {
    success: true,
    revision: result.revision || null,
    categories: result.categories || [],
    bookshelf: result.bookshelf || [],
    counts: result.counts || {
      categories: result.categories?.length || 0,
      bookshelf: result.bookshelf?.length || 0,
    },
  };
}

const ReaderLibraryService = {
  async list({ userId } = {}) {
    return DataAccessCenter.readerLibrary.listLibrary({ userId });
  },

  async bootstrap({ userId, bookshelf = [], categories = [] } = {}) {
    const result = await DataAccessCenter.readerLibrary.bootstrap({
      userId,
      bookshelf,
      categories,
    });
    publishReaderLibraryEvent({
      userId,
      type: "library.bootstrapped",
      payload: { count: result.bookshelf?.length || 0 },
    });
    return result;
  },

  async patchItem({ userId, itemId, patch = {} } = {}) {
    const result = await DataAccessCenter.readerLibrary.patchItem({
      userId,
      itemId,
      patch,
    });
    if (result) {
      publishReaderLibraryEvent({
        userId,
        type: "library.item.updated",
        payload: { itemId },
      });
    }
    return result;
  },

  async softDeleteItem({ userId, itemId } = {}) {
    const result = await DataAccessCenter.readerLibrary.softDeleteItem({
      userId,
      itemId,
    });
    publishReaderLibraryEvent({
      userId,
      type: "library.item.deleted",
      payload: { itemId },
    });
    return result;
  },

  async patchCategory({ userId, categoryId, patch = {} } = {}) {
    const result = await DataAccessCenter.readerLibrary.patchCategory({
      userId,
      categoryId,
      patch,
    });
    publishReaderLibraryEvent({
      userId,
      type: patch.deleted
        ? "library.category.deleted"
        : "library.category.updated",
      payload: { categoryId },
    });
    return result;
  },

  async reconcile({ userId, documents = [], workspaceSlug = null } = {}) {
    const result = await DataAccessCenter.readerLibrary.reconcileCatalog({
      userId,
      documents,
      workspaceSlug,
    });
    publishReaderLibraryEvent({
      userId,
      type: "library.reconciled",
      payload: { documentCount: documents?.length || 0 },
    });
    return result;
  },
};

module.exports = {
  ReaderLibraryService,
  libraryResponse,
  publishReaderLibraryEvent,
};
