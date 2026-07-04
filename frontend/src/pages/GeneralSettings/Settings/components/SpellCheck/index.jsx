import React, { useState } from "react";
import Appearance from "@/models/appearance";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";

export default function SpellCheck() {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [enableSpellCheck, setEnableSpellCheck] = useState(
    Appearance.get("enableSpellCheck")
  );

  const handleChange = async (checked) => {
    const previousValue = enableSpellCheck;
    setEnableSpellCheck(checked);
    setSaving(true);

    const action = optimisticActionCenter.run({
      type: "appearance.spellCheck.toggle",
      label: "optimistic:appearance-spell-check-toggle",
      scope: { surface: "settings:appearance" },
      priority: "P1",
      resource: "network",
      protected: true,
      dedupeKey: `appearance:spell-check:${checked}`,
      rollbackPatch: () => setEnableSpellCheck(previousValue),
      serverCall: async () => Appearance.set("enableSpellCheck", checked),
    });
    const outcome = await action.promise;

    if (!outcome.ok) {
      console.error("Failed to update appearance settings:", outcome.error);
    }
    setSaving(false);
  };

  return (
    <div className="my-4">
      <Toggle
        size="md"
        variant="horizontal"
        enabled={enableSpellCheck}
        onChange={handleChange}
        disabled={saving}
        label={t("customization.chat.spellcheck.title")}
        description={t("customization.chat.spellcheck.description")}
      />
    </div>
  );
}
