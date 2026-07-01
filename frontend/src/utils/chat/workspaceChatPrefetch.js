import Workspace from "@/models/workspace";
import { requestPriorityQueue } from "./requestPriorityQueue";
import { threadHistoryCache } from "./threadHistoryCache";
import { WorkspaceChatPerfMarks } from "./performanceBudget";
import { workspaceNavigationCache } from "./workspaceNavigationCache";
import {
  isPersistentSettingsRoute,
  settingsSectionsForPath,
} from "@/utils/settingsRoutes";

const routePrefetches = new Map();
const SLOW_WARMUP_REQUEST_MS = 900;
let warmupGeneration = 0;
const PREFETCH_HISTORY_SCOPE = { detail: "light", surface: "desktop" };
const SETTINGS_ROUTE_PREFETCHERS = {
  "/settings/llm-preference": () =>
    import("@/pages/GeneralSettings/LLMPreference"),
  "/settings/vector-database": () =>
    import("@/pages/GeneralSettings/VectorDatabase"),
  "/settings/embedding-preference": () =>
    import("@/pages/GeneralSettings/EmbeddingPreference"),
  "/settings/rerank-preference": () =>
    import("@/pages/GeneralSettings/RerankPreference"),
  "/settings/search-model-preference": () =>
    import("@/pages/GeneralSettings/SearchModelPreference"),
  "/settings/ocr-preference": () =>
    import("@/pages/GeneralSettings/OcrPreference"),
  "/settings/vision-preference": () =>
    import("@/pages/GeneralSettings/VisionPreference"),
  "/settings/text-splitter-preference": () =>
    import("@/pages/GeneralSettings/EmbeddingTextSplitterPreference"),
  "/settings/batch-jobs": () => import("@/pages/GeneralSettings/BatchJobs"),
  "/settings/audio-preference": () =>
    import("@/pages/GeneralSettings/AudioPreference"),
  "/settings/transcription-preference": () =>
    import("@/pages/GeneralSettings/TranscriptionPreference"),
  "/settings/agents": () => import("@/pages/Admin/Agents"),
  "/settings/system-patrol": () =>
    import("@/pages/GeneralSettings/SystemPatrol"),
  "/settings/interface": () =>
    import("@/pages/GeneralSettings/Settings/Interface"),
  "/settings/branding": () =>
    import("@/pages/GeneralSettings/Settings/Branding"),
  "/settings/button-lab": () =>
    import("@/pages/GeneralSettings/Settings/ButtonLab"),
  "/settings/mobile-page-experiment": () =>
    import("@/pages/GeneralSettings/Settings/MobilePageExperiment"),
  "/settings/crypto-component-experiment": () =>
    import("@/pages/GeneralSettings/Settings/CryptoComponentExperiment"),
  "/settings/chat": () => import("@/pages/GeneralSettings/Settings/Chat"),
  "/settings/embed-chat-widgets": () =>
    import("@/pages/GeneralSettings/ChatEmbedWidgets"),
  "/settings/event-logs": () => import("@/pages/Admin/Logging"),
  "/settings/crypto-center": () => import("@/pages/Admin/CryptoCenter"),
  "/settings/scheduled-jobs": () =>
    import("@/pages/GeneralSettings/ScheduledJobs"),
  "/settings/api-keys": () => import("@/pages/GeneralSettings/ApiKeys"),
  "/settings/system-prompt-variables": () =>
    import("@/pages/Admin/SystemPromptVariables"),
  "/settings/browser-extension": () =>
    import("@/pages/GeneralSettings/BrowserExtensionApiKey"),
  "/settings/mobile-connections": () =>
    import("@/pages/GeneralSettings/MobileConnections"),
  "/settings/privacy": () => import("@/pages/GeneralSettings/PrivacyAndData"),
  "/settings/security": () => import("@/pages/GeneralSettings/Security"),
  "/settings/beta-features": () => import("@/pages/Admin/ExperimentalFeatures"),
  "/settings/external-connections/telegram": () =>
    import("@/pages/GeneralSettings/Connections/TelegramBot"),
  "/settings/external-connections/wechat": () =>
    import("@/pages/GeneralSettings/Connections/WeChatConnector"),
  "/settings/external-connections/advanced-gateway": () =>
    import("@/pages/GeneralSettings/Connections/AdvancedGatewayConnector"),
};

function connectionIsConstrained() {
  if (typeof navigator === "undefined") return false;
  const connection = navigator.connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  if (["slow-2g", "2g", "3g"].includes(connection.effectiveType)) return true;
  return Number(connection.downlink || 0) > 0 && connection.downlink < 5;
}

function recentCommunicationIsSlow() {
  try {
    const events = window.__anythingCommunication?.events?.() || [];
    return events
      .slice(-24)
      .some(
        (event) =>
          ["workspace-chat", "workspace-navigation", "reader"].includes(
            event.communicationScene
          ) && Number(event.durationMs || 0) >= SLOW_WARMUP_REQUEST_MS
      );
  } catch {
    return false;
  }
}

