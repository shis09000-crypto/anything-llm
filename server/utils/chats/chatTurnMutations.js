const { DataAccessCenter } = require("../dataAccess");
const { publishWorkspaceSyncEvent } = require("./workspaceSyncEvents");
const {
  _internals: { flushDurableCommits },
} = require("../broadcast");

const WorkspaceChat = DataAccessCenter.workspaceChat;
const WorkspaceThread = DataAccessCenter.workspaceThread;

function chatMutationHTTPStatus(error = null) {
  switch (error?.code) {
    case "chat_mutation_target_not_found":
      return 404;
    case "chat_mutation_source_action_conflict":
    case "regenerate_target_not_latest":
      return 409;
    case "chat_mutation_invalid_workspace":
    case "chat_mutation_invalid_thread":
    case "chat_mutation_missing_source_action":
    case "delete_invalid_target_chat":
      return 400;
    default:
      return 500;
  }
}

async function threadHistorySyncMetadata(thread = null, user = null) {
  if (!thread?.id) return {};
  const current = await WorkspaceThread.get({ id: Number(thread.id) });
  if (!current) return {};
  const [manifest] = await WorkspaceThread.historyFingerprintManifest({
    threads: [current],
    userId: user?.id || null,
  });
  return manifest
    ? {
        historyRevision: manifest.historyRevision,
        historyFingerprint: manifest.historyFingerprint,
      }
    : {};
}

async function publishCommittedChatDeletion({
  workspace,
  thread = null,
  user = null,
  clientContext = null,
  sourceActionId,
  clientTurnId = null,
  mutationKind,
  startingChatId = null,
  targetChatId = null,
  publicChatId = null,
} = {}) {
  const historyMetadata = await threadHistorySyncMetadata(thread, user);
  const event = publishWorkspaceSyncEvent(
    {
      type: "chat_deleted",
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      userId: user?.id ?? null,
      threadId: thread?.id || null,
      threadSlug: thread?.slug || null,
      chatId: targetChatId,
      publicChatId,
      senderClientId: clientContext?.clientId || null,
      sourceActionId,
      clientTurnId,
      mutationKind,
      startingChatId,
      targetChatId,
      ...historyMetadata,
    },
    { coalesce: false }
  );
  await flushDurableCommits();
  return event;
}

async function deleteChatTurnAndPublish({
  workspace,
  thread = null,
  user = null,
  clientContext = null,
  chatId = null,
  publicChatId = null,
  sourceActionId,
} = {}) {
  const result = await WorkspaceChat.deleteTurnPermanently({
    workspaceId: workspace.id,
    threadId: thread?.id || null,
    userId: user?.id || null,
    chatId,
    publicChatId,
    sourceActionId,
  });
  if (!result.replayed) {
    await publishCommittedChatDeletion({
      workspace,
      thread,
      user,
      clientContext,
      sourceActionId,
      mutationKind: "manual-delete",
      targetChatId: chatId,
      publicChatId,
    });
  }
  return result;
}

module.exports = {
  chatMutationHTTPStatus,
  deleteChatTurnAndPublish,
  publishCommittedChatDeletion,
  threadHistorySyncMetadata,
};
