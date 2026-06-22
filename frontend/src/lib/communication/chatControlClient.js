import { requestJson } from "./apiClient";

export async function respondToChatToolApproval({
  workspaceSlug,
  requestId,
  approved,
  signal,
} = {}) {
  if (!workspaceSlug || !requestId) {
    return {
      success: false,
      error: "Missing workspace slug or approval request id.",
    };
  }

  try {
    const { data } = await requestJson(
      `/workspace/${workspaceSlug}/tool-approval`,
      {
        method: "POST",
        body: { requestId, approved: !!approved },
        signal,
      }
    );
    return data || { success: false, error: "Empty approval response." };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return {
      success: false,
      error: error?.message || "Tool approval request failed.",
      apiError: error,
    };
  }
}
