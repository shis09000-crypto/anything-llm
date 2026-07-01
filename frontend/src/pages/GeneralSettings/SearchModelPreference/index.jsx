import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import System from "@/models/system";
import showToast from "@/utils/toast";
import GenericOpenAiLogo from "@/media/llmprovider/generic-openai.png";
import AthenaIcon from "@/media/logo/athena-mark.svg";
import { CaretUpDown } from "@phosphor-icons/react";
import ProviderPresetImport from "@/components/ProviderPresetImport";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import {
  SoftButton,
  SoftCard,
  SoftProviderDropdown,
  SoftProviderTrigger,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

const DEFAULT_ALIBABA_SEARCH_MODEL_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ALIBABA_SEARCH_MODEL = "qwen3.7-plus";
const ALIBABA_SEARCH_MODELS = ["qwen3.7-plus", "qwen3.7-max-2026-06-08"];

function searchModelProviders(t) {
  return [
    {
      name: t("search_model.providers.none.name"),
      value: "none",
      logo: AthenaIcon,
      description: t("search_model.providers.none.description"),
    },
    {
      name: t("search_model.providers.alibaba.name"),
      value: "alibaba",
      logo: GenericOpenAiLogo,
      description: t("search_model.providers.alibaba.description"),
    },
  ];
}

export default function GeneralSearchModelPreference() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState("none");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const { t } = useTranslation();
  const providers = searchModelProviders(t);
  const loadSettingsSection = useSettingsSection("search");

  const refreshSettings = useCallback(async () => {
    const _settings = await loadSettingsSection();
    setSettings(_settings);
    setSelectedProvider(_settings?.SearchModelProvider || "none");
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
    const data = { SearchModelProvider: selectedProvider };
    for (const [key, value] of formData.entries()) data[key] = value;

    const { error } = await System.updateSystem(data);
    if (error) {
      showToast(t("search_model.saveError", { error }), "error");
      setHasChanges(true);
    } else {
      showToast(t("search_model.saved"), "success");
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
      title={t("search_model.title")}
      description={t("search_model.description")}
      actions={
        hasChanges && (
          <SoftButton type="submit" form="search-model-settings-form">
            {saving ? t("search_model.saving") : t("search_model.save")}
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
          id="search-model-settings-form"
          onSubmit={handleSubmit}
          className="settings-soft-form"
        >
          <SoftCard title={t("search_model.provider")}>
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
                {t("search_model.providerHint")}
              </p>
            </div>

            <div
              key={`${selectedProvider}-${settings?.SearchModelBaseUrl}-${settings?.SearchModelPref}-${settings?.SearchModelApiKey}`}
              onChange={() => setHasChanges(true)}
              className="mt-6 flex flex-col gap-y-7"
            >
              {selectedProvider === "alibaba" ? (
                <AlibabaSearchModelOptions settings={settings} />
              ) : (
                <NoSearchModelOptions />
              )}
            </div>

            <ProviderPresetImport onApplied={refreshSettings} />
          </SoftCard>
        </form>
      )}
    </SoftSettingsLayout>
  );
}

function NoSearchModelOptions() {
  const { t } = useTranslation();
  return (
    <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
      {t("search_model.noneHelp")}
    </div>
  );
}

function AlibabaSearchModelOptions({ settings }) {
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
            name="SearchModelApiKey"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder="DashScope API Key"
            defaultValue={settings?.SearchModelApiKey ? "*".repeat(20) : ""}
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
            name="SearchModelBaseUrl"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder={DEFAULT_ALIBABA_SEARCH_MODEL_BASE_URL}
            defaultValue={
              settings?.SearchModelBaseUrl ||
              DEFAULT_ALIBABA_SEARCH_MODEL_BASE_URL
            }
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex w-60 flex-col">
          <label className="mb-3 block text-sm font-semibold text-white light:text-theme-text-primary">
            {t("search_model.model")}
          </label>
          <select
            name="SearchModelPref"
            required={true}
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            defaultValue={
              settings?.SearchModelPref || DEFAULT_ALIBABA_SEARCH_MODEL
            }
          >
            {ALIBABA_SEARCH_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
        {t("search_model.help")}
      </div>
    </>
  );
}
