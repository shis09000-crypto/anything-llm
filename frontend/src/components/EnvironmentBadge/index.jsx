import React, { useEffect, useState } from "react";
import {
  APP_ENVIRONMENT_CHANGE_EVENT,
  getAppEnvironment,
  isDevelopmentEnvironment,
} from "@/utils/appEnvironment";

export default function EnvironmentBadge({ compact = false }) {
  const [appEnv, setAppEnv] = useState(getAppEnvironment());
  const isDevelopment = appEnv === "development";

  useEffect(() => {
    function handleChange(event) {
      setAppEnv(event.detail?.appEnv || getAppEnvironment());
    }

    window.addEventListener(APP_ENVIRONMENT_CHANGE_EVENT, handleChange);
    return () =>
      window.removeEventListener(APP_ENVIRONMENT_CHANGE_EVENT, handleChange);
  }, []);

  const label = isDevelopment ? "DEVELOPMENT" : "PRODUCTION";
  const className = isDevelopmentEnvironment()
    ? "bg-amber-400 text-black border-amber-200 shadow-[0_0_0_1px_rgba(251,191,36,0.4)]"
    : "bg-white/10 text-theme-text-secondary border-white/10 light:bg-slate-300 light:text-slate-700 light:border-slate-400";

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-normal border ${compact ? "max-w-[84px]" : ""} ${className}`}
      title={`Current environment: ${label}`}
    >
      {compact ? label.slice(0, 4) : label}
    </span>
  );
}
