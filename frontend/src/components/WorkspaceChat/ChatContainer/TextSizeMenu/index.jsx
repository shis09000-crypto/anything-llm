import { useState, useRef, useEffect, useMemo } from "react";
import { SlidersHorizontal } from "@phosphor-icons/react";
import useLoginMode from "@/hooks/useLoginMode";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import {
  CUSTOM_TEXT_SIZE,
  TEXT_SIZE_CHANGE_EVENT,
  TEXT_SIZE_PRESETS,
  TEXT_SIZE_RANGE,
  clampCustomTextSize,
  getTextSizePreference,
  saveTextSizePreference,
} from "@/utils/textSize";

const TEXT_SIZE_LABEL_FALLBACKS = {
  compact: "Compact",
  small: "Small",
  normal: "Normal",
  comfortable: "Comfortable",
  large: "Large",
  xlarge: "Extra large",
};

function getTextSizes(t) {
  return TEXT_SIZE_PRESETS.map(({ value, textClass }) => ({
    key: value,
    label: t(`chat_window.${value}`, {
      defaultValue: TEXT_SIZE_LABEL_FALLBACKS[value] || value,
    }),
    textClass,
  }));
}

export default function TextSizeMenu({ inline = false, onOpenChange = null }) {
  const { t } = useTranslation();
  const TEXT_SIZES = useMemo(() => getTextSizes(t), [t]);
  const mode = useLoginMode();
  const [showMenu, setShowMenu] = useState(false);
  const [selectedSize, setSelectedSize] = useState(() =>
    getTextSizePreference()
  );
  const [customPx, setCustomPx] = useState(() => selectedSize.customPx);
  const menuRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!showMenu) return;
    function handleClickOutside(e) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target)
      ) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  useEffect(() => {
    onOpenChange?.(showMenu);
  }, [showMenu, onOpenChange]);

  useEffect(() => {
    const handleTextSizeEvent = (event) => {
      const nextPreference = event.detail?.px
        ? event.detail
        : getTextSizePreference();
      setSelectedSize(nextPreference);
      setCustomPx(nextPreference.customPx);
    };
    window.addEventListener(TEXT_SIZE_CHANGE_EVENT, handleTextSizeEvent);
    return () =>
      window.removeEventListener(TEXT_SIZE_CHANGE_EVENT, handleTextSizeEvent);
  }, []);

  function handleTextSizeChange(size) {
    setSelectedSize(saveTextSizePreference(size));
  }

  function handleCustomTextSizeChange(value) {
    const nextPx = clampCustomTextSize(value);
    setCustomPx(nextPx);
    setSelectedSize(saveTextSizePreference(CUSTOM_TEXT_SIZE, nextPx));
  }

  // User icon is visible when login mode is active (single with password or multi-user)
  const hasUserIcon = mode !== null;

  if (isMobile && !inline) return null;
  const wrapperClass = inline
    ? "relative"
    : `absolute top-3 md:top-5 z-30 ${hasUserIcon ? "right-[55px] md:right-[67px]" : "right-4 md:right-6"}`;

  return (
    <div className={wrapperClass}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setShowMenu(!showMenu)}
        className={`group border-none cursor-pointer flex items-center justify-center w-[35px] h-[35px] rounded-full motion-hover ${
          showMenu
            ? "bg-zinc-700 light:bg-slate-200"
            : "hover:bg-zinc-700 light:hover:bg-slate-200"
        }`}
      >
        <SlidersHorizontal
          size={18}
          className={
            showMenu
              ? "text-white light:text-slate-800"
              : "text-zinc-300 light:text-slate-600 group-hover:text-white light:group-hover:text-slate-800"
          }
        />
      </button>

      {showMenu && (
        <div
          ref={menuRef}
          className="absolute right-0 top-[42px] bg-zinc-800 light:bg-white border border-zinc-700 light:border-slate-300 rounded-lg p-3 w-[200px] flex flex-col gap-1 shadow-lg"
        >
          <p className="text-[10px] font-medium text-zinc-400 light:text-slate-500 px-2 mb-0.5">
            {t("chat_window.text_size_label")}
          </p>
          {TEXT_SIZES.map(({ key, label, textClass }) => (
            <div
              key={key}
              onClick={() => handleTextSizeChange(key)}
              className={`flex items-center px-2 py-1 rounded cursor-pointer ${
                selectedSize.value === key
                  ? "bg-zinc-700 light:bg-slate-200"
                  : "hover:bg-zinc-700/50 light:hover:bg-slate-100"
              }`}
            >
              <span className={`${textClass} text-white light:text-slate-900`}>
                {label}
              </span>
            </div>
          ))}
          <div
            className={`mt-1 rounded px-2 py-2 ${
              selectedSize.isCustom
                ? "bg-zinc-700 light:bg-slate-200"
                : "bg-zinc-900/40 light:bg-slate-50"
            }`}
          >
            <div className="flex items-center justify-between text-white light:text-slate-900">
              <span className="text-sm">{t("chat_window.custom")}</span>
              <span className="text-[11px] text-zinc-300 light:text-slate-500">
                {customPx}px
              </span>
            </div>
            <input
              type="range"
              min={TEXT_SIZE_RANGE.min}
              max={TEXT_SIZE_RANGE.max}
              step={TEXT_SIZE_RANGE.step}
              value={customPx}
              aria-label={t("chat_window.custom_text_size")}
              onChange={(event) =>
                handleCustomTextSizeChange(event.target.value)
              }
              className="mt-2 h-2 w-full cursor-pointer accent-sky-400"
            />
          </div>
        </div>
      )}
    </div>
  );
}
