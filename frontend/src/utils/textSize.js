export const TEXT_SIZE_KEY = "anythingllm_text_size";
export const TEXT_SIZE_CUSTOM_KEY = "anythingllm_text_size_custom_px";
export const TEXT_SIZE_CHANGE_EVENT = "textSizeChange";
export const DEFAULT_TEXT_SIZE = "normal";
export const CUSTOM_TEXT_SIZE = "custom";

export const TEXT_SIZE_RANGE = {
  min: 12,
  max: 26,
  step: 1,
};

export const TEXT_SIZE_PRESETS = [
  { value: "compact", px: 12, textClass: "text-xs" },
  { value: "small", px: 13, textClass: "" },
  { value: "normal", px: 14, textClass: "text-sm" },
  { value: "comfortable", px: 16, textClass: "" },
  { value: "large", px: 18, textClass: "text-base" },
  { value: "xlarge", px: 20, textClass: "" },
];

export const DEFAULT_CUSTOM_TEXT_SIZE = 16;
export const TEXT_SIZE_CUSTOM_STEPS = [12, 14, 16, 18, 20, 22, 24, 26];
export const TEXT_SIZE_PERSIST_DEBOUNCE_MS = 750;

let pendingPersistPayload = null;
let persistTimer = null;
let persistAppearancePreferencesOverride = null;

export function clampCustomTextSize(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_CUSTOM_TEXT_SIZE;
  return Math.min(TEXT_SIZE_RANGE.max, Math.max(TEXT_SIZE_RANGE.min, number));
}

export function presetForTextSize(value) {
  return TEXT_SIZE_PRESETS.find((preset) => preset.value === value) || null;
}

export function getStoredTextSize() {
  if (typeof window === "undefined") return DEFAULT_TEXT_SIZE;
  const stored = window.localStorage.getItem(TEXT_SIZE_KEY);
  if (stored === CUSTOM_TEXT_SIZE || presetForTextSize(stored)) return stored;
  return DEFAULT_TEXT_SIZE;
}

export function getStoredCustomTextSize() {
  if (typeof window === "undefined") return DEFAULT_CUSTOM_TEXT_SIZE;
  return clampCustomTextSize(
    window.localStorage.getItem(TEXT_SIZE_CUSTOM_KEY) ||
      DEFAULT_CUSTOM_TEXT_SIZE
  );
}

export function getTextSizePreference(value = getStoredTextSize()) {
  const textSize = value === CUSTOM_TEXT_SIZE ? CUSTOM_TEXT_SIZE : value;
  if (textSize === CUSTOM_TEXT_SIZE) {
    const customPx = getStoredCustomTextSize();
    return {
      value: CUSTOM_TEXT_SIZE,
      customPx,
      px: customPx,
      textClass: "",
      isCustom: true,
    };
  }

  const preset =
    presetForTextSize(textSize) || presetForTextSize(DEFAULT_TEXT_SIZE);
  return {
    ...preset,
    customPx: getStoredCustomTextSize(),
    isCustom: false,
  };
}

function safeTextSizeValue(value) {
  if (value === CUSTOM_TEXT_SIZE) return CUSTOM_TEXT_SIZE;
  return presetForTextSize(value) ? value : CUSTOM_TEXT_SIZE;
}

function dispatchTextSizeChange(preference) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TEXT_SIZE_CHANGE_EVENT, { detail: preference })
  );
}

async function persistPendingTextSizePreference() {
  if (!pendingPersistPayload) return null;
  const payload = pendingPersistPayload;
  pendingPersistPayload = null;

  try {
    if (persistAppearancePreferencesOverride) {
      await persistAppearancePreferencesOverride(payload);
      return payload;
    }

    const { persistAppearancePreferences } = await import(
      "@/utils/userStateSync"
    );
    await persistAppearancePreferences(payload);
  } catch {}

  return payload;
}

function scheduleTextSizePreferencePersist(payload) {
  if (typeof window === "undefined") return;
  pendingPersistPayload = payload;
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistPendingTextSizePreference();
  }, TEXT_SIZE_PERSIST_DEBOUNCE_MS);
}

export function setTextSizePreferencePersisterForTests(persister = null) {
  persistAppearancePreferencesOverride = persister;
}

export async function flushPendingTextSizePreference() {
  if (persistTimer && typeof window !== "undefined") {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  return persistPendingTextSizePreference();
}

export function applySyncedTextSizePreference(
  { textSize = null, customTextSizePx = null } = {},
  { dispatch = true } = {}
) {
  if (typeof window === "undefined")
    return getTextSizePreference(textSize || DEFAULT_TEXT_SIZE);

  const safeValue = textSize
    ? textSize === CUSTOM_TEXT_SIZE || presetForTextSize(textSize)
      ? textSize
      : DEFAULT_TEXT_SIZE
    : getStoredTextSize();
  if (customTextSizePx !== null && customTextSizePx !== undefined) {
    window.localStorage.setItem(
      TEXT_SIZE_CUSTOM_KEY,
      String(clampCustomTextSize(customTextSizePx))
    );
  }
  window.localStorage.setItem(TEXT_SIZE_KEY, safeValue);

  const preference = getTextSizePreference(safeValue);
  if (dispatch) dispatchTextSizeChange(preference);
  return preference;
}

export function saveTextSizePreference(value, customPx = null) {
  if (typeof window === "undefined") return getTextSizePreference(value);
  const nextValue = safeTextSizeValue(value);
  const nextCustomPx =
    nextValue === CUSTOM_TEXT_SIZE
      ? clampCustomTextSize(customPx || getStoredCustomTextSize())
      : customPx !== null && customPx !== undefined
        ? clampCustomTextSize(customPx)
        : getStoredCustomTextSize();

  const preference = applySyncedTextSizePreference({
    textSize: nextValue,
    customTextSizePx: nextCustomPx,
  });
  scheduleTextSizePreferencePersist({
    textSize: preference.value,
    customTextSizePx: preference.customPx,
  });
  return preference;
}

export function textSizeStyleFor(preference) {
  return { fontSize: `${preference.px}px` };
}
