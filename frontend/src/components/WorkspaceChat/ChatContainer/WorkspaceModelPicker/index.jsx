import { useRef, useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useUser from "@/hooks/useUser";
import { useModal } from "@/hooks/useModal";
import LLMSelectorModal from "../PromptInput/LLMSelector/index";
import SetupProvider from "../PromptInput/LLMSelector/SetupProvider";
import {
  SAVE_LLM_SELECTOR_EVENT,
  PROVIDER_SETUP_EVENT,
} from "../PromptInput/LLMSelector/action";
import Workspace from "@/models/workspace";
import System from "@/models/system";
import { SIDEBAR_TOGGLE_EVENT } from "@/components/Sidebar/SidebarToggle";
import { canSeeAdmin } from "@/utils/authz";
import { mobileShellRuntimeActive } from "@/utils/mobileRuntime";
import {
  CHAT_SECONDARY_PRELOAD_EVENT,
  chatSecondaryTask,
} from "@/utils/chat/chatSecondaryPreload";

function fetchModelName(slug, setModelName, options = {}) {
  if (!slug) return Promise.resolve(null);
  return Workspace.bySlug(slug, options).then((workspace) => {
    setModelName(workspace?.chatModel || "");
    return workspace;
  });
}

function markModelLabelVisible() {
  if (typeof performance === "undefined") return;
  performance.mark?.("athena:model_label_visible");
}

export default function WorkspaceModelPicker({
  workspaceSlug = null,
  modelName: initialModelName = "",
}) {
  const { t } = useTranslation();
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { user } = useUser();
  const [showSelector, setShowSelector] = useState(false);
  const [modelName, setModelName] = useState(initialModelName || "");
  const {
    isOpen: isSetupProviderOpen,
    openModal: openSetupProviderModal,
    closeModal: closeSetupProviderModal,
  } = useModal();
  const [config, setConfig] = useState({ settings: {}, provider: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const modelLabelMarkedRef = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem("anythingllm_sidebar_toggle") !== "closed"
  );
  const isMobileShell = mobileShellRuntimeActive();
  const canUseModelPicker = !!user && canSeeAdmin(user);

  useEffect(() => {
    const handleToggle = (e) => setSidebarOpen(e.detail.open);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
  }, []);

  // Use the workspace payload already loaded for chat first paint. Only fetch
  // when embedded elsewhere without a model value.
  useEffect(() => {
    if (initialModelName) {
      setModelName(initialModelName);
      return;
    }
    fetchModelName(slug, setModelName);
  }, [slug, initialModelName]);

  useEffect(() => {
    if (!modelName || modelLabelMarkedRef.current) return;
    modelLabelMarkedRef.current = true;
    markModelLabelVisible();
  }, [modelName]);

  useEffect(() => {
    if (!slug || isMobileShell || !canUseModelPicker) return;
    let active = true;
    const controller = new AbortController();

    async function preloadModelChrome(event) {
      const detail = event?.detail || {};
      if (detail.workspaceSlug && detail.workspaceSlug !== slug) return;
      const scope = {
        workspaceSlug: slug,
        threadSlug: detail.threadSlug || undefined,
        surface: "llm-selector",
      };

      try {
        const [workspace, settingsResponse] = await Promise.all([
          Workspace.bySlug(slug, {
            signal: controller.signal,
            communicationScene: "llm-model-chrome-preload",
            task: chatSecondaryTask("llm-selector:model-chrome-workspace", {
              ...scope,
              surface: "llm-selector-workspace",
            }),
          }),
          System.settingsBootstrap({
            sections: ["llm"],
            signal: controller.signal,
            communicationScene: "llm-model-chrome-preload",
            task: chatSecondaryTask("llm-selector:model-chrome-settings", {
              ...scope,
              surface: "llm-selector-settings",
            }),
          }),
        ]);
        if (!active || controller.signal.aborted) return;

        const settings = settingsResponse?.settings || {};
        const resolvedModel = workspace?.chatModel || settings.LLMModel || "";
        if (resolvedModel) {
          setModelName(resolvedModel);
          markModelLabelVisible();
        }

        const provider = workspace?.chatProvider || settings.LLMProvider;
        if (provider) {
          void System.customModels(provider, null, null, null, {
            signal: controller.signal,
            cache: true,
            communicationScene: "llm-model-chrome-preload",
            task: chatSecondaryTask("llm-selector:model-chrome-preload", {
              ...scope,
              provider,
            }),
          }).catch((error) => {
            if (error?.name !== "AbortError") console.error(error);
          });
        }
      } catch (error) {
        if (error?.name !== "AbortError" && active) console.error(error);
      }
    }

    window.addEventListener(CHAT_SECONDARY_PRELOAD_EVENT, preloadModelChrome);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener(
        CHAT_SECONDARY_PRELOAD_EVENT,
        preloadModelChrome
      );
    };
  }, [slug, isMobileShell, canUseModelPicker]);

  // Close selector and refresh model name when model is saved
  useEffect(() => {
    function handleSave() {
      setShowSelector(false);
      fetchModelName(slug, setModelName);
    }
    window.addEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
    return () =>
      window.removeEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
  }, [slug]);

  // Handle provider setup request
  useEffect(() => {
    function handleProviderSetup(e) {
      const { provider, settings } = e.detail;
      setConfig({ settings, provider });
      setTimeout(() => openSetupProviderModal(), 300);
    }
    window.addEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
    return () =>
      window.removeEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
  }, []);

  // This feature is disabled for multi-user instances where the user is not an admin
  if (!!user && !canUseModelPicker) return null;
  if (!slug || isMobileShell) return null;

  return (
    <>
      {showSelector && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setShowSelector(false)}
        />
      )}
      <div
        className={`hidden md:block absolute top-2 z-30 motion-hover ${
          sidebarOpen ? "left-3" : "left-11"
        }`}
      >
        <button
          type="button"
          onClick={() => setShowSelector(!showSelector)}
          className={`liquid-glass-control liquid-glass-subtle group cursor-pointer px-3 py-1.5 flex items-center rounded-full ${
            showSelector ? "liquid-glass-active" : ""
          }`}
        >
          <span
            className={`text-xs font-medium ${
              showSelector
                ? "text-sky-100 light:text-sky-700"
                : "liquid-glass-muted group-hover:text-white light:group-hover:text-slate-900"
            }`}
          >
            {modelName || t("chat_window.select_model")}
          </span>
        </button>

        {showSelector && (
          <div className="absolute left-0 top-full mt-1 bg-zinc-800 light:bg-white border border-zinc-700 light:border-slate-300 rounded-xl shadow-lg w-[620px] overflow-hidden">
            <LLMSelectorModal
              key={refreshKey}
              workspaceSlug={slug}
              initialProvider={config.provider?.value}
            />
          </div>
        )}
      </div>

      <SetupProvider
        isOpen={isSetupProviderOpen}
        closeModal={closeSetupProviderModal}
        postSubmit={() => {
          closeSetupProviderModal();
          setRefreshKey((k) => k + 1);
        }}
        settings={config.settings}
        llmProvider={config.provider}
      />
    </>
  );
}
