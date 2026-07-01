import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import { castToType } from "@/utils/types";
import { useEffect, useRef, useState } from "react";
import VectorDBIdentifier from "./VectorDBIdentifier";
import MaxContextSnippets from "./MaxContextSnippets";
import DocumentSimilarityThreshold from "./DocumentSimilarityThreshold";
import ResetDatabase from "./ResetDatabase";
import VectorCount from "./VectorCount";
import VectorSearchMode from "./VectorSearchMode";
import CTAButton from "@/components/lib/CTAButton";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";

export default function VectorDatabase({ workspace }) {
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vectorDB, setVectorDB] = useState(workspace?.vectorDB || null);
  const formEl = useRef(null);
  const loadVectorSettings = useSettingsSection("vector");

  useEffect(() => {
    const controller = new AbortController();
    async function loadVectorDB() {
      const settings = await loadVectorSettings({
        priority: "P2",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setVectorDB(settings?.VectorDB || workspace?.vectorDB || null);
    }
    loadVectorDB().catch((error) => {
      if (error?.name !== "AbortError") console.error(error);
    });
    return () => controller.abort();
  }, [loadVectorSettings, workspace?.vectorDB]);

  const handleUpdate = async (e) => {
    setSaving(true);
    e.preventDefault();
    const data = {};
    const form = new FormData(formEl.current);
    for (var [key, value] of form.entries()) data[key] = castToType(key, value);
    const { workspace: updatedWorkspace, message } = await Workspace.update(
      workspace.slug,
      data
    );
    if (!!updatedWorkspace) {
      showToast("Workspace updated!", "success", { clear: true });
    } else {
      showToast(`Error: ${message}`, "error", { clear: true });
    }
    setSaving(false);
    setHasChanges(false);
  };

  if (!workspace) return null;
  const effectiveWorkspace = { ...workspace, vectorDB };
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
        <div className="flex items-start gap-x-5">
          <VectorDBIdentifier workspace={effectiveWorkspace} />
          <VectorCount reload={true} workspace={workspace} />
        </div>
        <VectorSearchMode
          workspace={effectiveWorkspace}
          setHasChanges={setHasChanges}
        />
        <MaxContextSnippets
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        <DocumentSimilarityThreshold
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        <ResetDatabase workspace={workspace} />
      </form>
    </div>
  );
}
