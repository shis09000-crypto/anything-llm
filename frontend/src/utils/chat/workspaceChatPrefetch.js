import Workspace from "@/models/workspace";
import { requestPriorityQueue } from "./requestPriorityQueue";
import { threadHistoryCache } from "./threadHistoryCache";

const routePrefetches = new Map();

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

export function prefetchSettingsRoute() {
  if (!routePrefetches.has("settings")) {
    routePrefetches.set(
      "settings",
      import("@/pages/GeneralSettings/Settings/Interface").catch(() => null)
    );
  }
  return routePrefetches.get("settings");
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
        { workspaceSlug, threadSlug, kind: "page", cursor: "latest" },
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
  requestPriorityQueue.schedule(
    async () => {
      prefetchWorkspaceChatRoute();
      prefetchWorkspaceSettingsRoute();
      const { threads = [] } = await Workspace.threads.all(workspaceSlug);
      const recent = threads.slice(0, 3);
      recent.forEach((thread) =>
        prefetchThreadHistory(workspaceSlug, thread.slug)
      );
    },
    {
      priority: "P3",
      label: "workspacechat:background-warmup",
      dedupeKey: `warmup:${workspaceSlug}`,
    }
  );
}
