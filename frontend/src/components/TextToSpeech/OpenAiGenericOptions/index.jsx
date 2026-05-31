import React from "react";
import { useTranslation } from "react-i18next";

export default function OpenAiGenericTextToSpeechOptions({ settings }) {
  const { t } = useTranslation();

  return (
    <div className="w-full flex flex-col gap-y-7">
      <div className="flex gap-x-4">
        <div className="flex flex-col w-60">
          <div className="flex justify-between items-start mb-2">
            <label className="text-white text-sm font-semibold">
              {t("audio-preference.fields.baseUrl")}
            </label>
          </div>
          <input
            type="url"
            name="TTSOpenAICompatibleEndpoint"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="http://localhost:7851/v1"
            defaultValue={settings?.TTSOpenAICompatibleEndpoint}
            required={false}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
            {t("audio-preference.openaiCompatible.baseUrlHint")}
          </p>
        </div>
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-2">
            {t("audio-preference.fields.apiKey")}
          </label>
          <input
            type="password"
            name="TTSOpenAICompatibleKey"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder="API Key"
            defaultValue={
              settings?.TTSOpenAICompatibleKey ? "*".repeat(20) : ""
            }
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
            {t("audio-preference.openaiCompatible.apiKeyHint")}
          </p>
        </div>
      </div>
      <div className="flex gap-x-4">
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            {t("audio-preference.fields.ttsModel")}
          </label>
          <input
            type="text"
            name="TTSOpenAICompatibleModel"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder={t("audio-preference.openaiCompatible.ttsPlaceholder")}
            defaultValue={settings?.TTSOpenAICompatibleModel}
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
            {t("audio-preference.openaiCompatible.ttsModelHintStart")}{" "}
            <code>model</code>{" "}
            {t("audio-preference.openaiCompatible.ttsModelHintEnd")}
          </p>
        </div>
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            {t("audio-preference.fields.voiceModel")}
          </label>
          <input
            type="text"
            name="TTSOpenAICompatibleVoiceModel"
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
            placeholder={t(
              "audio-preference.openaiCompatible.voicePlaceholder"
            )}
            defaultValue={settings?.TTSOpenAICompatibleVoiceModel}
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs leading-[18px] font-base text-white text-opacity-60 mt-2">
            {t("audio-preference.openaiCompatible.voiceModelHint")}
          </p>
        </div>
      </div>
    </div>
  );
}
