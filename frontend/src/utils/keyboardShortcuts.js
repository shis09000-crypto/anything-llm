import paths from "./paths";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { userFromStorage } from "./request";
import { TOGGLE_LLM_SELECTOR_EVENT } from "@/components/WorkspaceChat/ChatContainer/PromptInput/LLMSelector/action";
import { canSeeAdmin } from "@/utils/authz";

export const KEYBOARD_SHORTCUTS_HELP_EVENT = "keyboard-shortcuts-help";
export const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
export const SHORTCUTS = {
  "⌘ + ,": {
    translationKey: "settings",
    action: (navigate) => {
      navigate(paths.settings.interface());
    },
  },
  "⌘ + H": {
    translationKey: "home",
    action: (navigate) => {
      navigate(paths.home());
    },
  },
  "⌘ + I": {
    translationKey: "workspaces",
    action: (navigate) => {
      navigate(paths.settings.workspaces());
    },
  },
  "⌘ + K": {
    translationKey: "apiKeys",
    action: (navigate) => {
      navigate(paths.settings.apiKeys());
    },
  },
  "⌘ + L": {
    translationKey: "llmPreferences",
    action: (navigate) => {
      navigate(paths.settings.llmPreference());
    },
  },
  "⌘ + Shift + C": {
    translationKey: "chatSettings",
    action: (navigate) => {
      navigate(paths.settings.chat());
    },
  },
  "⌘ + Shift + ?": {
    translationKey: "help",
    action: () => {
      window.dispatchEvent(
        new CustomEvent(KEYBOARD_SHORTCUTS_HELP_EVENT, {
          detail: { show: true },
        })
      );
    },
  },
  F1: {
    translationKey: "help",
    action: () => {
      window.dispatchEvent(
        new CustomEvent(KEYBOARD_SHORTCUTS_HELP_EVENT, {
          detail: { show: true },
        })
      );
    },
  },
  "⌘ + Shift + L": {
    translationKey: "showLLMSelector",
    action: () => {
      window.dispatchEvent(new Event(TOGGLE_LLM_SELECTOR_EVENT));
    },
  },
};

const LISTENERS = {};
const modifier = isMac ? "meta" : "ctrl";
for (const key in SHORTCUTS) {
  const listenerKey = key
    .replace("⌘", modifier)
    .replaceAll(" ", "")
    .toLowerCase();
  LISTENERS[listenerKey] = SHORTCUTS[key].action;
}

// Convert keyboard event to shortcut key
function getShortcutKey(event) {
  let key = "";
  if (event.metaKey || event.ctrlKey) key += modifier + "+";
  if (event.shiftKey) key += "shift+";
  if (event.altKey) key += "alt+";

  // Handle special keys
  if (event.key === ",") key += ",";
  // Handle question mark or slash for help shortcut
  else if (event.key === "?" || event.key === "/") key += "?";
  else if (event.key === "Control")
    return ""; // Ignore Control key by itself
  else if (event.key === "Shift")
    return ""; // Ignore Shift key by itself
  else key += event.key.toLowerCase();
  return key;
}

// Initialize keyboard shortcuts
export function initKeyboardShortcuts(navigate) {
  function handleKeyDown(event) {
    const shortcutKey = getShortcutKey(event);
    if (!shortcutKey) return;

    const action = LISTENERS[shortcutKey];
    if (action) {
      event.preventDefault();
      action(navigate);
    }
  }

  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}

function useKeyboardShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    // If there is a user and the user is not an admin do not register the event listener
    // since some of the shortcuts are only available in multi-user mode as admin
    const user = userFromStorage();
    if (!!user && !canSeeAdmin(user)) return;
    const cleanup = initKeyboardShortcuts(navigate);

    return () => cleanup();
  }, [navigate]);
  return;
}

export function KeyboardShortcutWrapper({ children }) {
  useKeyboardShortcuts();
  return children;
}
