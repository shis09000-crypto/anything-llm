import { deleteJson, getJson } from "@/lib/communication/apiClient";

const WorkspaceThreadPlan = {
  async active(workspaceSlug, threadSlug) {
    if (!workspaceSlug || !threadSlug) return null;
    const { data } = await getJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/plan`,
      { communicationScene: "workspace-chat", task: false }
    );
    return data?.plan || null;
  },

  async abandon(workspaceSlug, threadSlug, planId) {
    if (!workspaceSlug || !threadSlug || !planId) return false;
    const { data } = await deleteJson(
      `/workspace/${workspaceSlug}/thread/${threadSlug}/plan/${encodeURIComponent(planId)}`,
      { communicationScene: "workspace-chat", task: false }
    );
    return data?.success === true;
  },
};

export default WorkspaceThreadPlan;
