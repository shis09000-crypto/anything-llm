const trackedBlobUrls = new Map();

export function trackTtsBlobUrl(url, size = 0) {
  if (!url) return url;
  trackedBlobUrls.set(url, { size, createdAt: Date.now() });
  return url;
}

export function revokeTtsBlobUrl(url) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {}
  trackedBlobUrls.delete(url);
}

export function getTrackedTtsBlobStats() {
  return {
    count: trackedBlobUrls.size,
    bytes: [...trackedBlobUrls.values()].reduce(
      (sum, item) => sum + (item.size || 0),
      0
    ),
  };
}
