import { useCallback } from "react";
import System from "@/models/system";
import { useSettingsData } from "./SettingsDataProvider";

export function useSettingsSection(section) {
  const settingsData = useSettingsData();

  return useCallback(
    async ({ force = false, priority = "P0", signal = null } = {}) => {
      const response = await settingsData.loadSettings([section], {
        force,
        priority,
        signal,
      });
      if (response?.aborted || response?.stale) return null;
      if (response?.settings) return response.settings;

      return await System.keys();
    },
    [section, settingsData]
  );
}
