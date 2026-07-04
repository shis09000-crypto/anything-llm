import React, { useState, useEffect } from "react";
import Appearance from "@/models/appearance";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function ChatRenderHTML() {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [renderHTML, setRenderHTML] = useState(false);

  const handleChange = async (checked) => {
    const previousValue = renderHTML;
    setRenderHTML(checked);
    setSaving(true);

    const action = optimisticActionCenter.run({
      type: "appearance.renderHtml.toggle",
      label: "optimistic:appearance-render-html-toggle",
      scope: { surface: "settings:appearance" },
      priority: "P1",
      resource: "network",
      protected: true,
      dedupeKey: `appearance:render-html:${checked}`,
      rollbackPatch: () => setRenderHTML(previousValue),
      serverCall: async () =>
        Appearance.updateSettings({ renderHTML: checked }),
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
      setRenderHTML(settings.renderHTML);
    }
    fetchSettings();
  }, []);

  return (
    <div className="my-4">
      <Toggle
        size="md"
        variant="horizontal"
        enabled={renderHTML}
        onChange={handleChange}
        disabled={saving}
        label={t("customization.items.render-html.title")}
        description={t("customization.items.render-html.description")}
      />
    </div>
  );
}
