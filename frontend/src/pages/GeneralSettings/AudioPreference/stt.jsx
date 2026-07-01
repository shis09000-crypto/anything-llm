import React, { useEffect, useState, useRef } from "react";
import System from "@/models/system";
import showToast from "@/utils/toast";
import LLMItem from "@/components/LLMSelection/LLMItem";
import { CaretUpDown, MagnifyingGlass, X } from "@phosphor-icons/react";
import CTAButton from "@/components/lib/CTAButton";
import AthenaIcon from "@/media/logo/athena-mark.svg";
import BrowserNative from "@/components/SpeechToText/BrowserNative";
import { useTranslation } from "react-i18next";
import {
  SoftProviderDropdown,
  SoftProviderTrigger,
} from "@/components/SoftSettings";

export default function SpeechToTextProvider({ settings }) {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredProviders, setFilteredProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState(
    settings?.SpeechToTextProvider || "native"
  );
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const searchInputRef = useRef(null);
  const { t } = useTranslation();
  const providers = [
    {
      name: t("audio-preference.providers.native.name"),
      value: "native",
      logo: AthenaIcon,
      options: (settings) => <BrowserNative settings={settings} />,
      description: t("audio-preference.providers.native.sttDescription"),
    },
  ];

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const form = e?.target;
    const data = { SpeechToTextProvider: selectedProvider };
    const formData = new FormData(form);

    for (var [key, value] of formData.entries()) data[key] = value;
    const { error } = await System.updateSystem(data);
    setSaving(true);

    if (error) {
      showToast(t("audio-preference.toasts.sttSaveFailed", { error }), "error");
    } else {
      showToast(t("audio-preference.toasts.sttSaved"), "success");
    }
    setSaving(false);
    setHasChanges(!!error);
  };

  const updateProviderChoice = (selection) => {
    setSearchQuery("");
    setSelectedProvider(selection);
    setSearchMenuOpen(false);
    setHasChanges(true);
  };

  const handleXButton = () => {
    if (searchQuery.length > 0) {
      setSearchQuery("");
      if (searchInputRef.current) searchInputRef.current.value = "";
    } else {
      setSearchMenuOpen(!searchMenuOpen);
    }
  };

  useEffect(() => {
    const filtered = providers.filter((provider) =>
      provider.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredProviders(filtered);
  }, [searchQuery, selectedProvider]);

  const selectedProviderObject = providers.find(
    (provider) => provider.value === selectedProvider
  );

  return (
    <form onSubmit={handleSubmit} className="flex w-full">
      <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
        <div className="w-full flex flex-col gap-y-1 pb-6 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10">
          <div className="flex gap-x-4 items-center">
            <p className="text-lg leading-6 font-bold text-white">
              {t("audio-preference.stt.title")}
            </p>
          </div>
          <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
            {t("audio-preference.stt.description")}
          </p>
        </div>
        <div className="w-full justify-end flex">
          {hasChanges && (
            <CTAButton className="mt-3 mr-0 -mb-14 z-10">
              {saving ? t("common.saving") : t("common.save")}
            </CTAButton>
          )}
        </div>
        <div className="text-base font-bold text-white mt-6 mb-4">
          {t("audio-preference.provider")}
        </div>
        <div className="settings-soft-provider-picker">
          <SoftProviderTrigger
            logo={selectedProviderObject.logo}
            name={selectedProviderObject.name}
            description={selectedProviderObject.description}
            onClick={() => setSearchMenuOpen((open) => !open)}
          >
            <CaretUpDown
              size={24}
              weight="bold"
              className="text-[var(--soft-text-muted)]"
            />
          </SoftProviderTrigger>
          <SoftProviderDropdown open={searchMenuOpen}>
            <div className="settings-soft-provider-searchbar">
              <MagnifyingGlass
                size={20}
                weight="bold"
                className="text-[var(--soft-text-muted)]"
              />
              <input
                type="text"
                name="stt-provider-search"
                autoComplete="off"
                placeholder={t("audio-preference.stt.searchPlaceholder")}
                onChange={(e) => setSearchQuery(e.target.value)}
                ref={searchInputRef}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
              <X
                size={20}
                weight="bold"
                className="cursor-pointer text-[var(--soft-text-muted)] hover:text-[var(--soft-text-primary)]"
                onClick={handleXButton}
              />
            </div>
            <div className="settings-soft-provider-list white-scrollbar">
              {filteredProviders.map((provider) => (
                <LLMItem
                  key={provider.name}
                  name={provider.name}
                  value={provider.value}
                  image={provider.logo}
                  description={provider.description}
                  checked={selectedProvider === provider.value}
                  onClick={() => updateProviderChoice(provider.value)}
                />
              ))}
            </div>
          </SoftProviderDropdown>
        </div>
        <div
          onChange={() => setHasChanges(true)}
          className="mt-4 flex flex-col gap-y-1"
        >
          {selectedProvider &&
            providers
              .find((provider) => provider.value === selectedProvider)
              ?.options(settings)}
        </div>
      </div>
    </form>
  );
}
