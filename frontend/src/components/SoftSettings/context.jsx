import { createContext, useContext } from "react";

export const SoftSettingsShellContext = createContext(false);

export function useSoftSettingsShell() {
  return useContext(SoftSettingsShellContext);
}
