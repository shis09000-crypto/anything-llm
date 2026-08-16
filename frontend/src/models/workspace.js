import { fullApiUrl } from "@/utils/constants";
import {
  deleteJson,
  getJson,
  postJson,
  putJson,
} from "@/lib/communication/apiClient";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import { UPLOAD_KINDS, uploadFormData } from "@/lib/communication/uploadClient";
import { streamQuizSubmit } from "@/lib/communication/quizStreamClient";
import {
  apiErrorFallback as rawOrFallback,
  apiErrorMessage as responseError,
} from "@/lib/communication/apiError";
import { safeJsonParse } from "@/utils/request";
import {
  hydrateUserStateValue,
  pushUserStateValue,
  USER_STATE_NAMESPACES,
} from "@/utils/userStateSync";
import WorkspaceThread from "@/models/workspaceThread";
import { v4 } from "uuid";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";
import { workspaceNavigationCache } from "@/utils/chat/workspaceNavigationCache";
import { dispatchWorkspacePatchVisual } from "@/utils/workspaceEvents";
import { submitProjectedSyncMutation } from "@/utils/syncV2/syncV2ProjectedMutation";
import { shouldPreserveLocalAuthOnFailure } from "@/utils/authSessionMaintenance";

const SYNC_V2_WORKSPACE_METADATA_FIELDS = [
  "name",
  "chatProvider",
  "chatModel",
  "chatMode",
  "agentProvider",
  "agentModel",
  "openAiHistory",
  "similarityThreshold",
  "topN",
  "vectorSearchMode",
];
const CHAT_PAYLOAD_HEADERS = { "X-Athena-Chat-Payload-Version": "2" };

function cachedWorkspace(slug) {
  return (
    workspaceNavigationCache.getWorkspaceDetail(slug, { allowStale: true }) ||
    workspaceNavigationCache
      .getWorkspaces({ allowStale: true })
      ?.find((workspace) => workspace.slug === slug) ||
    null
  );
}

async function syncV2WorkspaceIndex(options = {}) {
  if (options.preferSyncV2Cache !== true) return null;
  try {
    const { syncV2Runtime } = await import("@/utils/syncV2/syncV2Runtime");
    const result = await syncV2Runtime.bootstrap({ signal: options.signal });
    if (!result?.enabled) return null;
    return workspaceNavigationCache.getWorkspaces({ allowStale: true });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return null;
  }
}

async function updateWorkspaceWithSyncV2(slug, data, options = {}) {
  const current = cachedWorkspace(slug);
  if (!Number.isInteger(Number(current?.id))) return null;
  const submitted = await submitProjectedSyncMutation(
    {
      nodeKey: `workspaces/${Number(current.id)}/metadata`,
      payload: data,
      allowedFields: SYNC_V2_WORKSPACE_METADATA_FIELDS,
    },
    {
      allowOffline: options.allowOffline !== false,
      signal: options.signal,
    }
  );
  if (!submitted) return null;
  const workspace = { ...current, ...data };
  workspaceNavigationCache.setWorkspaceDetail(slug, workspace);
  dispatchWorkspacePatchVisual({
    workspace,
    source: "workspace-sync-v2-update",
  });
  return {
    workspace,
    message: null,
    queued: submitted.result?.queued === true,
  };
}

function workspaceTask({
  label,
  slug = null,
  threadSlug = null,
  surface = "workspace",
  priority = "P1",
  policy = null,
  protectedTask = false,
  abortable = null,
  intentRank = undefined,
  resource = "network",
} = {}) {
  return {
    label,
    kind: "workspace",
    priority,
    policy:
      policy ||
      (priority === "P0"
        ? "foreground"
        : priority === "P4"
          ? "maintenance"
          : "visible"),
    resource,
    protected: protectedTask,
    abortable:
      abortable !== null && abortable !== undefined
        ? abortable
        : !protectedTask,
    ...(intentRank !== undefined ? { intentRank } : {}),
    scope: {
      route: "workspace-chat",
      surface,
      ...(slug ? { workspaceSlug: slug } : {}),
      ...(threadSlug ? { threadSlug } : {}),
    },
  };
}

function workspaceUserActionTask(label, slug, surface, threadSlug = null) {
  return workspaceTask({
    label,
    slug,
    threadSlug,
    surface,
    priority: "P0",
    protectedTask: true,
    abortable: false,
    intentRank: 0,
  });
}

