const EventEmitter = require("events");

const THREAD_TITLE_UPDATED_EVENT = "threadTitleUpdated";
const threadTitleEvents = new EventEmitter();
threadTitleEvents.setMaxListeners(200);

function titleDebug(event, payload = {}) {
  if (process.env.THREAD_TITLE_DEBUG !== "true") return;
  console.log(`[ThreadTitle] ${event}`, JSON.stringify(payload));
}

function publishThreadTitleUpdate(thread = {}) {
  if (!thread?.id || !thread?.slug) return;
  const event = {
    threadId: Number(thread.id),
    workspaceId: Number(thread.workspace_id),
    userId: thread.user_id ?? null,
    slug: thread.slug,
    name: thread.isUntitled ? "" : thread.name || "",
    title: thread.isUntitled ? null : thread.title || thread.name || null,
    isUntitled: thread.isUntitled === true,
    titleSource: thread.titleSource,
    titleGenerationStatus: thread.titleGenerationStatus,
    titleVersion: thread.titleVersion,
  };
  titleDebug("event:publish", event);
  threadTitleEvents.emit(THREAD_TITLE_UPDATED_EVENT, event);
}

function subscribeToThreadTitleUpdates(handler) {
  threadTitleEvents.on(THREAD_TITLE_UPDATED_EVENT, handler);
  return () => threadTitleEvents.off(THREAD_TITLE_UPDATED_EVENT, handler);
}

module.exports = {
  publishThreadTitleUpdate,
  subscribeToThreadTitleUpdates,
  _internals: {
    THREAD_TITLE_UPDATED_EVENT,
    threadTitleEvents,
  },
};
