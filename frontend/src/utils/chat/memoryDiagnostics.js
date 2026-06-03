import { requestPriorityQueue } from "./requestPriorityQueue";
import { threadHistoryCache } from "./threadHistoryCache";
import { WorkspaceChatPerfMarks } from "./performanceBudget";
import { getTrackedTtsBlobStats } from "@/utils/piperTTS";
import { storageKeys } from "@/utils/appEnvironment";

let draftStatsProvider = null;
let sourcesStatsProvider = null;

export function estimatePayloadBytes(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

export function setDraftMemoryStatsProvider(provider = null) {
  draftStatsProvider = typeof provider === "function" ? provider : null;
}

export function setSourcesMemoryStatsProvider(provider = null) {
  sourcesStatsProvider = typeof provider === "function" ? provider : null;
}

function sessionStorageStats() {
  if (typeof sessionStorage === "undefined") return null;
  let bytes = 0;
  const byPrefix = {};
  const keys = storageKeys(sessionStorage);
  for (const key of keys) {
    const value = sessionStorage.getItem(key) || "";
    const size = key.length + value.length;
    bytes += size;
    const prefix = key.split(":")[0] || "unknown";
    byPrefix[prefix] = (byPrefix[prefix] || 0) + size;
  }
  return { keyCount: keys.length, bytes, byPrefix };
}

export function workspaceChatMemorySnapshot() {
  const performanceMemory =
    performance?.memory && typeof performance.memory === "object"
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        }
      : null;

  return {
    createdAt: new Date().toISOString(),
    performanceMemory,
    dom: {
      nodes: document?.getElementsByTagName?.("*")?.length || 0,
      chatRows: document?.querySelectorAll?.("[data-item-id]")?.length || 0,
      audioElements: document?.querySelectorAll?.("audio")?.length || 0,
    },
    drafts: draftStatsProvider?.() || null,
    sources: sourcesStatsProvider?.() || null,
    threadHistoryCache: threadHistoryCache.stats(),
    requestPriorityQueue: requestPriorityQueue.stats(),
    performanceBudget: WorkspaceChatPerfMarks.snapshot(),
    ttsBlobs: getTrackedTtsBlobStats(),
    sessionStorage: sessionStorageStats(),
  };
}

export function installAnythingMemoryDiagnostics() {
  if (typeof window === "undefined" || !import.meta.env.DEV) return;
  window.__anythingMemory = {
    snapshot: workspaceChatMemorySnapshot,
    prune() {
      threadHistoryCache.prune();
      requestPriorityQueue.prune();
      return workspaceChatMemorySnapshot();
    },
  };
}
