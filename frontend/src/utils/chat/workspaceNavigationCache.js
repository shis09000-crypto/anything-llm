const WORKSPACES_TTL_MS = 1000 * 60 * 10;
const THREADS_TTL_MS = 1000 * 60 * 10;

const workspacesEntry = { payload: null, updatedAt: 0 };
const threadsByWorkspace = new Map();

function isFresh(entry, ttlMs) {
  return !!entry?.payload && Date.now() - entry.updatedAt < ttlMs;
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export const workspaceNavigationCache = {
  getWorkspaces({ allowStale = true } = {}) {
    if (!workspacesEntry.payload) return null;
    if (!allowStale && !isFresh(workspacesEntry, WORKSPACES_TTL_MS))
      return null;
    return clone(workspacesEntry.payload);
  },
  setWorkspaces(workspaces = []) {
    workspacesEntry.payload = clone(workspaces);
    workspacesEntry.updatedAt = Date.now();
  },
  upsertWorkspace(workspace = null) {
    if (!workspace?.id || !workspacesEntry.payload) return;
    const exists = workspacesEntry.payload.some(
      (item) => item.id === workspace.id
    );
    workspacesEntry.payload = exists
      ? workspacesEntry.payload.map((item) =>
          item.id === workspace.id ? { ...item, ...workspace } : item
        )
      : [...workspacesEntry.payload, workspace];
    workspacesEntry.updatedAt = Date.now();
  },
  getThreads(workspaceSlug, { allowStale = true } = {}) {
    if (!workspaceSlug) return null;
    const entry = threadsByWorkspace.get(workspaceSlug);
    if (!entry?.payload) return null;
    if (!allowStale && !isFresh(entry, THREADS_TTL_MS)) return null;
    return clone(entry.payload);
  },
  setThreads(workspaceSlug, threads = []) {
    if (!workspaceSlug) return;
    threadsByWorkspace.set(workspaceSlug, {
      payload: clone(threads),
      updatedAt: Date.now(),
    });
  },
  updateThread(workspaceSlug, thread = null) {
    if (!workspaceSlug || !thread?.slug) return;
    const current = this.getThreads(workspaceSlug) || [];
    this.setThreads(workspaceSlug, [
      ...current.filter((item) => item.slug !== thread.slug),
      thread,
    ]);
  },
  removeThread(workspaceSlug, threadSlug = null) {
    if (!workspaceSlug || !threadSlug) return;
    const current = this.getThreads(workspaceSlug);
    if (!current) return;
    this.setThreads(
      workspaceSlug,
      current.filter((thread) => thread.slug !== threadSlug)
    );
  },
  invalidateThreads(workspaceSlug) {
    if (!workspaceSlug) return;
    threadsByWorkspace.delete(workspaceSlug);
  },
  clear() {
    workspacesEntry.payload = null;
    workspacesEntry.updatedAt = 0;
    threadsByWorkspace.clear();
  },
  stats() {
    return {
      hasWorkspaces: !!workspacesEntry.payload,
      workspaceCount: workspacesEntry.payload?.length || 0,
      threadWorkspaceCount: threadsByWorkspace.size,
      threadCount: [...threadsByWorkspace.values()].reduce(
        (sum, entry) => sum + (entry.payload?.length || 0),
        0
      ),
    };
  },
};
