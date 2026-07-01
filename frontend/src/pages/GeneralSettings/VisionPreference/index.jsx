import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import System from "@/models/system";
import showToast from "@/utils/toast";
import Toggle from "@/components/lib/Toggle";
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

const DEFAULT_ALIBABA_VISION_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ALIBABA_VISION_MODEL = "qwen3-vl-flash";
const ALIBABA_VISION_MODELS = [
  "qwen3-vl-flash",
  "qwen-vl-plus",
  "qwen3-vl-plus-2025-09-23",
  "qwen3-vl-flash-2026-01-22",
  "qwen3-vl-plus",
  "qwen3-vl-plus-2025-12-19",
];

function visionProviders(t) {
  return [
    {
      name: t("vision.providers.none.name"),
      value: "none",
      logo: AthenaIcon,
      description: t("vision.providers.none.description"),
    },
    {
      name: t("vision.providers.alibaba.name"),
      value: "alibaba",
      logo: GenericOpenAiLogo,
      description: t("vision.providers.alibaba.description"),
    },
  ];
}

export default function GeneralVisionPreference() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState("none");
  const [visionToolEnabled, setVisionToolEnabled] = useState(true);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const { t } = useTranslation();
  const providers = visionProviders(t);
  const loadSettingsSection = useSettingsSection("vision");

  const refreshSettings = useCallback(async () => {
    const _settings = await loadSettingsSection();
    setSettings(_settings);
    setSelectedProvider(_settings?.VisionProvider || "none");
    setVisionToolEnabled(_settings?.VisionToolEnabled !== false);
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
    const data = { VisionProvider: selectedProvider };
    for (const [key, value] of formData.entries()) data[key] = value;

    const { error } = await System.updateSystem(data);
    if (error) {
      showToast(t("vision.saveError", { error }), "error");
      setHasChanges(true);
    } else {
      showToast(t("vision.saved"), "success");
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
      title={t("vision.title")}
      description={t("vision.description")}
      actions={
        hasChanges && (
          <SoftButton type="submit" form="vision-settings-form">
            {saving ? t("vision.saving") : t("vision.save")}
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
          id="vision-settings-form"
          onSubmit={handleSubmit}
          className="settings-soft-form"
        >
          <SoftCard title={t("vision.provider")}>
            <div className="flex w-full flex-col">
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
                        className={`settings-soft-provider-option ${
                          selectedProvider === provider.value
                            ? "is-selected"
                            : ""
                        }`}
                      >
                        <span className="settings-soft-provider-copy">
                          <span className="settings-soft-provider-logo-wrap">
                            <img
                              src={provider.logo}
                              alt={`${provider.name} logo`}
                              className="settings-soft-provider-logo"
                            />
                          </span>
                          <span className="min-w-0 text-left">
                            <span className="settings-soft-provider-name">
                              {provider.name}
                            </span>
                            <span className="settings-soft-provider-description">
                              {provider.description}
                            </span>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </SoftProviderDropdown>
                <p className="mt-2 text-xs leading-5 text-description light:text-theme-text-secondary">
                  {t("vision.providerHint")}
                </p>
              </div>

              <div
                key={`${selectedProvider}-${settings?.VisionBaseUrl}-${settings?.VisionModelPref}-${settings?.VisionApiKey}-${settings?.VisionToolEnabled}`}
                onChange={() => setHasChanges(true)}
                className="mt-6 flex flex-col gap-y-7"
              >
                <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 light:border-theme-sidebar-border">
                  <input
                    type="hidden"
                    name="VisionToolEnabled"
                    value={visionToolEnabled ? "true" : "false"}
                  />
                  <Toggle
                    size="lg"
                    label={t("vision.toolToggle.label")}
                    description={
                      selectedProvider === "alibaba"
                        ? t("vision.toolToggle.description")
                        : t("vision.toolToggle.disabledDescription")
                    }
                    enabled={visionToolEnabled}
                    onChange={(checked) => {
                      setVisionToolEnabled(checked);
                      setHasChanges(true);
                    }}
                  />
                </div>
                {selectedProvider === "alibaba" ? (
                  <AlibabaVisionOptions settings={settings} />
                ) : (
                  <NoVisionOptions />
                )}
              </div>

              <ProviderPresetImport onApplied={refreshSettings} />
            </div>
          </SoftCard>
        </form>
      )}
    </SoftSettingsLayout>
  );
}

function NoVisionOptions() {
  const { t } = useTranslation();
  return (
    <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
      {t("vision.noneHelp")}
    </div>
  );
}

function AlibabaVisionOptions({ settings }) {
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
            name="VisionApiKey"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder="DashScope API Key"
            defaultValue={settings?.VisionApiKey ? "*".repeat(20) : ""}
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
            name="VisionBaseUrl"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder={DEFAULT_ALIBABA_VISION_BASE_URL}
            defaultValue={
              settings?.VisionBaseUrl || DEFAULT_ALIBABA_VISION_BASE_URL
            }
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex w-72 flex-col">
          <label className="mb-3 block text-sm font-semibold text-white light:text-theme-text-primary">
            {t("vision.model")}
          </label>
          <select
            name="VisionModelPref"
            required={true}
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            defaultValue={
              settings?.VisionModelPref || DEFAULT_ALIBABA_VISION_MODEL
            }
          >
            {ALIBABA_VISION_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
        {t("vision.help")}
      </div>
    </>
  );
}
