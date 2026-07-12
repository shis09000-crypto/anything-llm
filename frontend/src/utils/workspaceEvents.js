import { guardGlobalRefresh } from "@/utils/globalRefreshPolicy";

export const WORKSPACES_REFRESH_EVENT = "anythingllm-workspaces-refresh";
export const WORKSPACE_CREATE_VISUAL_EVENT =
  "anythingllm-workspace-create-visual";
export const WORKSPACE_PATCH_VISUAL_EVENT =
  "anythingllm-workspace-patch-visual";
export const WORKSPACE_DELETE_VISUAL_EVENT =
  "anythingllm-workspace-delete-visual";
export const WORKSPACES_RESTORE_VISUAL_EVENT =
  "anythingllm-workspaces-restore-visual";
export const THREAD_CREATE_VISUAL_EVENT = "anythingllm-thread-create-visual";
export const THREAD_PATCH_VISUAL_EVENT = "anythingllm-thread-patch-visual";
export const THREAD_MOVE_VISUAL_EVENT = "anythingllm-thread-move-visual";
export const THREAD_DELETE_VISUAL_EVENT = "anythingllm-thread-delete-visual";
export const WORKSPACE_CREATE_ANIMATION_MS = 260;
export const WORKSPACE_DELETE_ANIMATION_MS = 260;
export const THREAD_CREATE_ANIMATION_MS = 220;
export const THREAD_DELETE_ANIMATION_MS = 220;

export function dispatchWorkspacesRefresh(workspace = null, detail = {}) {
  if (typeof window === "undefined") return;
  const guard = guardGlobalRefresh({
    detail,
    path: WORKSPACES_REFRESH_EVENT,
    source: "workspace-events",
  });
  if (!guard.allowed) return guard;

  window.dispatchEvent(
    new CustomEvent(WORKSPACES_REFRESH_EVENT, {
      detail: { workspace, ...guard.detail },
    })
  );
  return guard;
}

export function dispatchWorkspaceCreateVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!detail?.workspace?.slug && !detail?.workspaceSlug) return;

  window.dispatchEvent(
    new CustomEvent(WORKSPACE_CREATE_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchWorkspacePatchVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!detail?.workspace?.slug && !detail?.workspaceSlug) return;

  window.dispatchEvent(
    new CustomEvent(WORKSPACE_PATCH_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchWorkspaceDeleteVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!detail?.workspaceSlug) return;

  window.dispatchEvent(
    new CustomEvent(WORKSPACE_DELETE_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchWorkspacesRestoreVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!Array.isArray(detail?.workspaces)) return;

  window.dispatchEvent(
    new CustomEvent(WORKSPACES_RESTORE_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchThreadCreateVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!detail?.workspaceSlug || !detail?.thread?.slug) return;

  window.dispatchEvent(
    new CustomEvent(THREAD_CREATE_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchThreadPatchVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!detail?.workspaceSlug || (!detail?.thread?.slug && !detail?.threadSlug))
    return;

  window.dispatchEvent(
    new CustomEvent(THREAD_PATCH_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchThreadMoveVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (
    !detail?.threadSlug ||
    (!detail?.sourceWorkspaceSlug && !detail?.targetWorkspaceSlug)
  )
    return;

  window.dispatchEvent(
    new CustomEvent(THREAD_MOVE_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}

export function dispatchThreadDeleteVisual(detail = {}) {
  if (typeof window === "undefined") return;
  if (!detail?.workspaceSlug || !detail?.threadSlug) return;

  window.dispatchEvent(
    new CustomEvent(THREAD_DELETE_VISUAL_EVENT, {
      detail: { skipGlobalRefresh: true, ...detail },
    })
  );
}
