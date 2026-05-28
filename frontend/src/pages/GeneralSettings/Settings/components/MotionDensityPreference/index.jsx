import { MOTION_DENSITIES, useMotion } from "@/contexts/MotionProvider";
import { useTranslation } from "react-i18next";

const MOTION_DENSITY_PREVIEWS = {
  minimal: {
    duration: "1.05s",
    distance: "42px",
    steps: 2,
  },
  balanced: {
    duration: "1.45s",
    distance: "58px",
    steps: 3,
  },
  expressive: {
    duration: "1.9s",
    distance: "72px",
    steps: 4,
  },
};

export default function MotionDensityPreference() {
  const { motionDensity, setMotionDensity } = useMotion();
  const { t } = useTranslation();

  return (
    <div className="my-4 flex flex-col gap-y-0.5">
      <p className="text-sm leading-6 font-semibold text-white">
        {t("customization.items.motion-density.title")}
      </p>
      <p className="text-xs text-white/60">
        {t("customization.items.motion-density.description")}
      </p>
      <div className="mt-3 flex flex-col gap-2 md:flex-row">
        {Object.keys(MOTION_DENSITIES).map((key) => {
          const active = motionDensity === key;
          const preview = MOTION_DENSITY_PREVIEWS[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => setMotionDensity(key)}
              className={`motion-pressable motion-density-card motion-density-option rounded-xl border px-4 py-3 text-left md:w-[220px] ${
                active ? "is-active" : ""
              }`}
              style={{
                "--motion-preview-duration": preview.duration,
                "--motion-preview-distance": preview.distance,
              }}
            >
              <span className="motion-density-option-label block text-sm font-semibold">
                {t(`customization.items.motion-density.options.${key}.label`)}
              </span>
              <span className="motion-density-option-description mt-1 block text-xs leading-5">
                {t(
                  `customization.items.motion-density.options.${key}.description`
                )}
              </span>
              <span className="motion-density-preview mt-3 block">
                <span className="motion-density-preview-track">
                  <span className="motion-density-preview-dot" />
                  {Array.from({ length: preview.steps }).map((_, index) => (
                    <span key={index} className="motion-density-preview-step" />
                  ))}
                </span>
              </span>
              <span className="motion-density-option-meta mt-2 flex items-center justify-between gap-2 text-[11px]">
                <span>
                  {t(`customization.items.motion-density.options.${key}.speed`)}
                </span>
                <span>
                  {t(
                    `customization.items.motion-density.options.${key}.duration`
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="motion-density-guide mt-3 rounded-xl border px-4 py-3 text-xs leading-5">
        <span className="motion-density-guide-title font-semibold">
          {t("customization.items.motion-density.guide.title")}
        </span>
        <span className="ml-2">
          {t("customization.items.motion-density.guide.description")}
        </span>
      </div>
    </div>
  );
}
