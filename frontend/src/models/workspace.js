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
import WorkspaceThread from "@/models/workspaceThread";
import { v4 } from "uuid";
import { threadHistoryCache } from "@/utils/chat/threadHistoryCache";

function historyPageQuery({
  limit = 20,
  beforeChatId = null,
  detail = "light",
  priorityWindow = 5,
} = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("detail", detail);
  params.set("priorityWindow", String(priorityWindow));
  if (beforeChatId) params.set("beforeChatId", String(beforeChatId));
  return params.toString();
}

const Workspace = {
  workspaceOrderStorageKey: "anythingllm-workspace-order",
  /** The maximum percentage of the context window that can be used for attachments */
  maxContextWindowLimit: 0.8,

  new: async function (data = {}) {
    const { workspace, message, defaultThreads } = await postJson(
      "/workspace/new",
      data
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
  update: async function (slug, data = {}) {
    const { workspace, message } = await postJson(
      `/workspace/${slug}/update`,
      data
    )
      .then(({ data }) => data)
      .catch((e) => {
        return rawOrFallback(e, { workspace: null, message: e.message });
      });

    return { workspace, message };
  },
  modifyEmbeddings: async function (slug, changes = {}) {
    const {
      workspace,
      message,
      batchJob = null,
    } = await postJson(
      `/workspace/${slug}/update-embeddings`,
      changes // contains 'adds' and 'removes' keys that are arrays of filepaths
    )
      .then(({ data }) => data)
      .catch((e) => {
        return rawOrFallback(e, { workspace: null, message: e.message });
      });

    return { workspace, message, batchJob };
  },
  removeQueuedEmbedding: async function (slug, filename) {
    return deleteJson(`/workspace/${slug}/embed-queue`, {
      body: { filename },
    })
      .then(({ data }) => data)
      .catch(() => ({ success: false }));
  },
  chatHistory: async function (slug, options = {}) {
    const history = await getJson(`/workspace/${slug}/chats`, {
      signal: options.signal,
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
  chatHistoryHydration: async function (slug, chatIds = [], options = {}) {
    if (!chatIds.length)
      return { history: [], hydratedChatIds: [], hydratedPublicChatIds: [] };
    const payload = await postJson(
      `/workspace/${slug}/chats/hydrate`,
      { chatIds },
      { signal: options.signal }
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
  updateChatFeedback: async function (chatId, slug, feedback) {
    const result = await postJson(
      `/workspace/${slug}/chat-feedback/${chatId}`,
      {
        feedback,
      }
    )
      .then(() => true)
      .catch(() => false);
    return result;
  },

  deleteChats: async function (slug = "", chatIds = []) {
    return await deleteJson(`/workspace/${slug}/delete-chats`, {
      body: { chatIds },
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
  deleteEditedChats: async function (slug = "", threadSlug = "", startingId) {
    if (!!threadSlug)
      return this.threads._deleteEditedChats(slug, threadSlug, startingId);
    return this._deleteEditedChats(slug, startingId);
  },
  updateChat: async function (
    slug = "",
    threadSlug = "",
    chatId,
    newText,
    role = "assistant"
  ) {
    if (!!threadSlug)
      return this.threads._updateChat(slug, threadSlug, chatId, newText, role);
    const result = await this._updateChat(slug, chatId, newText, role);
    if (result) threadHistoryCache.invalidateThread(slug, null);
    return result;
  },
  all: async function () {
    const workspaces = await getJson("/workspaces")
      .then(({ data }) => data.workspaces || [])
      .catch(() => []);

    return workspaces;
  },
  bySlug: async function (slug = "") {
    const workspace = await getJson(`/workspace/${slug}`)
      .then(({ data }) => data.workspace)
      .catch(() => null);
    return workspace;
  },
  delete: async function (slug) {
    const result = await deleteJson(`/workspace/${slug}`)
      .then(() => true)
      .catch(() => false);

    return result;
  },
  wipeVectorDb: async function (slug) {
    return await deleteJson(`/workspace/${slug}/reset-vector-db`)
      .then(() => true)
      .catch(() => false);
  },
  uploadFile: async function (slug, formData, folderName = "custom-documents") {
    if (folderName && !formData.has("folderName")) {
      formData.append("folderName", folderName);
    }
    const { response, data } = await uploadFormData(
      `/workspace/${slug}/upload`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.workspaceFile,
      }
    );

    return { response, data };
  },
  parseFile: async function (slug, formData) {
    const { response, data } = await uploadFormData(
      `/workspace/${slug}/parse`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.workspaceFile,
      }
    );

    return { response, data };
  },

  getParsedFiles: async function (slug, threadSlug = null) {
    const basePath = new URL(`${fullApiUrl()}/workspace/${slug}/parsed-files`);
    if (threadSlug) basePath.searchParams.set("threadSlug", threadSlug);
    const { data } = await getJson(basePath.toString());
    return data;
  },
  uploadLink: async function (slug, link, folderName = "custom-documents") {
    const { response, data } = await postJson(
      `/workspace/${slug}/upload-link`,
      {
        link,
        folderName,
      }
    );
    return { response, data };
  },

  getSuggestedMessages: async function (slug) {
    return await getJson(`/workspace/${slug}/suggested-messages`, {
      cache: "no-cache",
    })
      .then(({ data }) => data.suggestedMessages)
      .catch((e) => {
        console.error(e);
        return null;
      });
  },
  setSuggestedMessages: async function (slug, messages) {
    return postJson(`/workspace/${slug}/suggested-messages`, { messages })
      .then(({ data }) => ({ success: true, ...data }))
      .catch((e) => {
        console.error(e);
        return {
          success: false,
          error: responseError(e, "Error setting suggested messages."),
        };
      });
  },
  setPinForDocument: async function (slug, docPath, pinStatus) {
    return postJson(`/workspace/${slug}/update-pin`, { docPath, pinStatus })
      .then(() => true)
      .catch((e) => {
        console.error(e);
        return false;
      });
  },
  ttsMessage: async function (slug, chatId) {
    return await requestBlob(`/workspace/${slug}/tts/${chatId}`, {
      cache: "no-cache",
      blobKind: BLOB_KINDS.ttsAudio,
    })
      .then(({ response, blob }) =>
        response.status !== 204 && blob ? URL.createObjectURL(blob) : null
      )
      .catch(() => {
        return null;
      });
  },
  uploadPfp: async function (formData, slug) {
    return await uploadFormData(`/workspace/${slug}/upload-pfp`, formData, {
      uploadKind: UPLOAD_KINDS.avatar,
    })
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },

  fetchPfp: async function (slug) {
    return await requestBlob(`/workspace/${slug}/pfp`, {
      cache: "no-cache",
      blobKind: BLOB_KINDS.avatar,
    })
      .then(({ response, blob }) =>
        response.status !== 204 && blob ? URL.createObjectURL(blob) : null
      )
      .catch(() => {
        return null;
      });
  },

  removePfp: async function (slug) {
    return await deleteJson(`/workspace/${slug}/remove-pfp`)
      .then(() => {
        return { success: true, error: null };
      })
      .catch((e) => {
        console.log(e);
        return { success: false, error: e.message };
      });
  },
  _updateChat: async function (slug = "", chatId, newText, role = "assistant") {
    return await postJson(`/workspace/${slug}/update-chat`, {
      chatId,
      newText,
      role,
    })
      .then(() => true)
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  _deleteEditedChats: async function (slug = "", startingId) {
    return await deleteJson(`/workspace/${slug}/delete-edited-chats`, {
      body: { startingId },
    })
      .then(() => true)
      .catch((e) => {
        console.log(e);
        return false;
      });
  },
  deleteChat: async (chatId) => {
    return await putJson(`/workspace/workspace-chats/${chatId}`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  forkThread: async function (
    slug = "",
    threadSlug = null,
    chatId = null,
    options = {}
  ) {
    return await postJson(`/workspace/${slug}/thread/fork`, {
      threadSlug,
      chatId,
      ...options,
    })
      .then(({ data }) => data)
      .then((data) => (options.returnFull ? data : data.newThreadSlug))
      .catch((e) => {
        console.error("Error forking thread:", e);
        const error = responseError(e, "Failed to fork thread.");
        return options.returnFull ? { error } : null;
      });
  },
  /**
   * Uploads and embeds a single file in a single call into a workspace
   * @param {string} slug - workspace slug
   * @param {FormData} formData
   * @returns {Promise<{response: {ok: boolean}, data: {success: boolean, error: string|null, document: {id: string, location:string}|null}}>}
   */
  uploadAndEmbedFile: async function (slug, formData) {
    const { response, data } = await uploadFormData(
      `/workspace/${slug}/upload-and-embed`,
      formData,
      {
        uploadKind: UPLOAD_KINDS.uploadAndEmbed,
      }
    );

    return { response, data };
  },

  deleteParsedFiles: async function (slug, fileIds = []) {
    return await deleteJson(`/workspace/${slug}/delete-parsed-files`, {
      body: { fileIds },
    })
      .then(() => true)
      .catch(() => false);
  },

  embedParsedFile: async function (slug, fileId) {
    const { response, data } = await postJson(
      `/workspace/${slug}/embed-parsed-file/${fileId}`
    );
    return { response, data };
  },

  /**
   * Deletes and un-embeds a single file in a single call from a workspace
   * @param {string} slug - workspace slug
   * @param {string} documentLocation - location of file eg: custom-documents/my-file-uuid.json
   * @returns {Promise<boolean>}
   */
  deleteAndUnembedFile: async function (slug, documentLocation) {
    return await deleteJson(`/workspace/${slug}/remove-and-unembed`, {
      body: { documentLocation },
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
  searchWorkspaceOrThread: async function (searchTerm) {
    const response = await postJson("/workspace/search", { searchTerm })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return { workspaces: [], threads: [] };
      });
    return response;
  },

  generateQuiz: async function (
    slug,
    { message, threadSlug = null, nodeContext = null } = {}
  ) {
    return await postJson(`/workspace/${slug}/quiz/generate`, {
      message,
      threadSlug,
      nodeContext,
    })
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  quizStatus: async function (slug, quizId) {
    return await getJson(`/workspace/${slug}/quiz/${quizId}/status`)
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  submitQuiz: async function (slug, quizId, answers = {}) {
    return await postJson(`/workspace/${slug}/quiz/${quizId}/submit`, {
      answers,
    })
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
    { answers = {}, currentIndex = 0 } = {}
  ) {
    return await postJson(`/workspace/${slug}/quiz/${quizId}/progress`, {
      answers,
      currentIndex,
    })
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  abandonQuiz: async function (slug, quizId) {
    return await postJson(`/workspace/${slug}/quiz/${quizId}/abandon`)
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  saveQuizWrongQuestions: async function (slug, quizId) {
    return await postJson(`/workspace/${slug}/quiz/${quizId}/wrong-questions`)
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  favoriteQuizQuestion: async function (slug, quizId, questionId) {
    return await postJson(
      `/workspace/${slug}/quiz/${quizId}/favorite-question`,
      { questionId }
    )
      .then(({ data }) => data)
      .catch((e) => rawOrFallback(e, { success: false, error: e.message }));
  },

  unfavoriteQuizQuestion: async function (slug, quizId, questionId) {
    return await deleteJson(
      `/workspace/${slug}/quiz/${quizId}/favorite-question/${questionId}`
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
  agentCommandAvailable: async function (slug = null) {
    if (!slug) return { showAgentCommand: true };
    return await getJson(`/workspace/${slug}/is-agent-command-available`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return { showAgentCommand: true };
      });
  },

  threads: WorkspaceThread,
};

export default Workspace;
