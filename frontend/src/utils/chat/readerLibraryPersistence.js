function compactString(value = "") {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeTitleKey(title = "") {
  return String(title || "")
    .normalize("NFKC")
    .replace(/\.(pdf|docx|xlsx|epub|md|markdown|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function readerLibraryItemKey(item = {}) {
  if (!item) return null;
  const explicitKey = compactString(item.key);
  if (explicitKey) return explicitKey;
  const bookKey = compactString(item.bookKey) || normalizeTitleKey(item.title);
  if (!bookKey) return null;
  const branchId = compactString(item.branchId);
  return branchId ? `${bookKey}:branch:${branchId}` : `${bookKey}:main`;
}

export function serverReaderDocumentIds(item = {}) {
  return [item.readerDocumentId, item.backupReaderDocumentId].filter(
    (id, index, ids) => id && ids.indexOf(id) === index
  );
}

export function hasServerReaderDocument(item = {}) {
  return serverReaderDocumentIds(item).length > 0;
}

export function mergeReaderLibraryBookshelfItems(
  currentItems = [],
  incomingItems = []
) {
  const byKey = new Map();
  for (const rawItem of [
    ...(Array.isArray(currentItems) ? currentItems : []),
    ...(Array.isArray(incomingItems) ? incomingItems : []),
  ]) {
    const key = readerLibraryItemKey(rawItem);
    if (!key) continue;
    const previous = byKey.get(key);
    byKey.set(key, {
      ...previous,
      ...rawItem,
      key,
      readerDocumentId:
        rawItem.readerDocumentId || previous?.readerDocumentId || null,
      backupReaderDocumentId:
        rawItem.backupReaderDocumentId ||
        previous?.backupReaderDocumentId ||
        null,
      readerDocumentWorkspaceSlug:
        rawItem.readerDocumentWorkspaceSlug ||
        previous?.readerDocumentWorkspaceSlug ||
        rawItem.workspaceSlug ||
        previous?.workspaceSlug ||
        null,
      category: rawItem.category || previous?.category,
      progress: rawItem.progress || previous?.progress,
      addedAt: previous?.addedAt || rawItem.addedAt,
      updatedAt: rawItem.updatedAt || previous?.updatedAt,
    });
  }
  return [...byKey.values()];
}

export function removableBookshelfKeysAfterReaderDelete(
  items = [],
  deletedReaderDocumentIds = []
) {
  const deletedIds = new Set(
    (Array.isArray(deletedReaderDocumentIds)
      ? deletedReaderDocumentIds
      : [deletedReaderDocumentIds]
    ).filter(Boolean)
  );

  return (Array.isArray(items) ? items : [items])
    .filter(Boolean)
    .filter((item) => {
      const serverIds = serverReaderDocumentIds(item);
      if (!serverIds.length) return true;
      return serverIds.some((id) => deletedIds.has(id));
    })
    .map(readerLibraryItemKey)
    .filter(Boolean);
}
