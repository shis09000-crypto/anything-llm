import System from "@/models/system";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import { castToType } from "@/utils/types";
import { useEffect, useRef, useState } from "react";
import AgentLLMSelection from "./AgentLLMSelection";
import Admin from "@/models/admin";
import * as Skeleton from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import paths from "@/utils/paths";
import useUser from "@/hooks/useUser";
import { Link } from "react-router-dom";
import { canSeeAdmin } from "@/utils/authz";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function WorkspaceAgentConfiguration({ workspace }) {
  const { user } = useUser();
  const [settings, setSettings] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const formEl = useRef(null);
  const loadLlmSettings = useSettingsSection("llm");

  useEffect(() => {
    const controller = new AbortController();
    async function fetchSettings() {
      const _settings = await loadLlmSettings({
        priority: "P1",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSettings(_settings ?? {});
      setLoading(false);
    }
    fetchSettings().catch((error) => {
      if (error?.name !== "AbortError") console.error(error);
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [loadLlmSettings]);

  const handleUpdate = async (e) => {
    setSaving(true);
    e.preventDefault();
    const data = {
      workspace: {},
      system: {},
      env: {},
    };

    const form = new FormData(formEl.current);
    for (var [key, value] of form.entries()) {
      if (key.startsWith("system::")) {
        const [_, label] = key.split("system::");
        data.system[label] = String(value);
        continue;
      }

      if (key.startsWith("env::")) {
        const [_, label] = key.split("env::");
        data.env[label] = String(value);
        continue;
      }

      data.workspace[key] = castToType(key, value);
    }

    const action = optimisticActionCenter.run({
      type: "workspace.settings.agent.save",
      scope: {
        route: "workspace-settings",
        surface: "agent-config",
        workspaceSlug: workspace.slug,
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:workspace-agent-settings-save",
      optimisticPatch: () => setHasChanges(false),
      rollbackPatch: () => setHasChanges(true),
      serverCall: async ({ signal }) => {
        const workspaceResult = await Workspace.update(
          workspace.slug,
          data.workspace,
          {
            signal,
            task: false,
          }
        );
        if (!workspaceResult?.workspace)
          throw new Error(workspaceResult?.message || "保存失败");
        const systemResult = await Admin.updateSystemPreferences(data.system, {
          signal,
          task: false,
        });
        if (!systemResult?.success)
          throw new Error(systemResult?.error || "系统偏好保存失败");
        const envResult = await System.updateSystem(data.env, {
          signal,
          task: false,
        });
        if (envResult?.error) throw new Error(envResult.error);
        return { workspace: workspaceResult.workspace };
      },
    });
    const outcome = await action.promise;
    if (outcome.ok) {
      showToast("Workspace updated!", "success", { clear: true });
    } else {
      showToast(`Error: ${outcome.error?.message}`, "error", { clear: true });
    }

    setSaving(false);
  };

  if (!workspace || loading) return <LoadingSkeleton />;
  return (
    <div id="workspace-agent-settings-container">
      <form
        ref={formEl}
        onSubmit={handleUpdate}
        onChange={() => setHasChanges(true)}
        id="agent-settings-form"
        className="w-1/2 flex flex-col gap-y-6"
      >
        <AgentLLMSelection
          settings={settings}
          workspace={workspace}
          setHasChanges={setHasChanges}
        />
        {(!user || canSeeAdmin(user)) && (
          <>
            {!hasChanges && (
              <div className="flex flex-col gap-y-4">
                <Link
                  className="w-fit motion-hover border border-slate-200 px-5 py-2.5 rounded-lg text-white text-sm items-center flex gap-x-2 hover:bg-slate-200 hover:text-slate-800 focus:ring-gray-800"
                  to={paths.settings.agentSkills()}
                >
                  Configure Agent Skills
                </Link>
                <p className="text-white text-opacity-60 text-xs font-medium">
                  Customize and enhance the default agent's capabilities by
                  enabling or disabling specific skills. These settings will be
                  applied across all workspaces.
                </p>
              </div>
            )}
          </>
        )}

        {hasChanges && (
          <button
            type="submit"
            form="agent-settings-form"
            className="w-fit motion-hover border border-slate-200 px-5 py-2.5 rounded-lg text-white text-sm items-center flex gap-x-2 hover:bg-slate-200 hover:text-slate-800 focus:ring-gray-800"
          >
            {saving ? "Updating agent..." : "Update workspace agent"}
          </button>
        )}
      </form>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div id="workspace-agent-settings-container">
      <div className="w-1/2 flex flex-col gap-y-6">
        <Skeleton.default
          height={100}
          width="100%"
          count={2}
          highlightColor="var(--theme-bg-primary)"
          baseColor="var(--theme-bg-secondary)"
          enableAnimation={true}
          containerClassName="flex flex-col gap-y-1"
        />
        <div className="bg-white/10 h-[1px] w-full" />
        <Skeleton.default
          height={100}
          width="100%"
          count={2}
          highlightColor="var(--theme-bg-primary)"
          baseColor="var(--theme-bg-secondary)"
          enableAnimation={true}
          containerClassName="flex flex-col gap-y-1 mt-4"
        />
      </div>
    </div>
  );
}
