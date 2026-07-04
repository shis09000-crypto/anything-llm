import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import { castToType } from "@/utils/types";
import { useEffect, useRef, useState } from "react";
import ChatHistorySettings from "./ChatHistorySettings";
import ChatPromptSettings from "./ChatPromptSettings";
import ChatTemperatureSettings from "./ChatTemperatureSettings";
import ChatModeSelection from "./ChatModeSelection";
import WorkspaceLLMSelection from "./WorkspaceLLMSelection";
import ChatQueryRefusalResponse from "./ChatQueryRefusalResponse";
import CTAButton from "@/components/lib/CTAButton";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function ChatSettings({ workspace }) {
  const [settings, setSettings] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadLlmSettings = useSettingsSection("llm");

  const formEl = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    async function fetchSettings() {
      const _settings = await loadLlmSettings({
        priority: "P1",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSettings(_settings ?? {});
    }
    fetchSettings().catch((error) => {
      if (error?.name !== "AbortError") console.error(error);
    });
    return () => controller.abort();
  }, [loadLlmSettings]);

  const handleUpdate = async (e) => {
    e.preventDefault();
    setSaving(true);
    const data = {};
    const form = new FormData(formEl.current);
    for (var [key, value] of form.entries()) data[key] = castToType(key, value);

    const action = optimisticActionCenter.run({
      type: "workspace.settings.chat.save",
      scope: {
        route: "workspace-settings",
        surface: "chat-settings",
        workspaceSlug: workspace.slug,
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:workspace-chat-settings-save",
      optimisticPatch: () => setHasChanges(false),
      rollbackPatch: () => setHasChanges(true),
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
      // Keep hasChanges true on error so user can retry
    }
    setSaving(false);
  };

  if (!workspace) return null;
  return (
    <div id="workspace-chat-settings-container" className="relative">
      <form
        ref={formEl}
        onSubmit={handleUpdate}
        id="chat-settings-form"
        className="w-1/2 flex flex-col gap-y-6"
      >
        {hasChanges && (
          <div className="absolute top-0 right-0">
            <CTAButton type="submit">
              {saving ? "Updating..." : "Update Workspace"}
            </CTAButton>
          </div>
        )}
        <WorkspaceLLMSelection
          settings={settings}
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        <ChatModeSelection
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        <ChatHistorySettings
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        <ChatPromptSettings
          workspace={workspace}
          setHasChanges={setHasChanges}
          hasChanges={hasChanges}
        />
        <ChatQueryRefusalResponse
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        <ChatTemperatureSettings
          settings={settings}
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
      </form>
    </div>
  );
}
