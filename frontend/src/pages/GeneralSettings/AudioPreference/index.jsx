import React, { useCallback, useEffect, useState } from "react";
import { isMobile } from "react-device-detect";
import Sidebar from "@/components/SettingsSidebar";
import SpeechToTextProvider from "./stt";
import TextToSpeechProvider from "./tts";
import { useTranslation } from "react-i18next";
import { SettingsSectionSkeleton } from "@/pages/GeneralSettings/SettingsDataProvider";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";

export default function AudioPreference() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const { t } = useTranslation();
  const loadSettingsSection = useSettingsSection("audio");

  const refreshSettings = useCallback(async () => {
    const _settings = await loadSettingsSection();
    setSettings(_settings);
    setLoading(false);
  }, [loadSettingsSection]);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      {loading ? (
        <SettingsSectionSkeleton title={t("settings.voice-speech")} />
      ) : (
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
        >
          <SpeechToTextProvider settings={settings} />
          <TextToSpeechProvider settings={settings} />
        </div>
      )}
    </div>
  );
}
