import React, { useContext, useEffect, useRef, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { mobileShellRuntimeActive } from "@/utils/mobileRuntime";
import { Outlet } from "react-router-dom";
import { SoftSettingsShellContext } from "./context";
import { FullScreenLoader } from "@/components/Preloader";
import "./styles.css";

export function SoftSettingsOutletLayout() {
  const isMobileShell = mobileShellRuntimeActive();

  return (
    <div className="settings-soft-page">
      <Sidebar />
      <main
        style={{ height: isMobileShell ? "100%" : "calc(100% - 32px)" }}
        className="settings-soft-main"
      >
        <SoftSettingsShellContext.Provider value={true}>
          <React.Suspense fallback={<FullScreenLoader />}>
            <Outlet />
          </React.Suspense>
        </SoftSettingsShellContext.Provider>
      </main>
    </div>
  );
}

export function SoftSettingsLayout({
  title,
  description,
  actions = null,
  children,
  className = "",
  contentClassName = "",
}) {
  const hasPersistentShell = useContext(SoftSettingsShellContext);
  const isMobileShell = mobileShellRuntimeActive();
  const pageContent = (
    <div className={`settings-soft-content ${contentClassName}`}>
      {(title || description || actions) && (
        <SoftSettingsPageHeader
          title={title}
          description={description}
          actions={actions}
        />
      )}
      {children}
    </div>
  );

  if (hasPersistentShell) return pageContent;

  return (
    <div className={`settings-soft-page ${className}`}>
      <Sidebar />
      <main
        style={{ height: isMobileShell ? "100%" : "calc(100% - 32px)" }}
        className="settings-soft-main"
      >
        {pageContent}
      </main>
    </div>
  );
}

export function SoftSettingsPageHeader({ title, description, actions = null }) {
  return (
    <header className="settings-soft-header">
      <div className="min-w-0">
        {title && <h1 className="settings-soft-title">{title}</h1>}
        {description && (
          <p className="settings-soft-description">{description}</p>
        )}
      </div>
      {actions && <div className="settings-soft-header-actions">{actions}</div>}
    </header>
  );
}

export function SoftCard({
  children,
  title,
  description,
  actions = null,
  className = "",
}) {
  return (
    <section className={`settings-soft-card ${className}`}>
      {(title || description || actions) && (
        <div className="settings-soft-card-header">
          <div className="min-w-0">
            {title && <h2 className="settings-soft-card-title">{title}</h2>}
            {description && (
              <p className="settings-soft-card-description">{description}</p>
            )}
          </div>
          {actions && (
            <div className="settings-soft-card-actions">{actions}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

export function SoftSettingRow({
  title,
  description,
  children,
  className = "",
}) {
  return (
    <div className={`settings-soft-row ${className}`}>
      <div className="settings-soft-row-copy">
        <p className="settings-soft-row-title">{title}</p>
        {description && (
          <p className="settings-soft-row-description">{description}</p>
        )}
      </div>
      <div className="settings-soft-row-control">{children}</div>
    </div>
  );
}

export function SoftButton({
  children,
  variant = "gradient",
  size = "md",
  className = "",
  type = "button",
  disabled = false,
  ...props
}) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      className={[
        "settings-soft-button",
        `settings-soft-button-${variant}`,
        `settings-soft-button-${size}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
}

export function SoftProviderTrigger({
  logo,
  name,
  description,
  fallbackLogo,
  onClick,
  children,
}) {
  return (
    <button
      type="button"
      className="settings-soft-provider-trigger"
      onClick={onClick}
    >
      <span className="settings-soft-provider-copy">
        <span className="settings-soft-provider-logo-wrap">
          <img
            src={logo || fallbackLogo}
            alt={`${name || "Provider"} logo`}
            className="settings-soft-provider-logo"
          />
        </span>
        <span className="min-w-0 text-left">
          <span className="settings-soft-provider-name">
            {name || "None selected"}
          </span>
          <span className="settings-soft-provider-description">
            {description}
          </span>
        </span>
      </span>
      {children}
    </button>
  );
}

export function SoftProviderDropdown({ open, children }) {
  const [shouldRender, setShouldRender] = useState(open);
  const [isClosing, setIsClosing] = useState(false);
  const dropdownRef = useRef(null);
  const hasScrolledForOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }

    if (!shouldRender) return;
    hasScrolledForOpenRef.current = false;
    setIsClosing(true);
    const timeout = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
    }, 140);

    return () => window.clearTimeout(timeout);
  }, [open, shouldRender]);

  useEffect(() => {
    if (!open || !shouldRender || hasScrolledForOpenRef.current) return;
    hasScrolledForOpenRef.current = true;

    const frame = window.requestAnimationFrame(() => {
      const selected = dropdownRef.current?.querySelector(
        ".settings-soft-provider-option.is-selected"
      );
      selected?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open, shouldRender]);

  if (!shouldRender) return null;

  return (
    <div
      ref={dropdownRef}
      className={`settings-soft-provider-menu ${
        isClosing ? "is-closing" : "is-opening"
      }`}
    >
      {children}
    </div>
  );
}

export function SoftModalSurface({ children, className = "" }) {
  return <div className={`settings-soft-modal ${className}`}>{children}</div>;
}