function shouldPrefetchRecentThreadHistory() {
  if (connectionIsConstrained()) return false;
  if (recentCommunicationIsSlow()) return false;
  return !WorkspaceChatPerfMarks.snapshot().degraded;
}

export function prefetchWorkspaceChatRoute() {
  if (!routePrefetches.has("workspace-chat")) {
    routePrefetches.set(
      "workspace-chat",
      import("@/pages/WorkspaceChat").catch(() => null)
    );
  }
  return routePrefetches.get("workspace-chat");
}

export function prefetchWorkspaceSettingsRoute() {
  if (!routePrefetches.has("workspace-settings")) {
    routePrefetches.set(
      "workspace-settings",
      import("@/pages/WorkspaceSettings").catch(() => null)
    );
  }
  return routePrefetches.get("workspace-settings");
}

export function prefetchSettingsRoute(target = null) {
  const pathname = settingsPrefetchPathname(target);
  if (!isPersistentSettingsRoute(pathname)) return null;

  const key = `settings:${pathname}`;
  const importer =
    SETTINGS_ROUTE_PREFETCHERS[pathname] ||
    SETTINGS_ROUTE_PREFETCHERS["/settings/interface"];
  if (!routePrefetches.has(key)) {
    routePrefetches.set(
      key,
      importer().catch(() => null)
    );
  }

  const sections = settingsSectionsForPath(pathname);
  if (sections.length && typeof window !== "undefined") {
    window.__anythingSettingsData?.prewarmSettings?.(sections, {
      priority: "P4",
    });
  }
  return routePrefetches.get(key);
}

function settingsPrefetchPathname(target) {
  const href =
    typeof target === "string"
      ? target
      : target?.currentTarget?.getAttribute?.("href") ||
        target?.target?.getAttribute?.("href") ||
        "";
  if (!href) return "/settings/interface";
  try {
    const origin =
      typeof window === "undefined"
        ? "https://localhost"
        : window.location.origin;
    return new URL(href, origin).pathname;
  } catch {
    return href.split("?")[0].split("#")[0] || "/settings/interface";
  }
}

export function prefetchThreadHistory(workspaceSlug, threadSlug = null) {
  if (!workspaceSlug) return;
  prefetchWorkspaceChatRoute();
  requestPriorityQueue.schedule(
    async () => {
      const cached = await threadHistoryCache.get({
        workspaceSlug,
        threadSlug,
        kind: "page",
        cursor: "latest",
        ...PREFETCH_HISTORY_SCOPE,
      });
      if (cached) return cached;
      const payload = threadSlug
        ? await Workspace.threads.chatHistoryPage(workspaceSlug, threadSlug, {
            limit: 20,
            detail: "light",
            priorityWindow: 5,
          })
        : await Workspace.chatHistoryPage(workspaceSlug, {
            limit: 20,
            detail: "light",
            priorityWindow: 5,
          });
      await threadHistoryCache.set(
        {
          workspaceSlug,
          threadSlug,
          kind: "page",
          cursor: "latest",
          ...PREFETCH_HISTORY_SCOPE,
        },
        payload
      );
      return payload;
    },
    {
      priority: "P3",
      label: "workspacechat:hover-prefetch",
      dedupeKey: `prefetch:${workspaceSlug}:${threadSlug || "default"}`,
    }
  );
}

export function warmWorkspaceChat(workspaceSlug) {
  if (!workspaceSlug) return;
  const generation = ++warmupGeneration;
  requestPriorityQueue.schedule(
    async () => {
      prefetchWorkspaceChatRoute();
      const canPrefetchHistory = shouldPrefetchRecentThreadHistory();
      if (!canPrefetchHistory) return null;
      prefetchWorkspaceSettingsRoute();
      const threadsMeta =
        workspaceNavigationCache.getThreadsMeta(workspaceSlug);
      let threads =
        workspaceNavigationCache.getThreads(workspaceSlug, {
          allowStale: threadsMeta.status !== "fresh",
        }) || [];
      if (threadsMeta.status !== "fresh") {
        const staleThreads = workspaceNavigationCache.getThreads(workspaceSlug);
        if (Array.isArray(staleThreads)) threads = staleThreads;

        const result = await workspaceNavigationCache.runInFlight(
          `threads:${workspaceSlug}`,
          () => Workspace.threads.all(workspaceSlug)
        );
        if (generation !== warmupGeneration) return null;
        if (Array.isArray(result?.threads)) {
          threads = result.threads;
          workspaceNavigationCache.setThreads(workspaceSlug, threads);
        }
      }
      if (generation !== warmupGeneration) return null;
      const recent = threads.slice(0, 3);
      recent.forEach((thread) =>
        prefetchThreadHistory(workspaceSlug, thread.slug)
      );
      return null;
    },
    {
      priority: "P3",
      label: "workspacechat:background-warmup",
      dedupeKey: `warmup:${workspaceSlug}`,
    }
  );
}
