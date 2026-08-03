import { useSoftSettingsShell } from "@/components/SoftSettings/context";
import { isPersistentSettingsRoute } from "@/utils/settingsRoutes";
import "./Preloader.css";

function loaderSize(size) {
  if (typeof size === "number" && Number.isFinite(size)) return size * 4;
  const numeric = Number(size);
  if (Number.isFinite(numeric)) return numeric * 4;
  return 64;
}

export function AthenaLoadingMark({ size = 64, compact = false }) {
  return (
    <span
      className={`athena-loading-mark ${compact ? "is-compact" : ""}`}
      style={{ "--athena-loader-size": `${size}px` }}
      aria-hidden="true"
    >
      <span className="athena-loading-halo" />
      <span className="athena-loading-orbit athena-loading-orbit-outer">
        <span className="athena-loading-orbit-node" />
      </span>
      <span className="athena-loading-orbit athena-loading-orbit-inner">
        <span className="athena-loading-orbit-node" />
      </span>
      <span className="athena-loading-core">
        <span className="athena-loading-core-glint" />
      </span>
      <span className="athena-loading-ripple" />
    </span>
  );
}

export default function PreLoader({ size = "16" }) {
  const sizePx = loaderSize(size);
  return (
    <span className="athena-inline-loader" role="status" aria-label="正在加载">
      <AthenaLoadingMark size={sizePx} compact={sizePx <= 28} />
    </span>
  );
}

function LoaderSurface({ embedded = false, settings = false }) {
  return (
    <div
      id={embedded ? undefined : "preloader"}
      className={`athena-loader-surface ${embedded ? "is-embedded" : "is-fullscreen"} ${settings ? "is-settings" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="正在准备 Athena"
    >
      <div className="athena-loader-ambient" aria-hidden="true" />
      <div className="athena-loader-content">
        <AthenaLoadingMark size={embedded ? 48 : settings ? 56 : 64} />
        {!embedded ? (
          <div className="athena-loader-copy" aria-hidden="true">
            <span className="athena-loader-wordmark">ATHENA</span>
            <span className="athena-loader-progress-pulses">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function FullScreenLoader({ surface = null }) {
  const hasPersistentSettingsShell = useSoftSettingsShell();
  const isSettingsSurface =
    surface === "settings" ||
    (typeof window !== "undefined" &&
      isPersistentSettingsRoute(window.location.pathname));

  if (hasPersistentSettingsShell) {
    return <LoaderSurface embedded settings />;
  }

  return <LoaderSurface settings={isSettingsSurface} />;
}
