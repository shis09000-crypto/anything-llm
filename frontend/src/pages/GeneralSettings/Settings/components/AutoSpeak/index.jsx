import React, { useState, useEffect } from "react";
import Appearance from "@/models/appearance";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function AutoSpeak() {
  const [saving, setSaving] = useState(false);
  const [autoPlayAssistantTtsResponse, setAutoPlayAssistantTtsResponse] =
    useState(false);
  const { t } = useTranslation();

  const handleChange = async (checked) => {
    const previousValue = autoPlayAssistantTtsResponse;
    setAutoPlayAssistantTtsResponse(checked);
    setSaving(true);

    const action = optimisticActionCenter.run({
      type: "appearance.autoSpeak.toggle",
      label: "optimistic:appearance-auto-speak-toggle",
      scope: { surface: "settings:appearance" },
      priority: "P1",
      resource: "network",
      protected: true,
      dedupeKey: `appearance:auto-speak:${checked}`,
      rollbackPatch: () => setAutoPlayAssistantTtsResponse(previousValue),
      serverCall: async () =>
        Appearance.updateSettings({ autoPlayAssistantTtsResponse: checked }),
    });
    const outcome = await action.promise;

    if (!outcome.ok) {
      console.error("Failed to update appearance settings:", outcome.error);
    }
    setSaving(false);
  };

  useEffect(() => {
    function fetchSettings() {
      const settings = Appearance.getSettings();
      setAutoPlayAssistantTtsResponse(
        settings.autoPlayAssistantTtsResponse ?? false
      );
    }
    fetchSettings();
  }, []);

  return (
    <div className="my-4">
      <Toggle
        size="md"
        variant="horizontal"
        enabled={autoPlayAssistantTtsResponse}
        onChange={handleChange}
        disabled={saving}
        label={t("customization.chat.auto_speak.title")}
        description={t("customization.chat.auto_speak.description")}
      />
    </div>
  );
}
