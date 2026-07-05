import { workspaceNavigationCache } from "../chat/workspaceNavigationCache.js";
import { threadHistoryCache } from "../chat/threadHistoryCache.js";
import { markTaskPerformance } from "../tasks/taskScheduler.js";

function restoreWorkspaceChat({ scope = {} } = {}) {
  const workspaceSlug = scope.workspaceSlug || null;
  const threadSlug = scope.threadSlug || null;
  if (!workspaceSlug) return Promise.resolve(null);

  const workspaces = workspaceNavigationCache.getWorkspaces({
    allowStale: true,
  });
  const workspace = workspaceNavigationCache.getWorkspaceDetail(workspaceSlug, {
    allowStale: true,
  });
  const threads = workspaceNavigationCache.getThreads(workspaceSlug, {
    allowStale: true,
  });

  if (Array.isArray(workspaces)) {
    markTaskPerformance("sidebar_ready", {
      source: "navigation-cache",
      count: workspaces.length,
    });
  }
  if (Array.isArray(threads)) {
    markTaskPerformance("thread_list_cache_visible", {
      source: "navigation-cache",
      workspaceSlug,
      count: threads.length,
    });
    markTaskPerformance("threads_ready", {
      source: "navigation-cache",
      workspaceSlug,
      count: threads.length,
    });
  }

  if (threadSlug) {
    void threadHistoryCache
      .get({
        workspaceSlug,
        threadSlug,
        kind: "page",
        cursor: "latest",
      })
      .then((history) => {
        if (!history) return;
        markTaskPerformance("chat_shell_ready", {
          source: "navigation-cache",
          workspaceSlug,
          threadSlug,
          historyLength: history?.history?.length || 0,
        });
      })
      .catch(() => null);
  }

  const cacheHit =
    Array.isArray(workspaces) || !!workspace || Array.isArray(threads);
  markTaskPerformance("navigation_restore_chat_cache_ready", {
    workspaceSlug,
    threadSlug,
    cacheHit,
    hasWorkspaces: Array.isArray(workspaces),
    hasWorkspaceDetail: !!workspace,
    hasThreads: Array.isArray(threads),
  });

  return Promise.resolve({
    source: cacheHit ? "cache" : "miss",
    cacheHit,
    workspaces: Array.isArray(workspaces) ? workspaces.length : 0,
    threads: Array.isArray(threads) ? threads.length : 0,
  });
}

export function restoreTargetForScope(scope = {}) {
  if (scope?.route === "workspace-chat") return restoreWorkspaceChat;
  return null;
}

export function extraExitScopesForRoute(scope = {}) {
  if (!scope?.route) return [];
  if (scope.route === "crypto-center") return [{ route: "crypto-center" }];
  if (scope.route === "settings") return [{ route: "settings" }];
  if (scope.route === "workspace-settings") {
    return [
      {
        route: "workspace-settings",
        workspaceSlug: scope.workspaceSlug,
      },
    ];
  }
  if (scope.route === "reader") return [{ route: "reader" }];
  return [];
}
