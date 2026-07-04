import Workspace from "@/models/workspace";
import { castToType } from "@/utils/types";
import showToast from "@/utils/toast";
import { useEffect, useRef, useState } from "react";
import WorkspaceName from "./WorkspaceName";
import SuggestedChatMessages from "./SuggestedChatMessages";
import DeleteWorkspace from "./DeleteWorkspace";
import CTAButton from "@/components/lib/CTAButton";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function GeneralInfo({
  slug,
  workspace: initialWorkspace = null,
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!initialWorkspace);
  const formEl = useRef(null);

  useEffect(() => {
    if (!initialWorkspace?.slug || initialWorkspace.slug !== slug) return;
    setWorkspace(initialWorkspace);
    setLoading(false);
  }, [initialWorkspace, slug]);

  useEffect(() => {
    if (initialWorkspace?.slug === slug) return;
    const controller = new AbortController();
    async function fetchWorkspace() {
      const workspace = await Workspace.bySlug(slug, {
        signal: controller.signal,
        communicationScene: "settings-tab",
      });
      if (controller.signal.aborted) return;
      setWorkspace(workspace);
      setLoading(false);
    }
    fetchWorkspace().catch((error) => {
      if (error?.name !== "AbortError") console.error(error);
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [initialWorkspace, slug]);

  const handleUpdate = async (e) => {
    setSaving(true);
    e.preventDefault();
    const data = {};
    const form = new FormData(formEl.current);
    for (var [key, value] of form.entries()) data[key] = castToType(key, value);
    const previousWorkspace = workspace;
    const action = optimisticActionCenter.run({
      type: "workspace.settings.save",
      scope: {
        route: "workspace-settings",
        surface: "general-appearance",
        workspaceSlug: workspace.slug,
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:workspace-settings-save",
      optimisticPatch: () => setWorkspace({ ...workspace, ...data }),
      rollbackPatch: () => setWorkspace(previousWorkspace),
      confirmPatch: ({ result }) => {
        if (result?.workspace) setWorkspace(result.workspace);
      },
      serverCall: async ({ signal }) => {
        const result = await Workspace.update(workspace.slug, data, {
          signal,
          task: false,
        });
        if (!result?.workspace) throw new Error(result?.message || "保存失败");
        return result;
      },
    });
    const outcome = await action.promise;
    if (outcome.ok) {
      showToast("Workspace updated!", "success", { clear: true });
    } else {
      showToast(`Error: ${outcome.error?.message}`, "error", { clear: true });
    }
    setSaving(false);
    setHasChanges(false);
  };

  if (!workspace || loading) {
    return (
      <div className="w-full max-w-3xl space-y-4">
        <div className="motion-skeleton h-8 w-64 rounded-md" />
        <div className="motion-skeleton h-28 w-full rounded-md" />
        <div className="motion-skeleton h-40 w-full rounded-md" />
      </div>
    );
  }
  return (
    <div className="w-full relative">
      <form
        ref={formEl}
        onSubmit={handleUpdate}
        className="w-1/2 flex flex-col gap-y-6"
      >
        {hasChanges && (
          <div className="absolute top-0 right-0">
            <CTAButton type="submit">
              {saving ? "Updating..." : "Update Workspace"}
            </CTAButton>
          </div>
        )}
        <WorkspaceName
          key={workspace.slug}
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
      </form>
      <SuggestedChatMessages slug={workspace.slug} />
      <DeleteWorkspace workspace={workspace} />
    </div>
  );
}
