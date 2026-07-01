import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import System from "@/models/system";
import showToast from "@/utils/toast";
import GenericOpenAiLogo from "@/media/llmprovider/generic-openai.png";
import AthenaIcon from "@/media/logo/athena-mark.svg";
import { CaretUpDown } from "@phosphor-icons/react";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import {
  SoftButton,
  SoftCard,
  SoftProviderDropdown,
  SoftProviderTrigger,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

const DEFAULT_ALIBABA_RERANK_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-api/v1/reranks";
const DEFAULT_ALIBABA_RERANK_MODEL = "qwen3-rerank";

function rerankProviders(t) {
  return [
    {
      name: t("rerank.providers.native.name"),
      value: "native",
      logo: AthenaIcon,
      description: t("rerank.providers.native.description"),
    },
    {
      name: t("rerank.providers.alibaba.name"),
      value: "alibaba",
      logo: GenericOpenAiLogo,
      description: t("rerank.providers.alibaba.description"),
    },
  ];
}

export default function GeneralRerankPreference() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState("native");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const { t } = useTranslation();
  const providers = rerankProviders(t);
  const loadSettingsSection = useSettingsSection("rerank");

  const refreshSettings = useCallback(async () => {
    const _settings = await loadSettingsSection();
    setSettings(_settings);
    setSelectedProvider(_settings?.RerankProvider || "native");
    setHasChanges(false);
    setLoading(false);
  }, [loadSettingsSection]);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);

    const formData = new FormData(event.target);
    const data = { RerankProvider: selectedProvider };
    for (const [key, value] of formData.entries()) data[key] = value;

    const { error } = await System.updateSystem(data);
    if (error) {
      showToast(`重排模型设置保存失败：${error}`, "error");
      setHasChanges(true);
    } else {
      showToast("重排模型设置已保存。", "success");
      setHasChanges(false);
      await refreshSettings();
    }
    setSaving(false);
  };

  const selectedProviderObject =
    providers.find((provider) => provider.value === selectedProvider) ||
    providers[0];

  const updateProviderChoice = (provider) => {
    setSelectedProvider(provider);
    setProviderMenuOpen(false);
    setHasChanges(true);
  };

  return (
    <SoftSettingsLayout
      title={t("rerank.title")}
      description={t("rerank.description")}
      actions={
        hasChanges && (
          <SoftButton type="submit" form="rerank-settings-form">
            {saving ? t("rerank.saving") : t("rerank.save")}
          </SoftButton>
        )
      }
    >
      {loading ? (
        <SoftCard>
          <div className="flex w-full max-w-[720px] flex-col gap-y-4">
            <div className="motion-skeleton h-16 rounded-2xl" />
            <div className="motion-skeleton h-28 rounded-2xl" />
            <div className="motion-skeleton h-10 w-2/3 rounded-2xl" />
          </div>
        </SoftCard>
      ) : (
        <form
          id="rerank-settings-form"
          onSubmit={handleSubmit}
          className="settings-soft-form"
        >
          <SoftCard title={t("rerank.provider")}>
            <div className="settings-soft-provider-picker">
              <SoftProviderTrigger
                logo={selectedProviderObject.logo}
                name={selectedProviderObject.name}
                description={selectedProviderObject.description}
                onClick={() => setProviderMenuOpen((open) => !open)}
              >
                <CaretUpDown
                  size={24}
                  weight="bold"
                  className="text-[var(--soft-text-muted)]"
                />
              </SoftProviderTrigger>
              <SoftProviderDropdown open={providerMenuOpen}>
                <div className="settings-soft-provider-list white-scrollbar">
                  {providers.map((provider) => (
                    <button
                      key={provider.value}
                      type="button"
                      onClick={() => updateProviderChoice(provider.value)}
                      className={`settings-soft-provider-option text-left ${
                        selectedProvider === provider.value ? "is-selected" : ""
                      }`}
                    >
                      <div className="settings-soft-provider-copy">
                        <span className="settings-soft-provider-logo-wrap">
                          <img
                            src={provider.logo}
                            alt={`${provider.name} logo`}
                            className="settings-soft-provider-logo"
                          />
                        </span>
                        <div className="min-w-0 flex flex-col">
                          <div className="settings-soft-provider-name">
                            {provider.name}
                          </div>
                          <div className="settings-soft-provider-description">
                            {provider.description}
                          </div>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </SoftProviderDropdown>
              <p className="mt-3 text-xs font-medium leading-5 text-[var(--soft-text-secondary)]">
                {t("rerank.providerHint")}
              </p>
            </div>

            <div
              onChange={() => setHasChanges(true)}
              className="mt-6 flex flex-col gap-y-7"
            >
              {selectedProvider === "alibaba" ? (
                <AlibabaRerankOptions settings={settings} />
              ) : (
                <NativeRerankOptions />
              )}
            </div>
          </SoftCard>
        </form>
      )}
    </SoftSettingsLayout>
  );
}

function NativeRerankOptions() {
  const { t } = useTranslation();
  return (
    <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
      {t("rerank.nativeHelp")}
    </div>
  );
}

function AlibabaRerankOptions({ settings }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex flex-wrap gap-[36px]">
        <div className="flex w-60 flex-col">
          <label className="mb-3 block text-sm font-semibold text-white light:text-theme-text-primary">
            API Key
          </label>
          <input
            type="password"
            name="RerankApiKey"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder="DashScope API Key"
            defaultValue={settings?.RerankApiKey ? "*".repeat(20) : ""}
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex w-[380px] max-w-full flex-col">
          <label className="mb-3 block text-sm font-semibold text-white light:text-theme-text-primary">
            Base URL
          </label>
          <input
            type="url"
            name="RerankBaseUrl"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder={DEFAULT_ALIBABA_RERANK_BASE_URL}
            defaultValue={
              settings?.RerankBaseUrl || DEFAULT_ALIBABA_RERANK_BASE_URL
            }
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex w-60 flex-col">
          <label className="mb-3 block text-sm font-semibold text-white light:text-theme-text-primary">
            {t("rerank.model")}
          </label>
          <select
            name="RerankModelPref"
            required={true}
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            defaultValue={
              settings?.RerankModelPref || DEFAULT_ALIBABA_RERANK_MODEL
            }
          >
            <option value="qwen3-rerank">qwen3-rerank</option>
          </select>
        </div>
      </div>

      <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
        {t("rerank.help")}
      </div>
    </>
  );
}
