export const WORKSPACES_REFRESH_EVENT = "anythingllm-workspaces-refresh";

export function dispatchWorkspacesRefresh(workspace = null) {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent(WORKSPACES_REFRESH_EVENT, {
      detail: { workspace },
    })
  );
}
