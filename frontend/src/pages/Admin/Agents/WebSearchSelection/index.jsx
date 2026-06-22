import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ListMagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import Toggle from "@/components/lib/Toggle";
import System from "@/models/system";
import showToast from "@/utils/toast";
import paths from "@/utils/paths";
import WebSearchImage from "@/media/agents/scrape-websites.png";

function searchModelStatus(settings = {}) {
  const provider = settings?.SearchModelProvider || "none";
  const configured =
    provider === "alibaba" &&
    settings?.SearchModelApiKey === true &&
    Boolean(settings?.SearchModelBaseUrl) &&
    Boolean(settings?.SearchModelPref);

  return {
    configured,
    provider,
    model: settings?.SearchModelPref || "qwen3.7-plus",
    baseUrl:
      settings?.SearchModelBaseUrl ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reason:
      provider === "none"
        ? "Search Model is set to None."
        : "Search Model is missing its API Key, Base URL, or model.",
  };
}

export default function AgentWebSearchSelection({
  skill,
  title,
  description,
  settings,
  toggleSkill,
  enabled = false,
}) {
  const [checking, setChecking] = useState(false);
  const status = useMemo(() => searchModelStatus(settings), [settings]);
  const effectiveEnabled = enabled && status.configured;

  async function handleToggle() {
    if (effectiveEnabled) {
      toggleSkill(skill);
      return;
    }

    setChecking(true);
    const latestSettings = await System.keys();
    setChecking(false);
    const latestStatus = searchModelStatus(latestSettings);

    if (!latestStatus.configured) {
      showToast(
        "请先在“搜索模型”中配置阿里 DashScope API Key、Base URL 和模型，再开启实时网络搜索和浏览。",
        "error",
        { clear: true }
      );
      return;
    }

    toggleSkill(skill);
  }

  return (
    <div className="p-2">
      <div className="flex max-w-[500px] flex-col gap-y-[18px]">
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-x-2">
            <ListMagnifyingGlass
              size={24}
              color="var(--theme-text-primary)"
              weight="bold"
            />
            <label className="text-theme-text-primary text-md font-bold">
              {title}
            </label>
          </div>
          <Toggle
            size="lg"
            enabled={effectiveEnabled}
            onChange={handleToggle}
            disabled={checking}
          />
        </div>
        <img
          src={WebSearchImage}
          alt="Web Search"
          className="w-full rounded-md"
        />
        <p className="py-1.5 text-xs font-medium text-theme-text-secondary text-opacity-60">
          {description}
        </p>

        <div className="max-w-[640px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 light:border-theme-sidebar-border">
          <div className="flex items-start gap-x-3">
            <WarningCircle
              size={22}
              weight="bold"
              className={
                status.configured ? "text-green-400" : "text-yellow-400"
              }
            />
            <div className="flex flex-col gap-y-2">
              <div className="text-sm font-semibold text-white light:text-theme-text-primary">
                {status.configured
                  ? "Search Model ready"
                  : "Search Model required"}
              </div>
              <p className="text-xs leading-5 text-description light:text-theme-text-secondary">
                实时网络搜索和浏览现在通过搜索模型执行。模型会接收工具给出的搜索词，使用联网搜索能力检索结果，再把整理后的结果返回给主模型。
              </p>
              <div className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-xs text-description light:text-theme-text-secondary">
                <span>Provider</span>
                <span>{status.provider}</span>
                <span>Model</span>
                <span>{status.model}</span>
                <span>Base URL</span>
                <span className="break-all">{status.baseUrl}</span>
              </div>
              {!status.configured && (
                <p className="text-xs leading-5 text-yellow-300">
                  {status.reason}
                </p>
              )}
              <Link
                to={paths.settings.searchModelPreference()}
                className="w-fit rounded-lg bg-primary-button px-3 py-2 text-xs font-semibold text-white hover:bg-secondary"
              >
                配置搜索模型
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
