import React, { useCallback, useEffect, useState, useRef } from "react";
import System from "@/models/system";
import showToast from "@/utils/toast";
import OpenAiLogo from "@/media/llmprovider/openai.png";
import AthenaIcon from "@/media/logo/athena-mark.svg";
import OpenAiWhisperOptions from "@/components/TranscriptionSelection/OpenAiOptions";
import NativeTranscriptionOptions from "@/components/TranscriptionSelection/NativeTranscriptionOptions";
import LLMItem from "@/components/LLMSelection/LLMItem";
import { CaretUpDown, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import {
  SoftButton,
  SoftCard,
  SoftProviderDropdown,
  SoftProviderTrigger,
  SoftSettingsLayout,
} from "@/components/SoftSettings";

const PROVIDERS = [
  {
    name: "OpenAI",
    value: "openai",
    logo: OpenAiLogo,
    options: (settings) => <OpenAiWhisperOptions settings={settings} />,
    description: "Leverage the OpenAI Whisper-large model using your API key.",
  },
  {
    name: "Athena Built-In",
    value: "local",
    logo: AthenaIcon,
    options: (settings) => <NativeTranscriptionOptions settings={settings} />,
    description: "Run a built-in whisper model on this instance privately.",
  },
];

export default function TranscriptionModelPreference() {
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filteredProviders, setFilteredProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [searchMenuOpen, setSearchMenuOpen] = useState(false);
  const searchInputRef = useRef(null);
  const { t } = useTranslation();
  const loadSettingsSection = useSettingsSection("transcription");

  const handleSubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = { WhisperProvider: selectedProvider };
    const formData = new FormData(form);

    for (var [key, value] of formData.entries()) data[key] = value;
    const { error } = await System.updateSystem(data);
    setSaving(true);

    if (error) {
      showToast(`Failed to save preferences: ${error}`, "error");
    } else {
      showToast("Transcription preferences saved successfully.", "success");
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

  const refreshSettings = useCallback(async () => {
    const _settings = await loadSettingsSection();
    setSettings(_settings);
    setSelectedProvider(_settings?.WhisperProvider || "local");
    setLoading(false);
  }, [loadSettingsSection]);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  useEffect(() => {
    const filtered = PROVIDERS.filter((provider) =>
      provider.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredProviders(filtered);
  }, [searchQuery, selectedProvider]);

  const selectedProviderObject = PROVIDERS.find(
    (provider) => provider.value === selectedProvider
  );

  return (
    <SoftSettingsLayout
      title={t("transcription.title")}
      description={t("transcription.description")}
      actions={
        hasChanges && (
          <SoftButton type="submit" form="transcription-settings-form">
            {saving ? "Saving..." : "Save changes"}
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
          id="transcription-settings-form"
          onSubmit={handleSubmit}
          className="settings-soft-form"
        >
          <SoftCard title={t("transcription.provider")}>
            <div className="flex flex-col w-full">
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
                      name="provider-search"
                      autoComplete="off"
                      placeholder="Search audio transcription providers"
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
                  PROVIDERS.find(
                    (provider) => provider.value === selectedProvider
                  )?.options(settings)}
              </div>
            </div>
          </SoftCard>
        </form>
      )}
    </SoftSettingsLayout>
  );
}
