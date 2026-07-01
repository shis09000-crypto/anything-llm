import React, { useCallback, useEffect, useState } from "react";
import SpeechToTextProvider from "./stt";
import TextToSpeechProvider from "./tts";
import { useTranslation } from "react-i18next";
import { useSettingsSection } from "@/pages/GeneralSettings/useSettingsSection";
import { SoftCard, SoftSettingsLayout } from "@/components/SoftSettings";

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
    <SoftSettingsLayout title={t("settings.voice-speech")}>
      {loading ? (
        <SoftCard>
          <div className="flex w-full max-w-[720px] flex-col gap-y-4">
            <div className="motion-skeleton h-16 rounded-2xl" />
            <div className="motion-skeleton h-28 rounded-2xl" />
            <div className="motion-skeleton h-10 w-2/3 rounded-2xl" />
          </div>
        </SoftCard>
      ) : (
        <div className="settings-soft-form">
          <SpeechToTextProvider settings={settings} />
          <TextToSpeechProvider settings={settings} />
        </div>
      )}
    </SoftSettingsLayout>
  );
}
