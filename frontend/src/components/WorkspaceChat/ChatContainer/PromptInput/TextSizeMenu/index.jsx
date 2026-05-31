import { useState, useRef } from "react";
import { TextT } from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import {
  CUSTOM_TEXT_SIZE,
  TEXT_SIZE_PRESETS,
  TEXT_SIZE_RANGE,
  clampCustomTextSize,
  getTextSizePreference,
  saveTextSizePreference,
} from "@/utils/textSize";

export default function TextSizeButton() {
  const tooltipRef = useRef(null);
  const { t } = useTranslation();
  const { theme } = useTheme();

  const toggleTooltip = () => {
    if (!tooltipRef.current) return;
    tooltipRef.current.isOpen
      ? tooltipRef.current.close()
      : tooltipRef.current.open();
  };

  return (
    <>
      <div
        id="text-size-btn"
        data-tooltip-id="tooltip-text-size-btn"
        aria-label={t("chat_window.text_size")}
        onClick={toggleTooltip}
        className="border-none flex justify-center items-center opacity-60 hover:opacity-100 light:opacity-100 light:hover:opacity-60 cursor-pointer"
      >
        <TextT
          color="var(--theme-sidebar-footer-icon-fill)"
          weight="fill"
          className="w-[20px] h-[20px] pointer-events-none text-white"
        />
      </div>
      <Tooltip
        ref={tooltipRef}
        id="tooltip-text-size-btn"
        place="top"
        opacity={1}
        clickable={true}
        delayShow={300}
        delayHide={800}
        arrowColor={
          theme === "light"
            ? "var(--theme-modal-border)"
            : "var(--theme-bg-primary)"
        }
        className="z-99 !w-[140px] !bg-theme-bg-primary !px-[5px] !rounded-lg !pointer-events-auto light:border-2 light:border-theme-modal-border"
      >
        <TextSizeMenu tooltipRef={tooltipRef} />
      </Tooltip>
    </>
  );
}

function TextSizeMenu({ tooltipRef }) {
  const { t } = useTranslation();
  const [selectedSize, setSelectedSize] = useState(() =>
    getTextSizePreference()
  );
  const [customPx, setCustomPx] = useState(() => selectedSize.customPx);

  const handleTextSizeChange = (size) => {
    setSelectedSize(saveTextSizePreference(size));
    tooltipRef.current?.close();
  };

  const handleCustomTextSizeChange = (value) => {
    const nextPx = clampCustomTextSize(value);
    setCustomPx(nextPx);
    setSelectedSize(saveTextSizePreference(CUSTOM_TEXT_SIZE, nextPx));
  };

  return (
    <div className="flex flex-col justify-start items-stretch gap-1 p-2">
      {TEXT_SIZE_PRESETS.map(({ value, textClass }) => (
        <button
          key={value}
          onClick={(e) => {
            e.preventDefault();
            handleTextSizeChange(value);
          }}
          className={`border-none w-full hover:cursor-pointer px-2 py-2 rounded-md flex items-center group ${
            selectedSize.value === value
              ? "bg-theme-action-menu-item-hover"
              : "hover:bg-theme-action-menu-item-hover"
          }`}
        >
          <div className={`text-theme-text-primary ${textClass}`}>
            {t(`chat_window.${value}`)}
          </div>
        </button>
      ))}
      <div
        className={`rounded-md px-2 py-2 ${
          selectedSize.isCustom
            ? "bg-theme-action-menu-item-hover"
            : "bg-theme-action-menu-item-hover/40"
        }`}
      >
        <div className="flex items-center justify-between text-theme-text-primary">
          <span className="text-sm">{t("chat_window.custom")}</span>
          <span className="text-[11px] opacity-70">{customPx}px</span>
        </div>
        <input
          type="range"
          min={TEXT_SIZE_RANGE.min}
          max={TEXT_SIZE_RANGE.max}
          step={TEXT_SIZE_RANGE.step}
          value={customPx}
          aria-label={t("chat_window.custom_text_size")}
          onChange={(event) => handleCustomTextSizeChange(event.target.value)}
          className="mt-2 h-2 w-full cursor-pointer accent-sky-400"
        />
      </div>
    </div>
  );
}
