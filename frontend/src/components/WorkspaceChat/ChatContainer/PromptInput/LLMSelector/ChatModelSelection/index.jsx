import useGetProviderModels, {
  DISABLED_PROVIDERS,
} from "@/hooks/useGetProvidersModels";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

export default function ChatModelSelection({
  provider,
  workspaceSlug = null,
  setHasChanges,
  selectedLLMModel,
  setSelectedLLMModel,
  modelCapabilities = null,
  priority = "P1",
}) {
  const { t } = useTranslation();
  const modelTaskOptions = useMemo(
    () => ({
      communicationScene: "llm-model-selector-visible",
      scope: {
        workspaceSlug: workspaceSlug || undefined,
      },
      task: {
        label: `llm-selector:models:${provider || "unknown"}`,
        kind: "settings",
        priority,
        policy: priority === "P0" ? "foreground" : "visible",
        intentRank: 1,
        scope: {
          route: "workspace-chat",
          surface: "llm-selector",
          workspaceSlug: workspaceSlug || undefined,
          provider: provider || undefined,
        },
      },
    }),
    [priority, provider, workspaceSlug]
  );
  const { defaultModels, customModels, loading } = useGetProviderModels(
    provider,
    modelTaskOptions
  );
  const responsesModels = ["deepseek-v4-flash", "deepseek-v4-pro"];
  const flashVisionReady =
    modelCapabilities?.modelRoutes?.["deepseek-v4-flash"]?.ready === true;
  const visibleDefaultModels = defaultModels.filter((model) =>
    responsesModels.includes(model)
  );
  const visibleCustomModels = Array.isArray(customModels)
    ? customModels.filter((model) => responsesModels.includes(model.id))
    : {};
  if (DISABLED_PROVIDERS.includes(provider)) return null;

  if (loading) {
    return (
      <select
        required={true}
        disabled={true}
        className="bg-zinc-900 light:bg-white text-white light:text-slate-900 text-sm rounded-lg h-8 w-full px-2.5 outline-none border border-zinc-900 light:border-slate-400 cursor-not-allowed"
      >
        <option disabled={true} selected={true}>
          -- waiting for models --
        </option>
      </select>
    );
  }

  return (
    <select
      id="workspace-llm-model-select"
      required={true}
      value={selectedLLMModel}
      onChange={(e) => {
        setHasChanges(true);
        setSelectedLLMModel(e.target.value);
      }}
      className="bg-zinc-900 light:bg-white text-white light:text-slate-900 text-sm rounded-lg h-8 w-full px-2.5 outline-none border border-zinc-900 light:border-slate-400 cursor-pointer"
    >
      {visibleDefaultModels.length > 0 && (
        <optgroup label="General models">
          {visibleDefaultModels.map((model) => {
            return (
              <option
                key={model}
                value={model}
                selected={selectedLLMModel === model}
                disabled={model === "deepseek-v4-flash" && !flashVisionReady}
              >
                {model}
                {model === "deepseek-v4-flash" && !flashVisionReady
                  ? ` (${t("chat_window.controls.composerMenu.visionUnavailableShort")})`
                  : ""}
              </option>
            );
          })}
        </optgroup>
      )}
      {Array.isArray(visibleCustomModels) && visibleCustomModels.length > 0 && (
        <optgroup label="Discovered models">
          {visibleCustomModels.map((model) => {
            return (
              <option
                key={model.id}
                value={model.id}
                selected={selectedLLMModel === model.id}
                disabled={model.id === "deepseek-v4-flash" && !flashVisionReady}
              >
                {model.name || model.id}
                {model.id === "deepseek-v4-flash" && !flashVisionReady
                  ? ` (${t("chat_window.controls.composerMenu.visionUnavailableShort")})`
                  : ""}
              </option>
            );
          })}
        </optgroup>
      )}
      {/* For providers like TogetherAi where we partition model by creator entity. */}
      {!Array.isArray(visibleCustomModels) &&
        Object.keys(visibleCustomModels).length > 0 && (
          <>
            {Object.entries(visibleCustomModels).map(
              ([organization, models]) => (
                <optgroup key={organization} label={organization}>
                  {models.map((model) => (
                    <option
                      key={model.id}
                      value={model.id}
                      selected={selectedLLMModel === model.id}
                      disabled={
                        model.id === "deepseek-v4-flash" && !flashVisionReady
                      }
                    >
                      {model.name}
                      {model.id === "deepseek-v4-flash" && !flashVisionReady
                        ? ` (${t("chat_window.controls.composerMenu.visionUnavailableShort")})`
                        : ""}
                    </option>
                  ))}
                </optgroup>
              )
            )}
          </>
        )}
    </select>
  );
}
