import { deleteJson, getJson } from "@/lib/communication/apiClient";

const WorkspaceThreadGoal = {
  async active(workspaceSlug, threadSlug) {
    if (!workspaceSlug || !threadSlug) return null;
    const { data } = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/goal`,
      { communicationScene: "workspace-chat", task: false }
    );
    return data?.goal || null;
  },

  async abandon(workspaceSlug, threadSlug, goalId) {
    if (!workspaceSlug || !threadSlug || !goalId) return false;
    const { data } = await deleteJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/goal/${encodeURIComponent(goalId)}`,
      { communicationScene: "workspace-chat", task: false }
    );
    return data?.success === true;
  },
};

export default WorkspaceThreadGoal;
