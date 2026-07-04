import React, { useState, useEffect } from "react";
import Appearance from "@/models/appearance";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function ShowScrollbar() {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [showScrollbar, setShowScrollbar] = useState(false);

  const handleChange = async (checked) => {
    const previousValue = showScrollbar;
    setShowScrollbar(checked);
    setSaving(true);

    const action = optimisticActionCenter.run({
      type: "appearance.showScrollbar.toggle",
      label: "optimistic:appearance-show-scrollbar-toggle",
      scope: { surface: "settings:appearance" },
      priority: "P1",
      resource: "network",
      protected: true,
      dedupeKey: `appearance:show-scrollbar:${checked}`,
      rollbackPatch: () => setShowScrollbar(previousValue),
      serverCall: async () =>
        Appearance.updateSettings({ showScrollbar: checked }),
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
      setShowScrollbar(settings.showScrollbar);
    }
    fetchSettings();
  }, []);

  return (
    <div className="my-4">
      <Toggle
        size="md"
        variant="horizontal"
        enabled={showScrollbar}
        onChange={handleChange}
        disabled={saving}
        label={t("customization.items.show-scrollbar.title")}
        description={t("customization.items.show-scrollbar.description")}
      />
    </div>
  );
}
