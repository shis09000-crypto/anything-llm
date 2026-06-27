export const TEXT_SIZE_KEY = "anythingllm_text_size";
export const TEXT_SIZE_CUSTOM_KEY = "anythingllm_text_size_custom_px";
export const TEXT_SIZE_CHANGE_EVENT = "textSizeChange";
export const DEFAULT_TEXT_SIZE = "normal";
export const CUSTOM_TEXT_SIZE = "custom";

export const TEXT_SIZE_RANGE = {
  min: 12,
  max: 22,
  step: 1,
};

export const TEXT_SIZE_PRESETS = [
  { value: "small", px: 12, textClass: "text-xs" },
  { value: "normal", px: 14, textClass: "text-sm" },
  { value: "large", px: 18, textClass: "text-base" },
];

export const DEFAULT_CUSTOM_TEXT_SIZE = 16;

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

export function saveTextSizePreference(value, customPx = null) {
  if (typeof window === "undefined") return getTextSizePreference(value);
  const nextValue = value === CUSTOM_TEXT_SIZE ? CUSTOM_TEXT_SIZE : value;
  const safeValue = presetForTextSize(nextValue) ? nextValue : CUSTOM_TEXT_SIZE;

  if (safeValue === CUSTOM_TEXT_SIZE) {
    window.localStorage.setItem(
      TEXT_SIZE_CUSTOM_KEY,
      String(clampCustomTextSize(customPx || getStoredCustomTextSize()))
    );
  }

  window.localStorage.setItem(TEXT_SIZE_KEY, safeValue);
  const preference = getTextSizePreference(safeValue);
  import("@/utils/userStateSync")
    .then(({ persistAppearancePreferences }) =>
      persistAppearancePreferences({
        textSize: preference.value,
        customTextSizePx: preference.customPx,
      })
    )
    .catch(() => {});
  window.dispatchEvent(
    new CustomEvent(TEXT_SIZE_CHANGE_EVENT, { detail: preference })
  );
  return preference;
}

export function textSizeStyleFor(preference) {
  return { fontSize: `${preference.px}px` };
}
