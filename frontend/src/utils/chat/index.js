import { THREAD_RENAME_EVENT } from "@/components/Sidebar/ActiveWorkspaces/ThreadContainer";

export const ABORT_STREAM_EVENT = "abort-chat-stream";

export function dispatchThreadRename(thread) {
  if (!thread?.slug || !thread?.name) return;
  window.dispatchEvent(
    new CustomEvent(THREAD_RENAME_EVENT, {
      detail: {
        threadSlug: thread.slug,
        newName: thread.name,
        title: thread.title || thread.name,
        titleVersion: thread.titleVersion,
        animate: !!thread.animate,
      },
    })
  );
}

export function getWorkspaceSystemPrompt(workspace) {
  return (
    workspace?.openAiPrompt ??
    "请根据以下 conversation、relevant context 和用户的 follow-up question，回答用户当前正在询问的问题。请只输出对当前问题的回答，并在需要时遵循用户的 instructions。\n\n当用户要求向量化文件时，优先使用 document-ingest-agent 的 document_identifiers 批量路径，而非 rag-memory store。"
  );
}

export function chatQueryRefusalResponse(workspace) {
  return (
    workspace?.queryRefusalResponse ??
    "There is no relevant information in this workspace to answer your query."
  );
}
