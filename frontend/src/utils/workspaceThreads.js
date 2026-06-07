import paths from "@/utils/paths";

export const THREAD_TYPES = {
  chat: "chat",
  overview: "overview",
};

export const THREAD_CREATED_FROM = {
  workspaceDefault: "workspace_default",
};

export function isOverviewThread(thread = null) {
  return thread?.thread_type === THREAD_TYPES.overview;
}

export function isWorkspaceDefaultChatThread(thread = null) {
  return (
    thread?.thread_type === THREAD_TYPES.chat &&
    thread?.created_from === THREAD_CREATED_FROM.workspaceDefault
  );
}

export function isDefaultWorkspaceChatThread(thread = null) {
  return (
    isWorkspaceDefaultChatThread(thread) &&
    isUntitledDefaultNamedChatThread(thread)
  );
}

export function isUntitledDefaultNamedChatThread(thread = null) {
  if (thread?.thread_type !== THREAD_TYPES.chat || thread?.title) return false;
  const name = (thread?.name || "").trim().toLowerCase();
  return ["", "new thread", "thread"].includes(name);
}

export function findOverviewThread(threads = []) {
  return threads.find((thread) => isOverviewThread(thread)) || null;
}

export function displayThreadName(thread = null, t = null) {
  if (!thread) return "";
  if (isOverviewThread(thread)) return t?.("common.overviewPage") || "Overview";
  if (isUntitledDefaultNamedChatThread(thread))
    return t?.("common.newThread") || "New Thread";
  return thread.title || thread.name || "";
}

export function sortThreadsForDisplay(
  threads = [],
  workspaceSlug,
  activityFor
) {
  return threads
    .map((thread, index) => ({
      thread,
      index,
      activity: activityFor?.(workspaceSlug, thread.slug),
    }))
    .sort((a, b) => {
      const rank = (thread) => {
        if (isOverviewThread(thread)) return 0;
        return 1;
      };
      const rankDiff = rank(a.thread) - rank(b.thread);
      if (rankDiff !== 0) return rankDiff;
      if (activitySortRank(a.activity) !== activitySortRank(b.activity)) {
        return activitySortRank(a.activity) - activitySortRank(b.activity);
      }
      if (activitySortRank(a.activity) === 0) {
        return (b.activity?.updatedAt || 0) - (a.activity?.updatedAt || 0);
      }
      const latestDiff =
        threadLatestTime(b.thread) - threadLatestTime(a.thread);
      if (latestDiff !== 0) return latestDiff;
      const latestIdDiff =
        Number(b.thread?.lastChatId || 0) - Number(a.thread?.lastChatId || 0);
      if (latestIdDiff !== 0) return latestIdDiff;
      return a.index - b.index;
    });
}

export function defaultWorkspacePath(workspaceSlug, threads = []) {
  const overviewThread = findOverviewThread(threads);
  return overviewThread?.slug
    ? paths.workspace.thread(workspaceSlug, overviewThread.slug)
    : paths.workspace.chat(workspaceSlug);
}

function activitySortRank(activity) {
  if (activity?.status === "running") return 0;
  return 1;
}

function threadLatestTime(thread = null) {
  const timestamp =
    thread?.lastChatAt || thread?.lastUpdatedAt || thread?.createdAt || 0;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}
