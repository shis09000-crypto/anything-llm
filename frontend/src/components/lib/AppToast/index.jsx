import React, { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  Info,
  Warning,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { dismissToast, subscribeToToasts } from "@/utils/toast";
import "./styles.css";

const TYPE_CONFIG = {
  success: {
    className: "app-toast-success",
    Icon: CheckCircle,
    role: "status",
  },
  info: {
    className: "app-toast-info",
    Icon: Info,
    role: "status",
  },
  warning: {
    className: "app-toast-warning",
    Icon: Warning,
    role: "alert",
  },
  error: {
    className: "app-toast-error",
    Icon: WarningCircle,
    role: "alert",
  },
};

function motionDurationOf(node) {
  if (!node) return 320;
  const value = getComputedStyle(node)
    .getPropertyValue("--app-toast-motion-duration")
    .trim();
  if (!value) return 320;
  if (value.endsWith("ms")) return Number.parseFloat(value) || 320;
  if (value.endsWith("s")) return (Number.parseFloat(value) || 0.32) * 1_000;
  return Number.parseFloat(value) || 320;
}

export function AppToastViewport({ children, className = "", ...props }) {
  return (
    <div
      {...props}
      className={["app-toast-viewport", className].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}

export function AppToastHost() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => subscribeToToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <AppToastViewport
      className="app-toast-host"
      aria-live="polite"
      aria-relevant="additions removals"
    >
      {toasts.map((toast) => (
        <AppToast
          key={toast.id}
          type={toast.type}
          title={toast.title}
          description={toast.description}
          duration={toast.duration}
          closable={toast.closable}
          dismissOnClick={toast.dismissOnClick}
          pauseOnHover={toast.pauseOnHover}
          className={toast.className}
          onClose={() => dismissToast(toast.id)}
        />
      ))}
    </AppToastViewport>
  );
}

export function AppToast({
  type = "info",
  title,
  description,
  duration = 2_600,
  closable = true,
  dismissOnClick = true,
  pauseOnHover = true,
  onClose,
  className = "",
}) {
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.info;
  const toastRef = useRef(null);
  const timeoutRef = useRef(null);
  const leaveTimeoutRef = useRef(null);
  const lastTickRef = useRef(null);
  const closingRef = useRef(false);
  const [remaining, setRemaining] = useState(duration);
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const Icon = config.Icon;
  const hasTimer = Number(duration) > 0;
  const progress = hasTimer
    ? Math.max(0, Math.min(100, (remaining / duration) * 100))
    : 100;

  function closeToast() {
    if (closingRef.current) return;
    closingRef.current = true;
    window.clearTimeout(timeoutRef.current);
    window.clearTimeout(leaveTimeoutRef.current);
    setLeaving(true);
    leaveTimeoutRef.current = window.setTimeout(() => {
      onClose?.();
    }, motionDurationOf(toastRef.current));
  }

  function handleToastClick() {
    if (!dismissOnClick) return;
    closeToast();
  }

  function handleKeyDown(event) {
    if (!dismissOnClick) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    closeToast();
  }

  function handleCloseClick(event) {
    event.stopPropagation();
    closeToast();
  }

  useEffect(() => {
    setRemaining(duration);
    setPaused(false);
    setLeaving(false);
    closingRef.current = false;
    lastTickRef.current = null;
  }, [duration, title, description, type]);

  useEffect(() => {
    if (!hasTimer || paused || leaving) return undefined;

    lastTickRef.current = Date.now();
    timeoutRef.current = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - (lastTickRef.current || now);
      lastTickRef.current = now;
      setRemaining((current) => {
        const next = Math.max(0, current - elapsed);
        if (next === 0) closeToast();
        return next;
      });
    }, 80);

    return () => window.clearInterval(timeoutRef.current);
  }, [hasTimer, paused, leaving]);

  useEffect(() => {
    return () => {
      window.clearTimeout(timeoutRef.current);
      window.clearTimeout(leaveTimeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={toastRef}
      role={config.role}
      tabIndex={dismissOnClick ? 0 : undefined}
      data-state={leaving ? "closing" : "open"}
      data-paused={paused ? "" : undefined}
      className={[
        "app-toast",
        config.className,
        leaving ? "app-toast-closing" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={handleToastClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => pauseOnHover && setPaused(true)}
      onMouseLeave={() => pauseOnHover && setPaused(false)}
    >
      <div className="app-toast-tint" aria-hidden="true" />
      <div className="app-toast-icon" aria-hidden="true">
        <Icon weight="fill" />
      </div>
      <div className="app-toast-content">
        <div className="app-toast-title">{title}</div>
        {description && (
          <div className="app-toast-description">{description}</div>
        )}
      </div>
      {closable && (
        <button
          type="button"
          className="app-toast-close"
          aria-label="关闭通知"
          onClick={handleCloseClick}
        >
          <X weight="bold" />
        </button>
      )}
      <div className="app-toast-progress-track" aria-hidden="true">
        <div
          className="app-toast-progress"
          style={{ transform: `scaleX(${progress / 100})` }}
        />
      </div>
    </div>
  );
}

export default AppToast;
