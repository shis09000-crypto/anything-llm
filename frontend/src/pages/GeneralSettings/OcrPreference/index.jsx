import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import System from "@/models/system";
import showToast from "@/utils/toast";
import PreLoader from "@/components/Preloader";
import CTAButton from "@/components/lib/CTAButton";
import GenericOpenAiLogo from "@/media/llmprovider/generic-openai.png";
import AthenaIcon from "@/media/logo/athena-mark.svg";
import { CaretUpDown } from "@phosphor-icons/react";

const DEFAULT_ALIBABA_OCR_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_ALIBABA_OCR_MODEL = "qwen-vl-ocr-latest";

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

  const refreshSettings = useCallback(async () => {
    const _settings = await System.keys();
    setSettings(_settings);
    setSelectedProvider(_settings?.ReaderOcrProvider || "none");
    setHasChanges(false);
    setLoading(false);
  }, []);

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
    <div className="flex h-screen w-screen overflow-hidden bg-theme-bg-container">
      <Sidebar />
      {loading ? (
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative h-full w-full overflow-y-scroll bg-theme-bg-secondary p-4 md:my-[16px] md:ml-[2px] md:mr-[16px] md:rounded-[16px] md:p-0"
        >
          <div className="flex h-full w-full items-center justify-center">
            <PreLoader />
          </div>
        </div>
      ) : (
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative h-full w-full overflow-y-scroll bg-theme-bg-secondary p-4 md:my-[16px] md:ml-[2px] md:mr-[16px] md:rounded-[16px] md:p-0"
        >
          <form onSubmit={handleSubmit} className="flex w-full">
            <div className="flex w-full flex-col px-1 py-16 md:py-6 md:pl-6 md:pr-[50px]">
              <div className="flex w-full flex-col gap-y-1 border-b-2 border-white border-opacity-10 pb-6 light:border-theme-sidebar-border">
                <div className="flex items-center gap-x-4">
                  <p className="text-lg font-bold leading-6 text-white light:text-theme-text-primary">
                    {t("ocr.title")}
                  </p>
                </div>
                <p className="text-xs font-base leading-[18px] text-white text-opacity-60 light:text-theme-text-secondary">
                  {t("ocr.description")}
                </p>
              </div>

              <div className="flex w-full justify-end">
                {hasChanges && (
                  <CTAButton className="z-10 -mb-14 mr-0 mt-3">
                    {saving ? t("ocr.saving") : t("ocr.save")}
                  </CTAButton>
                )}
              </div>

              <div className="mb-4 mt-6 text-base font-bold text-white light:text-theme-text-primary">
                {t("ocr.provider")}
              </div>

              <div className="relative w-full max-w-[640px]">
                {providerMenuOpen && (
                  <div
                    className="fixed inset-0 z-10 bg-black/70 backdrop-blur-sm"
                    onClick={() => setProviderMenuOpen(false)}
                  />
                )}
                {providerMenuOpen ? (
                  <div className="absolute left-0 top-0 z-20 flex max-h-[240px] min-h-[64px] w-full cursor-pointer flex-col justify-between overflow-hidden rounded-lg border-2 border-primary-button bg-theme-settings-input-bg">
                    <div className="max-h-[220px] overflow-y-auto p-2 white-scrollbar">
                      {providers.map((provider) => (
                        <button
                          key={provider.value}
                          type="button"
                          onClick={() => updateProviderChoice(provider.value)}
                          className={`w-full rounded-md p-2 text-left hover:bg-theme-bg-secondary ${
                            selectedProvider === provider.value
                              ? "bg-theme-bg-secondary"
                              : ""
                          }`}
                        >
                          <div className="flex items-center gap-x-4">
                            <img
                              src={provider.logo}
                              alt={`${provider.name} logo`}
                              className="h-10 w-10 rounded-md"
                            />
                            <div className="flex flex-col">
                              <div className="text-sm font-semibold text-white light:text-theme-text-primary">
                                {provider.name}
                              </div>
                              <div className="mt-1 text-xs text-description light:text-theme-text-secondary">
                                {provider.description}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <button
                    className="motion-hover flex h-[64px] w-full cursor-pointer items-center justify-between rounded-lg border-2 border-transparent bg-theme-settings-input-bg p-[14px] hover:border-primary-button"
                    type="button"
                    onClick={() => setProviderMenuOpen(true)}
                  >
                    <div className="flex items-center gap-x-4">
                      <img
                        src={selectedProviderObject.logo}
                        alt={`${selectedProviderObject.name} logo`}
                        className="h-10 w-10 rounded-md"
                      />
                      <div className="flex flex-col text-left">
                        <div className="text-sm font-semibold text-white light:text-theme-text-primary">
                          {selectedProviderObject.name}
                        </div>
                        <div className="mt-1 text-xs text-description light:text-theme-text-secondary">
                          {selectedProviderObject.description}
                        </div>
                      </div>
                    </div>
                    <CaretUpDown
                      size={24}
                      weight="bold"
                      className="text-white light:text-theme-text-primary"
                    />
                  </button>
                )}
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
          </form>
        </div>
      )}
    </div>
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
