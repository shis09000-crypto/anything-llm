const MAX_EVENTS = 300;
const SLOW_REQUEST_MS = 800;
const events = [];

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

function expose() {
  if (typeof window === "undefined") return;
  if (window.__anythingCommunication) return;
  window.__anythingCommunication = {
    events: () => [...events],
    slow: (thresholdMs = SLOW_REQUEST_MS) =>
      events.filter((event) => event.durationMs >= thresholdMs),
    clear: () => {
      events.splice(0, events.length);
    },
    summary: () => {
      const byPath = new Map();
      for (const event of events) {
        const key = `${event.method || "GET"} ${event.path || event.url}`;
        const item = byPath.get(key) || {
          key,
          count: 0,
          totalMs: 0,
          maxMs: 0,
          requestBytes: 0,
          responseBytes: 0,
        };
        item.count += 1;
        item.totalMs += event.durationMs || 0;
        item.maxMs = Math.max(item.maxMs, event.durationMs || 0);
        item.requestBytes += event.requestBytes || 0;
        item.responseBytes += event.responseBytes || 0;
        byPath.set(key, item);
      }
      return [...byPath.values()].sort((a, b) => b.totalMs - a.totalMs);
    },
    accountSettings: () => accountSettingsSummary(events),
    storageStats: () => storageStats(),
  };
}

export function recordCommunicationEvent(event = {}) {
  const next = {
    createdAt: nowIso(),
    ...event,
  };
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
