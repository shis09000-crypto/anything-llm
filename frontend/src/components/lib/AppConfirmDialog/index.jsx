import React, { useEffect, useId, useRef } from "react";
import "./styles.css";

const TONE_CLASSES = {
  default: "app-confirm-dialog-default",
  info: "app-confirm-dialog-info",
  warning: "app-confirm-dialog-warning",
  danger: "app-confirm-dialog-danger",
};

export default function AppConfirmDialog({
  open = false,
  tone = "default",
  title = "",
  description = "",
  icon = null,
  children = null,
  footer = null,
  loading = false,
  closeOnBackdrop = false,
  closeOnEscape = false,
  className = "",
  onClose,
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const toneClass = TONE_CLASSES[tone] || TONE_CLASSES.default;

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape, onClose, open]);

  if (!open) return null;

  function handleOverlayMouseDown(event) {
    if (!closeOnBackdrop || event.target !== event.currentTarget) return;
    onClose?.();
  }

  return (
    <div
      className="app-confirm-dialog-overlay"
      onMouseDown={handleOverlayMouseDown}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={loading ? true : undefined}
        tabIndex={-1}
        data-loading={loading ? "" : undefined}
        className={["app-confirm-dialog", toneClass, className]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="app-confirm-dialog-sheen" aria-hidden="true" />
        {icon && <div className="app-confirm-dialog-icon">{icon}</div>}
        {title && (
          <h2 id={titleId} className="app-confirm-dialog-title">
            {title}
          </h2>
        )}
        {description && (
          <p id={descriptionId} className="app-confirm-dialog-description">
            {description}
          </p>
        )}
        {children && <div className="app-confirm-dialog-body">{children}</div>}
        {footer && <div className="app-confirm-dialog-footer">{footer}</div>}
      </section>
    </div>
  );
}
