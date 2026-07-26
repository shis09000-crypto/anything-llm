const MAX_MEMORY_STATUS_ENTRIES = 50;
const memoryStatusCache = new Map();

function validScopeKey(scopeKey) {
  return typeof scopeKey === "string" && scopeKey.trim().length > 0;
}

export function readMemoryCompactionStatus(scopeKey) {
  if (!validScopeKey(scopeKey)) return null;
  const entry = memoryStatusCache.get(scopeKey);
  if (!entry?.status) return null;
  memoryStatusCache.delete(scopeKey);
  memoryStatusCache.set(scopeKey, entry);
  return entry.status;
}

export function writeMemoryCompactionStatus(scopeKey, status) {
  if (!validScopeKey(scopeKey) || !status || typeof status !== "object")
    return null;
  memoryStatusCache.delete(scopeKey);
  memoryStatusCache.set(scopeKey, {
    status,
    updatedAt: Date.now(),
  });
  while (memoryStatusCache.size > MAX_MEMORY_STATUS_ENTRIES) {
    memoryStatusCache.delete(memoryStatusCache.keys().next().value);
  }
  return status;
}

export function clearMemoryCompactionStatusCache() {
  memoryStatusCache.clear();
}