function workspaceVisibleTask(label, slug, surface, threadSlug = null) {
  return workspaceTask({
    label,
    slug,
    threadSlug,
    surface,
    priority: "P1",
  });
}

function historyPageQuery({
  limit = 20,
  beforeChatId = null,
  afterChatId = null,
  anchorChatId = null,
  detail = "light",
  priorityWindow = 5,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("detail", detail);
  params.set("priorityWindow", String(priorityWindow));
  if (beforeChatId) params.set("beforeChatId", String(beforeChatId));
  if (afterChatId) params.set("afterChatId", String(afterChatId));
  if (anchorChatId) params.set("anchorChatId", String(anchorChatId));
  return params.toString();
}

const Workspace = {
  workspaceOrderStorageKey: "anythingllm-workspace-order",
  workspaceOrderHydrated: false,
  /** The maximum percentage of the context window that can be used for attachments */
  maxContextWindowLimit: 0.8,

  new: async function (data = {}, options = {}) {
    const { workspace, message, defaultThreads } = await postJson(
      "/workspace/new",
      data,
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-navigation",
        task:
          options.task === undefined
            ? workspaceUserActionTask(
                "workspace:create",
                null,
                "workspace-create"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        return rawOrFallback(e, {
          workspace: null,
          message: e.message,
          defaultThreads: null,
        });
      });

    return {
      workspace: workspace ? { ...workspace, defaultThreads } : null,
      message,
      defaultThreads,
    };
  },
  update: async function (slug, data = {}, options = {}) {
    try {
      const synced = await updateWorkspaceWithSyncV2(slug, data, options);
      if (synced) return synced;
    } catch (error) {
      return {
        workspace: null,
        message: error?.message || "Workspace update failed",
      };
    }
    const { workspace, message } = await postJson(
      `/workspace/${slug}/update`,
      data,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-settings",
        task:
          options.task === undefined
            ? workspaceVisibleTask("workspace:update", slug, "workspace-save")
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        return rawOrFallback(e, { workspace: null, message: e.message });
      });

    if (workspace?.slug) {
      workspaceNavigationCache.setWorkspaceDetail(workspace.slug, workspace);
      dispatchWorkspacePatchVisual({
        workspace,
        source: "workspace-model-update",
      });
    }

    return { workspace, message };
  },
  modifyEmbeddings: async function (slug, changes = {}, options = {}) {
    const {
      workspace,
      message,
      batchJob = null,
    } = await postJson(
      `/workspace/${slug}/update-embeddings`,
      changes, // contains 'adds' and 'removes' keys that are arrays of filepaths
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-upload-action",
        task:
          options.task === undefined
            ? workspaceUserActionTask(
                "workspace:update-embeddings",
                slug,
                "workspace-documents"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        return rawOrFallback(e, { workspace: null, message: e.message });
      });

    return { workspace, message, batchJob };
  },
  removeQueuedEmbedding: async function (slug, filename, options = {}) {
    return deleteJson(`/workspace/${slug}/embed-queue`, {
      body: { filename },
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-upload-action",
      task:
        options.task === undefined
          ? workspaceUserActionTask(
              "workspace:remove-queued-embedding",
              slug,
              "workspace-documents"
            )
          : options.task,
    })
      .then(({ data }) => data)
      .catch(() => ({ success: false }));
  },
  chatHistory: async function (slug, options = {}) {
    const history = await getJson(`/workspace/${slug}/chats`, {
      signal: options.signal,
      headers: CHAT_PAYLOAD_HEADERS,
      communicationScene: "workspace-chat",
      task: options.task,
    })
      .then(({ data }) => data.history || [])
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return [];
      });
    return history;
  },
  chatHistoryPage: async function (slug, options = {}) {
    const query = historyPageQuery(options);
    const payload = await getJson(`/workspace/${slug}/chats?${query}`, {
      signal: options.signal,
      headers: CHAT_PAYLOAD_HEADERS,
      communicationScene: "workspace-chat",
      task: options.task,
    })
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { history: [], page: null };
      });
    return {
      history: payload.history || [],
      page: payload.page || null,
    };
  },
  chatBootstrap: async function (slug, options = {}) {
    const query = historyPageQuery(options);
    const payload = await getJson(`/workspace/${slug}/bootstrap?${query}`, {
      signal: options.signal,
      headers: CHAT_PAYLOAD_HEADERS,
      communicationScene: "workspace-chat",
      task: options.task,
    })
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return null;
      });
    if (!payload?.success) return this.chatHistoryPage(slug, options);
    return {
      workspace: payload.workspace || null,
      thread: payload.thread || null,
      history: payload.history || [],
      page: payload.page || null,
    };
  },
  chatHistoryHydration: async function (slug, chatIds = [], options = {}) {
    const publicChatIds = options.publicChatIds || [];
    if (!chatIds.length && !publicChatIds.length)
      return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
    const payload = await postJson(
      `/workspace/${slug}/chats/hydrate`,
      { chatIds, publicChatIds },
      {
        signal: options.signal,
        headers: CHAT_PAYLOAD_HEADERS,
        communicationScene: "workspace-chat",
        task: options.task,
      }
    )
      .then(({ data }) => data)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
      });
    return {
      history: payload.history || [],
      hydratedChatIds: payload.hydratedChatIds || [],
      hydratedPublicChatIds: payload.hydratedPublicChatIds || [],
    };
  },
  updateChatFeedback: async function (chatId, slug, feedback, options = {}) {
    const result = await postJson(
      `/workspace/${slug}/chat-feedback/${chatId}`,
      {
        feedback,
      },
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceVisibleTask(
                "workspace:chat-feedback",
                slug,
                "chat-feedback"
              )
            : options.task,
      }
    )
      .then(() => true)
      .catch(() => false);
    return result;
  },

  deleteChats: async function (slug = "", chatIds = [], options = {}) {
    return await deleteJson(`/workspace/${slug}/delete-chats`, {
      body: { chatIds },
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task:
        options.task === undefined
          ? workspaceUserActionTask("workspace:delete-chats", slug, "chat-edit")
          : options.task,
    })
      .then(() => {
        threadHistoryCache.invalidateThread(slug, null);
        return true;
      })
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  deleteEditedChats: async function (
    slug = "",
    threadSlug = "",
    startingId,
    options = {}
  ) {
    if (!!threadSlug)
      return this.threads._deleteEditedChats(
        slug,
        threadSlug,
        startingId,
        options
      );
    return this._deleteEditedChats(slug, startingId, options);
  },
  updateChat: async function (
    slug = "",
    threadSlug = "",
    chatId,
    newText,
    role = "assistant",
    options = {}
  ) {
    if (!!threadSlug)
      return this.threads._updateChat(
        slug,
        threadSlug,
        chatId,
        newText,
        role,
        options
      );
    const result = await this._updateChat(slug, chatId, newText, role, options);
    if (result) threadHistoryCache.invalidateThread(slug, null);
    return result;
  },
  all: async function (options = {}) {
    const projected = await syncV2WorkspaceIndex(options);
    if (Array.isArray(projected)) return projected;
    const workspaces = await getJson("/workspaces", {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-navigation",
      task: options.task,
    })
      .then(({ data }) => data.workspaces || [])
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        if (shouldPreserveLocalAuthOnFailure(error)) {
          workspaceNavigationCache.markWorkspacesStale(
            "workspace-list-temporarily-unavailable"
          );
          if (options.throwOnError === true) throw error;
          const cached = workspaceNavigationCache.getWorkspaces({
            allowStale: true,
          });
          if (Array.isArray(cached)) return cached;
        }
        if (options.throwOnError === true) throw error;
        return [];
      });
    if (Array.isArray(workspaces) && workspaces.length)
      workspaceNavigationCache.setWorkspaces(workspaces);

    return workspaces;
  },
  bySlug: async function (slug = "", options = {}) {
    const workspace = await getJson(`/workspace/${slug}`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task: options.task,
    })
      .then(({ data }) => data.workspace)
      .catch((error) => {
        if (error?.name === "AbortError") throw error;
        if (shouldPreserveLocalAuthOnFailure(error)) {
          workspaceNavigationCache.markWorkspaceDetailStale(
            slug,
            "workspace-detail-temporarily-unavailable"
          );
          if (options.throwOnError === true) throw error;
          return cachedWorkspace(slug);
        }
        if (options.throwOnError === true) throw error;
        return null;
      });
    if (workspace?.slug)
      workspaceNavigationCache.setWorkspaceDetail(workspace.slug, workspace);
    return workspace;
  },
  delete: async function (slug, options = {}) {
    const body =
      options.deleteIntentId || options.sourceActionId
        ? {
            deleteIntentId: options.deleteIntentId,
            sourceActionId: options.sourceActionId,
          }
        : undefined;
    const result = await deleteJson(`/workspace/${slug}`, {
      body,
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-navigation",
      task:
        options.task === undefined
          ? workspaceUserActionTask(
              "workspace:delete",
              slug,
              "workspace-delete"
            )
          : options.task,
    })
      .then(() => true)
      .catch(() => false);

    return result;
  },
  wipeVectorDb: async function (slug, options = {}) {
    return await deleteJson(`/workspace/${slug}/reset-vector-db`, {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-settings-security",
      task:
        options.task === undefined
          ? workspaceUserActionTask(
              "workspace:wipe-vector-db",
              slug,
              "workspace-settings"
            )
          : options.task,
    })
      .then(() => true)
      .catch(() => false);
  },
  uploadFile: async function (
    slug,
    formData,
    folderName = "custom-documents",
    options = {}
  ) {
    if (folderName && !formData.has("folderName")) {
      formData.append("folderName", folderName);
    }
    const { response, data } = await uploadFormData(
      `/workspace/${slug}/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.workspaceFile,
        communicationScene:
          options.communicationScene || "workspace-upload-visible",
        task: options.task,
        signal: options.signal,
        onUploadProgress: options.onUploadProgress,
      }
    );

    return { response, data };
  },
  parseFile: async function (slug, formData, options = {}) {
    const { response, data } = await uploadFormData(
      `/workspace/${slug}/parse`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.workspaceFile,
        communicationScene:
          options.communicationScene || "workspace-upload-visible",
        task: options.task,
        signal: options.signal,
      }
    );

    return { response, data };
  },

  getParsedFiles: async function (slug, threadSlug = null, options = {}) {
    const basePath = new URL(`${fullApiUrl()}/workspace/${slug}/parsed-files`);
    if (threadSlug) basePath.searchParams.set("threadSlug", threadSlug);
    const { data } = await getJson(basePath.toString(), {
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-upload-visible",
      task: options.task,
    });
    return data;
  },
  uploadLink: async function (
    slug,
    link,
    folderName = "custom-documents",
    options = {}
  ) {
    const { response, data } = await postJson(
      `/workspace/${slug}/upload-link`,
      {
        link,
        folderName,
      },
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-upload-visible",
        task: options.task,
      }
    );
    return { response, data };
  },

  getSuggestedMessages: async function (slug, options = {}) {
    return await getJson(`/workspace/${slug}/suggested-messages`, {
      cache: "no-cache",
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task: options.task,
    })
      .then(({ data }) => data.suggestedMessages)
      .catch((e) => {
        if (e?.name === "AbortError") throw e;
        console.error(e);
        return null;
      });
  },
  setSuggestedMessages: async function (slug, messages, options = {}) {
    return postJson(
      `/workspace/${slug}/suggested-messages`,
      { messages },
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-settings",
        task:
          options.task === undefined
            ? workspaceVisibleTask(
                "workspace:set-suggested-messages",
                slug,
                "workspace-settings"
              )
            : options.task,
      }
    )
      .then(({ data }) => ({ success: true, ...data }))
      .catch((e) => {
        console.error(e);
        return {
          success: false,
          error: responseError(e, "Error setting suggested messages."),
        };
      });
  },
  setPinForDocument: async function (slug, docPath, pinStatus, options = {}) {
    return postJson(
      `/workspace/${slug}/update-pin`,
      { docPath, pinStatus },
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-upload-action",
        task:
          options.task === undefined
            ? workspaceUserActionTask(
                "workspace:set-document-pin",
                slug,
                "workspace-documents"
              )
            : options.task,
      }
    )
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  ttsMessage: async function (slug, chatId, options = {}) {
    return await requestBlob(`/workspace/${slug}/tts/${chatId}`, {
      cache: "no-cache",
      blobKind: BLOB_KINDS.ttsAudio,
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task:
        options.task === undefined
          ? workspaceVisibleTask("workspace:tts-message", slug, "chat-tts")
          : options.task,
    })
      .then(({ response, blob }) =>
        response.status !== 204 && blob ? URL.createObjectURL(blob) : null
      )
      .catch(() => {
        return null;
      });
  },
  uploadPfp: async function (formData, slug, options = {}) {
    return await uploadFormData(`/workspace/${slug}/upload-pfp`, formData, {
      uploadKind: UPLOAD_KINDS.avatar,
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-settings",
      task:
        options.task === undefined
          ? workspaceVisibleTask(
              "workspace:upload-profile-picture",
              slug,
              "workspace-settings"
            )
          : options.task,
    })
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },

  fetchPfp: async function (slug, options = {}) {
    return await requestBlob(`/workspace/${slug}/pfp`, {
      cache: "no-cache",
      blobKind: BLOB_KINDS.avatar,
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-navigation",
      task:
        options.task === undefined
          ? workspaceVisibleTask(
              "workspace:profile-picture",
              slug,
              "workspace-avatar"
            )
          : options.task,
    })
      .then(({ response, blob }) =>
        response.status !== 204 && blob ? URL.createObjectURL(blob) : null
      )
      .catch(() => {
        return null;
      });
  },

  removePfp: async function (slug, options = {}) {
    return await deleteJson(`/workspace/${slug}/remove-pfp`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-settings",
      task:
        options.task === undefined
          ? workspaceVisibleTask(
              "workspace:remove-profile-picture",
              slug,
              "workspace-settings"
            )
          : options.task,
    })
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },
  _updateChat: async function (
    slug = "",
    chatId,
    newText,
    role = "assistant",
    options = {}
  ) {
    return await postJson(
      `/workspace/${slug}/update-chat`,
      {
        chatId,
        newText,
        role,
      },
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceUserActionTask(
                "workspace:update-chat",
                slug,
                "chat-edit"
              )
            : options.task,
      }
    )
      .then(() => true)
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  _deleteEditedChats: async function (slug = "", startingId, options = {}) {
    return await deleteJson(`/workspace/${slug}/delete-edited-chats`, {
      body: { startingId },
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task:
        options.task === undefined
          ? workspaceUserActionTask(
              "workspace:delete-edited-chats",
              slug,
              "chat-edit"
            )
          : options.task,
    })
      .then(() => true)
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  deleteChat: async (chatId, options = {}) => {
    return await putJson(`/workspace/workspace-chats/${chatId}`, undefined, {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task:
        options.task === undefined
          ? workspaceUserActionTask("workspace:delete-chat", null, "chat-edit")
          : options.task,
    })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  deleteChatTurn: async function (
    workspaceSlug = "",
    threadSlug = null,
    chatId,
    { sourceActionId, signal } = {}
  ) {
    const identity = encodeURIComponent(String(chatId || ""));
    const path = threadSlug
      ? `/workspace/${workspaceSlug}/thread/${threadSlug}/chat/${identity}`
      : `/workspace/${workspaceSlug}/chat/${identity}`;
    return await deleteJson(path, {
      body: { sourceActionId },
      signal,
      communicationScene: "workspace-chat",
      task: workspaceUserActionTask(
        "workspace:delete-chat-turn",
        workspaceSlug,
        "chat-edit"
      ),
    }).then(({ data }) => {
      threadHistoryCache.invalidateThread(workspaceSlug, threadSlug || null);
      return data;
    });
  },
  forkThread: async function (
    slug = "",
    threadSlug = null,
    chatId = null,
    options = {}
  ) {
    const {
      signal,
      task,
      communicationScene,
      returnFull = false,
      ...forkOptions
    } = options;
    return await postJson(
      `/workspace/${slug}/thread/fork`,
      {
        threadSlug,
        chatId,
        ...forkOptions,
      },
      {
        signal,
        communicationScene: communicationScene || "workspace-thread-action",
        task:
          task === undefined
            ? workspaceUserActionTask(
                "workspace:fork-thread",
                slug,
                "thread-fork",
                threadSlug
              )
            : task,
      }
    )
      .then(({ data }) => data)
      .then((data) => (returnFull ? data : data.newThreadSlug))
      .catch((e) => {
        console.error("Error forking thread:", e);
        const error = responseError(e, "Failed to fork thread.");
        return returnFull ? { error } : null;
      });
  },
  /**
   * Uploads and embeds a single file in a single call into a workspace
   * @param {string} slug - workspace slug
   * @param {FormData} formData
   * @returns {Promise<{response: {ok: boolean}, data: {success: boolean, error: string|null, document: {id: string, location:string}|null}}>}
   */
  uploadAndEmbedFile: async function (slug, formData, options = {}) {
    const { response, data } = await uploadFormData(
      `/workspace/${slug}/upload-and-embed`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.uploadAndEmbed,
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-upload-action",
        task:
          options.task === undefined
            ? workspaceUserActionTask(
                "workspace:upload-and-embed",
                slug,
                "workspace-upload"
              )
            : options.task,
      }
    );

    return { response, data };
  },

  deleteParsedFiles: async function (slug, fileIds = [], options = {}) {
    return await deleteJson(`/workspace/${slug}/delete-parsed-files`, {
      body: { fileIds },
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-upload-action",
      task:
        options.task === undefined
          ? workspaceUserActionTask(
              "workspace:delete-parsed-files",
              slug,
              "workspace-upload"
            )
          : options.task,
    })
      .then(() => true)
      .catch(() => false);
  },

  embedParsedFile: async function (slug, fileId, options = {}) {
    const { response, data } = await postJson(
      `/workspace/${slug}/embed-parsed-file/${fileId}`,
      {},
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-upload-visible",
        task: options.task,
      }
    );
    return { response, data };
  },

  /**
   * Deletes and un-embeds a single file in a single call from a workspace
   * @param {string} slug - workspace slug
   * @param {string} documentLocation - location of file eg: custom-documents/my-file-uuid.json
   * @returns {Promise<boolean>}
   */
  deleteAndUnembedFile: async function (slug, documentLocation, options = {}) {
    return await deleteJson(`/workspace/${slug}/remove-and-unembed`, {
      body: { documentLocation },
      signal: options.signal,
      communicationScene:
        options.communicationScene || "workspace-upload-action",
      task:
        options.task === undefined
          ? workspaceUserActionTask(
              "workspace:delete-and-unembed",
              slug,
              "workspace-documents"
            )
          : options.task,
    })
      .then(() => true)
      .catch(() => false);
  },

  /**
   * Reorders workspaces in the UI via localstorage on client side.
   * @param {string[]} workspaceIds - array of workspace ids to reorder
   * @returns {boolean}
   */
  storeWorkspaceOrder: function (workspaceIds = []) {
    try {
      localStorage.setItem(
        this.workspaceOrderStorageKey,
        JSON.stringify(workspaceIds)
      );
      pushUserStateValue(USER_STATE_NAMESPACES.workspaceOrder, "global", {
        workspaceIds,
      });
      return true;
    } catch (error) {
      console.error("Error reordering workspaces:", error);
      return false;
    }
  },

  /**
   * Orders workspaces based on the order preference stored in localstorage
   * @param {Array} workspaces - array of workspace JSON objects
   * @returns {Array} - ordered workspaces
   */
  orderWorkspaces: function (workspaces = []) {
    if (!this.workspaceOrderHydrated) {
      this.workspaceOrderHydrated = true;
      void hydrateUserStateValue({
        namespace: USER_STATE_NAMESPACES.workspaceOrder,
        fallback: {
          workspaceIds:
            safeJsonParse(
              localStorage.getItem(this.workspaceOrderStorageKey)
            ) || [],
        },
        apply: (value) => {
          if (Array.isArray(value?.workspaceIds)) {
            localStorage.setItem(
              this.workspaceOrderStorageKey,
              JSON.stringify(value.workspaceIds)
            );
          }
        },
      });
    }
    const workspaceOrderPreference =
      safeJsonParse(localStorage.getItem(this.workspaceOrderStorageKey)) || [];
    if (workspaceOrderPreference.length === 0) return workspaces;
    const orderedWorkspaces = Array.from(workspaces);
    orderedWorkspaces.sort(
      (a, b) =>
        workspaceOrderPreference.indexOf(a.id) -
        workspaceOrderPreference.indexOf(b.id)
    );
    return orderedWorkspaces;
  },

  /**
   * Searches for workspaces and threads
   * @param {string} searchTerm
   * @returns {Promise<{workspaces: [{slug: string, name: string}], threads: [{slug: string, name: string, workspace: {slug: string, name: string}}]}}>}
   */
  searchWorkspaceOrThread: async function (searchTerm, options = {}) {
    const response = await postJson(
      "/workspace/search",
      { searchTerm },
      {
        signal: options.signal,
        communicationScene:
          options.communicationScene || "workspace-navigation",
        task:
          options.task === undefined
            ? workspaceVisibleTask("workspace:search", null, "workspace-search")
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return { workspaces: [], threads: [] };
      });
    return response;
  },

  generateQuiz: async function (
    slug,
    {
      message,
      threadSlug = null,
      nodeContext = null,
      clientTurnId = null,
    } = {},
    options = {}
  ) {
    return await postJson(
      `/workspace/${slug}/quiz/generate`,
      {
        message,
        threadSlug,
        nodeContext,
        clientTurnId,
      },
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs || 20_000,
        communicationScene: options.communicationScene || "workspace-chat",
        // Quiz acceptance must not wait behind workspace bootstrap/prefetch
        // requests. The Responses runtime persists the turn immediately and
        // owns all later plan/RAG/model work.
        task: options.task === undefined ? false : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  quizHistory: async function (slug, threadSlug = null, options = {}) {
    const query = threadSlug
      ? `?threadSlug=${encodeURIComponent(threadSlug)}`
      : "";
    return await getJson(`/workspace/${slug}/quiz-history${query}`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs || 15_000,
      communicationScene: options.communicationScene || "workspace-chat",
      task: options.task === undefined ? false : options.task,
    })
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, history: [] }));
  },

  quizStatus: async function (slug, quizId, options = {}) {
    return await getJson(`/workspace/${slug}/quiz/${quizId}/status`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs || 12_000,
      communicationScene: options.communicationScene || "workspace-chat",
      task: options.task === undefined ? false : options.task,
    })
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  submitQuiz: async function (slug, quizId, answers = {}, options = {}) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/submit`,
      {
        answers,
      },
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceUserActionTask("workspace:quiz-submit", slug, "quiz")
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  submitQuizStream: async function (slug, quizId, answers = {}, handleChat) {
    await streamQuizSubmit({
      workspaceSlug: slug,
      quizId,
      answers,
      onEvent(event) {
        if (event) handleChat?.(event);
      },
      onError(error) {
        handleChat?.({
          id: v4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: error.message,
        });
      },
    });
  },

  saveQuizProgress: async function (
    slug,
    quizId,
    { answers = {}, currentIndex = 0 } = {},
    options = {}
  ) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/progress`,
      {
        answers,
        currentIndex,
      },
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceVisibleTask("workspace:quiz-progress", slug, "quiz")
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  abandonQuiz: async function (slug, quizId, options = {}) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/abandon`,
      undefined,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceVisibleTask("workspace:quiz-abandon", slug, "quiz")
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  saveQuizWrongQuestions: async function (slug, quizId, options = {}) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/wrong-questions`,
      undefined,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceVisibleTask(
                "workspace:quiz-save-wrong-questions",
                slug,
                "quiz"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  dismissQuizWrongQuestions: async function (slug, quizId, options = {}) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/wrong-questions/dismiss`,
      {},
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceUserActionTask(
                "workspace:quiz-wrong-questions-dismiss",
                slug,
                "quiz"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  favoriteQuizQuestion: async function (
    slug,
    quizId,
    questionId,
    options = {}
  ) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/favorite-question`,
      { questionId },
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceVisibleTask(
                "workspace:quiz-favorite-question",
                slug,
                "quiz"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  unfavoriteQuizQuestion: async function (
    slug,
    quizId,
    questionId,
    options = {}
  ) {
    return await deleteJson(
      `/workspace/${slug}/quiz/${quizId}/favorite-question/${questionId}`,
      {
        signal: options.signal,
        communicationScene: options.communicationScene || "workspace-chat",
        task:
          options.task === undefined
            ? workspaceVisibleTask(
                "workspace:quiz-unfavorite-question",
                slug,
                "quiz"
              )
            : options.task,
      }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  /**
   * Checks if the agent command is available for a workspace
   * by checking if the workspace's agent provider supports native tool calling.
   *
   * This can be model specific or enabled via ENV flag.
   * @param {string} slug - workspace slug
   * @returns {Promise<{showAgentCommand: boolean}>}
   */
  agentCommandAvailable: async function (slug = null, options = {}) {
    if (!slug) return { showAgentCommand: true };
    return await getJson(`/workspace/${slug}/is-agent-command-available`, {
      signal: options.signal,
      communicationScene: options.communicationScene || "workspace-chat",
      task: options.task,
    })
      .then(({ data }) => data)
      .catch((e) => {
        if (e?.name === "AbortError") throw e;
        console.error(e);
        return { showAgentCommand: true };
      });
  },

  threads: WorkspaceThread,
};

export default Workspace;
