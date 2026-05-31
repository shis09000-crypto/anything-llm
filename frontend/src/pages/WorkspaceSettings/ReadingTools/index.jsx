import React, { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import renderMarkdown from "@/utils/chat/markdown";
import { useTranslation } from "react-i18next";
import {
  CUSTOM_TEXT_SIZE,
  TEXT_SIZE_CHANGE_EVENT,
  TEXT_SIZE_PRESETS,
  TEXT_SIZE_RANGE,
  clampCustomTextSize,
  getTextSizePreference,
  saveTextSizePreference,
  textSizeStyleFor,
} from "@/utils/textSize";

export default function ReadingTools() {
  const { t } = useTranslation();
  const [preference, setPreference] = useState(() => getTextSizePreference());
  const [customPx, setCustomPx] = useState(() => preference.customPx);
  const options = useMemo(
    () =>
      TEXT_SIZE_PRESETS.map((option) => ({
        ...option,
        label: t(`reading-tools.options.${option.value}.label`),
        description: t(`reading-tools.options.${option.value}.description`),
      })),
    [t]
  );

  const selectedLabel = useMemo(() => {
    if (preference.isCustom) {
      return t("reading-tools.options.custom.labelWithSize", {
        size: preference.px,
      });
    }

    return (
      options.find((item) => item.value === preference.value)?.label ||
      options[1].label
    );
  }, [options, preference.isCustom, preference.px, preference.value, t]);

  useEffect(() => {
    const handleTextSizeChange = (event) => {
      const nextPreference = event.detail?.px
        ? event.detail
        : getTextSizePreference();
      setPreference(nextPreference);
      setCustomPx(nextPreference.customPx);
    };

    window.addEventListener(TEXT_SIZE_CHANGE_EVENT, handleTextSizeChange);
    return () => {
      window.removeEventListener(TEXT_SIZE_CHANGE_EVENT, handleTextSizeChange);
    };
  }, []);

  const handlePresetChange = (value) => {
    setPreference(saveTextSizePreference(value));
  };

  const handleCustomChange = (value) => {
    const nextPx = clampCustomTextSize(value);
    setCustomPx(nextPx);
    setPreference(saveTextSizePreference(CUSTOM_TEXT_SIZE, nextPx));
  };

  return (
    <div className="max-w-5xl">
      <style>
        {`
          .reading-tools-preview strong { color: inherit; font-weight: 700; }
          .reading-tools-preview pre { margin-top: 0.75rem; border-radius: 0.75rem; padding: 0.875rem; overflow: auto; }
          .reading-tools-preview blockquote { margin: 0.75rem 0; padding-left: 0.875rem; border-left: 3px solid rgba(56, 189, 248, 0.55); }
          .reading-tools-preview ul { margin: 0.75rem 0; padding-left: 1.25rem; list-style: disc; }
        `}
      </style>
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-sky-400">
          {t("reading-tools.eyebrow")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-white light:text-slate-900">
          {t("reading-tools.title")}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60 light:text-slate-500">
          {t("reading-tools.description")}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="rounded-xl border border-white/10 light:border-slate-200 bg-white/5 light:bg-white p-4">
          <div className="text-sm font-semibold text-white light:text-slate-800">
            {t("reading-tools.sizeTitle")}
          </div>
          <div className="mt-4 space-y-3">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handlePresetChange(option.value)}
                className={`w-full rounded-lg border px-4 py-3 text-left motion-hover ${
                  preference.value === option.value
                    ? "border-sky-400 bg-sky-500/15 text-sky-100 light:bg-sky-50 light:text-sky-700"
                    : "border-white/10 light:border-slate-200 text-white/75 light:text-slate-700 hover:bg-white/5 light:hover:bg-slate-50"
                }`}
              >
                <div className="font-semibold">{option.label}</div>
                <div className="mt-1 text-xs opacity-70">
                  {option.description}
                </div>
              </button>
            ))}
            <div
              className={`rounded-lg border px-4 py-3 ${
                preference.isCustom
                  ? "border-sky-400 bg-sky-500/15 text-sky-100 light:bg-sky-50 light:text-sky-700"
                  : "border-white/10 light:border-slate-200 text-white/75 light:text-slate-700"
              }`}
            >
              <button
                type="button"
                onClick={() => handleCustomChange(customPx)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">
                    {t("reading-tools.options.custom.label")}
                  </span>
                  <span className="text-xs font-semibold opacity-80">
                    {customPx}px
                  </span>
                </div>
                <div className="mt-1 text-xs opacity-70">
                  {t("reading-tools.options.custom.description")}
                </div>
              </button>
              <input
                type="range"
                min={TEXT_SIZE_RANGE.min}
                max={TEXT_SIZE_RANGE.max}
                step={TEXT_SIZE_RANGE.step}
                value={customPx}
                aria-label={t("reading-tools.customSliderLabel")}
                onChange={(event) => handleCustomChange(event.target.value)}
                className="mt-4 h-2 w-full cursor-pointer accent-sky-400"
              />
              <div className="mt-2 flex items-center justify-between text-[11px] opacity-60">
                <span>{TEXT_SIZE_RANGE.min}px</span>
                <span>
                  {t("reading-tools.customRange", {
                    min: TEXT_SIZE_RANGE.min,
                    max: TEXT_SIZE_RANGE.max,
                  })}
                </span>
                <span>{TEXT_SIZE_RANGE.max}px</span>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 light:border-slate-200 bg-zinc-950/40 light:bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-white light:text-slate-800">
                {t("reading-tools.previewTitle")}
              </div>
              <div className="mt-1 text-xs text-white/50 light:text-slate-500">
                {t("reading-tools.currentSelection", {
                  label: selectedLabel,
                })}
              </div>
            </div>
          </div>

          <div className="space-y-4" style={textSizeStyleFor(preference)}>
            <div className="ml-auto max-w-[78%] rounded-2xl rounded-br-sm bg-sky-600 px-4 py-3 text-white shadow-sm">
              {t("reading-tools.userPreview")}
            </div>
            <div className="max-w-[86%] rounded-2xl rounded-bl-sm bg-white/10 light:bg-slate-50 px-4 py-3 text-white/85 light:text-slate-800 shadow-sm">
              <div
                className="reading-tools-preview leading-7"
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(
                    renderMarkdown(t("reading-tools.previewMarkdown"))
                  ),
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
