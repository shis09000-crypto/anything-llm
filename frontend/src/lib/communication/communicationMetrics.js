const MAX_EVENTS = 300;
const SLOW_REQUEST_MS = 800;
const LOW_BANDWIDTH_BPS = 1_000_000;
const events = [];

function communicationDebugEnabled() {
  if (import.meta.env.DEV) return true;
  if (import.meta.env.VITE_ENABLE_COMMUNICATION_DEBUG !== "true") return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage?.getItem("athenaCommunicationDebug") === "true";
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function byteLength(value = "") {
  try {
    return new Blob([value]).size;
  } catch {
    return String(value || "").length;
  }
}

function responseSize(response, data) {
  const header = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(header)) return header;
  if (data === null || data === undefined) return 0;
  try {
    return byteLength(JSON.stringify(data));
  } catch {
    return 0;
  }
}

function inferScene(event = {}) {
  if (event.communicationScene) return event.communicationScene;
  if (event.scene) return event.scene;
  const path = String(event.path || event.url || "");
  const type = String(event.type || "");
  if (type.startsWith("reader_upload") || path.includes("reader-documents"))
    return "reader";
  if (path.includes("/system/settings/bootstrap")) return "model-settings";
  if (
    path.includes("/system/user") ||
    path.includes("/auth/passkeys") ||
    path.includes("/auth/zk-login/devices") ||
    path.includes("/admin") ||
    path.includes("/system/chats")
  )
    return "account-settings";
  if (path.includes("/sync/events") || type.startsWith("sse")) return "sync";
  if (path.includes("/workspace/") && path.includes("/bootstrap"))
    return "workspace-chat";
  if (path.includes("/workspace/") && path.includes("/threads"))
    return "workspace-navigation";
  if (path.includes("/workspace/") && path.includes("/settings"))
    return "workspace-settings";
  if (path === "/workspaces" || path.endsWith("/workspaces"))
    return "workspace-navigation";
  return "general";
}

function pathKey(event = {}) {
  return `${event.method || "GET"} ${event.path || event.url || event.type}`;
}

function eventBytes(event = {}) {
  return Number(event.requestBytes || 0) + Number(event.responseBytes || 0);
}

