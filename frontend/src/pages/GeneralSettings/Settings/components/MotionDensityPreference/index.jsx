import { MOTION_DENSITIES, useMotion } from "@/contexts/MotionProvider";
const MOTION_DENSITY_DESCRIPTIONS = {
  minimal: "Shorter, calmer motion for the most restrained interface.",
  balanced: "The default product rhythm: polished, stable, and quiet.",
  expressive:
    "Slightly fuller motion while staying within performance budgets.",
};
export default function MotionDensityPreference() {
  const { motionDensity, setMotionDensity } = useMotion();
  return (
    <div className="flex flex-col gap-y-0.5 my-4">
      {" "}
      <p className="text-sm leading-6 font-semibold text-white">
        {" "}
        Motion density{" "}
      </p>{" "}
      <p className="text-xs text-white/60">
        {" "}
        Controls animation strength and pacing across route, panel, modal, and
        micro interactions.{" "}
      </p>{" "}
      <div className="flex flex-col gap-2 mt-3 md:flex-row">
        {" "}
        {Object.entries(MOTION_DENSITIES).map(([key, label]) => {
          const active = motionDensity === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setMotionDensity(key)}
              className={`motion-pressable rounded-lg border px-4 py-3 text-left md:w-[220px] ${active ? "border-primary-button bg-primary-button/10 text-white" : "border-white/10 bg-theme-settings-input-bg text-white/80 hover:border-primary-button/70 hover:text-white"}`}
            >
              {" "}
              <span className="block text-sm font-semibold">{label}</span>{" "}
              <span className="mt-1 block text-xs leading-5 text-white/60">
                {" "}
                {MOTION_DENSITY_DESCRIPTIONS[key]}{" "}
              </span>{" "}
            </button>
          );
        })}{" "}
      </div>{" "}
    </div>
  );
}
