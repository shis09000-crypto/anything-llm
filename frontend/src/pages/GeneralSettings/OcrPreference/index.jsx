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

const DEFAULT_ALIBABA_OCR_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ALIBABA_OCR_MODEL = "qwen3.5-ocr";

function ocrProviders(t) {
  return [
    {
      name: t("ocr.providers.none.name"),
      value: "none",
      logo: AthenaIcon,
      description: t("ocr.providers.none.description"),
    },
    {
      name: t("ocr.providers.alibaba.name"),
      value: "alibaba",
      logo: GenericOpenAiLogo,
      description: t("ocr.providers.alibaba.description"),
    },
  ];
}

export default function GeneralOcrPreference() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState("none");
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const { t } = useTranslation();
  const providers = ocrProviders(t);
  const loadSettingsSection = useSettingsSection("ocr");

  const refreshSettings = useCallback(async () => {
    const _settings = await loadSettingsSection();
    setSettings(_settings);
    setSelectedProvider(_settings?.ReaderOcrProvider || "none");
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
    const data = { ReaderOcrProvider: selectedProvider };
    for (const [key, value] of formData.entries()) data[key] = value;

    const { error } = await System.updateSystem(data);
    if (error) {
      showToast(t("ocr.saveError", { error }), "error");
      setHasChanges(true);
    } else {
      showToast(t("ocr.saved"), "success");
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
      title={t("ocr.title")}
      description={t("ocr.description")}
      actions={
        hasChanges && (
          <SoftButton type="submit" form="ocr-settings-form">
            {saving ? t("ocr.saving") : t("ocr.save")}
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
          id="ocr-settings-form"
          onSubmit={handleSubmit}
          className="settings-soft-form"
        >
          <SoftCard title={t("ocr.provider")}>
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
                  {t("ocr.providerHint")}
                </p>
              </div>

              <div
                key={`${selectedProvider}-${settings?.ReaderOcrBaseUrl}-${settings?.ReaderOcrModelPref}-${settings?.ReaderOcrApiKey}`}
                onChange={() => setHasChanges(true)}
                className="mt-6 flex flex-col gap-y-7"
              >
                {selectedProvider === "alibaba" ? (
                  <AlibabaOcrOptions settings={settings} />
                ) : (
                  <NoOcrOptions />
                )}
              </div>
            </div>
          </SoftCard>
        </form>
      )}
    </SoftSettingsLayout>
  );
}

function NoOcrOptions() {
  const { t } = useTranslation();
  return (
    <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
      {t("ocr.noneHelp")}
    </div>
  );
}

function AlibabaOcrOptions({ settings }) {
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
            name="ReaderOcrApiKey"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder="DashScope API Key"
            defaultValue={settings?.ReaderOcrApiKey ? "*".repeat(20) : ""}
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
            name="ReaderOcrBaseUrl"
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none placeholder:text-theme-settings-input-placeholder focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            placeholder={DEFAULT_ALIBABA_OCR_BASE_URL}
            defaultValue={
              settings?.ReaderOcrBaseUrl || DEFAULT_ALIBABA_OCR_BASE_URL
            }
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex w-60 flex-col">
          <label className="mb-3 block text-sm font-semibold text-white light:text-theme-text-primary">
            {t("ocr.model")}
          </label>
          <select
            name="ReaderOcrModelPref"
            required={true}
            className="block w-full rounded-lg border-none bg-theme-settings-input-bg p-2.5 text-sm text-white outline-none focus:outline-primary-button active:outline-primary-button light:text-theme-settings-input-text"
            defaultValue={
              settings?.ReaderOcrModelPref || DEFAULT_ALIBABA_OCR_MODEL
            }
          >
            <option value="qwen3.5-ocr">qwen3.5-ocr</option>
            <option value="qwen-vl-ocr-latest">qwen-vl-ocr-latest</option>
          </select>
        </div>
      </div>

      <div className="max-w-[720px] rounded-xl border border-white/10 bg-theme-settings-input-bg p-4 text-xs leading-6 text-description light:border-theme-sidebar-border light:text-theme-text-secondary">
        {t("ocr.help")}
      </div>
    </>
  );
}