function summarizeEvents(sourceEvents = []) {
  const byPath = new Map();
  for (const event of sourceEvents) {
    const key = pathKey(event);
    const item = byPath.get(key) || {
      key,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      totalBytes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      sseOpenCount: 0,
      sseCloseCount: 0,
      sseErrorCount: 0,
    };
    item.count += 1;
    item.totalMs += event.durationMs || 0;
    item.maxMs = Math.max(item.maxMs, event.durationMs || 0);
    item.requestBytes += event.requestBytes || 0;
    item.responseBytes += event.responseBytes || 0;
    item.totalBytes += eventBytes(event);
    if (event.cache === "hit" || event.accountSettings?.action === "hit")
      item.cacheHits += 1;
    if (event.cache === "miss" || event.accountSettings?.action === "miss")
      item.cacheMisses += 1;
    if (event.type === "sse-open") item.sseOpenCount += 1;
    if (event.type === "sse-close") item.sseCloseCount += 1;
    if (event.type === "sse-error") item.sseErrorCount += 1;
    byPath.set(key, item);
  }
  return [...byPath.values()]
    .map((item) => ({
      ...item,
      avgMs: item.count ? item.totalMs / item.count : 0,
      cacheHitRate:
        item.cacheHits + item.cacheMisses > 0
          ? item.cacheHits / (item.cacheHits + item.cacheMisses)
          : null,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function sceneSummary(sourceEvents = events) {
  const byScene = new Map();
  for (const event of sourceEvents) {
    const scene = event.communicationScene || inferScene(event);
    const item = byScene.get(scene) || {
      scene,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      totalBytes: 0,
      cacheHits: 0,
      cacheMisses: 0,
      sseOpenCount: 0,
      sseCloseCount: 0,
      sseErrorCount: 0,
      estimatedTransferMsAt1MBps: 0,
      paths: new Map(),
    };
    item.count += 1;
    item.totalMs += event.durationMs || 0;
    item.maxMs = Math.max(item.maxMs, event.durationMs || 0);
    item.requestBytes += event.requestBytes || 0;
    item.responseBytes += event.responseBytes || 0;
    item.totalBytes += eventBytes(event);
    if (event.cache === "hit" || event.accountSettings?.action === "hit")
      item.cacheHits += 1;
    if (event.cache === "miss" || event.accountSettings?.action === "miss")
      item.cacheMisses += 1;
    if (event.type === "sse-open") item.sseOpenCount += 1;
    if (event.type === "sse-close") item.sseCloseCount += 1;
    if (event.type === "sse-error") item.sseErrorCount += 1;
    item.paths.set(pathKey(event), (item.paths.get(pathKey(event)) || 0) + 1);
    byScene.set(scene, item);
  }
  return [...byScene.values()]
    .map((item) => ({
      ...item,
      cacheHitRate:
        item.cacheHits + item.cacheMisses > 0
          ? item.cacheHits / (item.cacheHits + item.cacheMisses)
          : null,
      avgMs: item.count ? item.totalMs / item.count : 0,
      estimatedTransferMsAt1MBps: Math.round(
        (item.totalBytes / LOW_BANDWIDTH_BPS) * 1000
      ),
      paths: [...item.paths.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([key, count]) => ({ key, count })),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function expose() {
  if (typeof window === "undefined") return;
  if (!communicationDebugEnabled()) {
    if (window.__anythingCommunication) {
      try {
        delete window.__anythingCommunication;
      } catch {
        window.__anythingCommunication = undefined;
      }
    }
    return;
  }
  if (window.__anythingCommunication) return;
  window.__anythingCommunication = {
    events: () => [...events],
    slow: (thresholdMs = SLOW_REQUEST_MS) =>
      events.filter((event) => event.durationMs >= thresholdMs),
    clear: () => {
      events.splice(0, events.length);
    },
    summary: () => {
      return summarizeEvents(events);
    },
    scenes: () => sceneSummary(events),
    budget: () => ({
      bandwidthBps: LOW_BANDWIDTH_BPS,
      scenes: sceneSummary(events),
      paths: summarizeEvents(events),
    }),
    accountSettings: () => accountSettingsSummary(events),
    storageStats: () => storageStats(),
  };
}

export function recordCommunicationEvent(event = {}) {
  const next = {
    createdAt: nowIso(),
    ...event,
  };
  next.communicationScene = inferScene(next);
  events.push(next);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  expose();

  if (
    import.meta.env.DEV &&
    next.durationMs >= SLOW_REQUEST_MS &&
    typeof console !== "undefined"
  ) {
    console.warn("[communication:slow-request]", next);
  }
}

export function communicationByteLength(value = "") {
  return byteLength(value);
}

export function communicationResponseSize(response, data) {
  return responseSize(response, data);
}

function accountSettingsSummary(sourceEvents = []) {
  const accountEvents = sourceEvents.filter((event) => {
    if (event.accountSettings) return true;
    const path = String(event.path || event.url || "");
    return (
      path.includes("/system/user") ||
      path.includes("/auth/passkeys") ||
      path.includes("/auth/zk-login/devices") ||
      path.includes("/admin") ||
      path.includes("/system/chats")
    );
  });
  const total = accountEvents.reduce(
    (acc, event) => {
      acc.count += 1;
      acc.totalMs += event.durationMs || 0;
      acc.responseBytes += event.responseBytes || 0;
      acc.maxMs = Math.max(acc.maxMs, event.durationMs || 0);
      return acc;
    },
    { count: 0, totalMs: 0, maxMs: 0, responseBytes: 0 }
  );
  return {
    total,
    events: accountEvents.slice(-40),
    cache: window.__anythingAccountSettings?.cacheStats?.() || null,
  };
}

function storageStats() {
  if (typeof window === "undefined") return null;
  const statsFor = (storage) => {
    if (!storage) return { keys: 0, bytes: 0 };
    let bytes = 0;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      bytes += byteLength(key || "");
      bytes += byteLength(storage.getItem(key) || "");
    }
    return { keys: storage.length, bytes };
  };
  return {
    localStorage: statsFor(window.localStorage),
    sessionStorage: statsFor(window.sessionStorage),
  };
}
