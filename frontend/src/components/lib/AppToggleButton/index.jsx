import React, { forwardRef } from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import "./styles.css";

const SIZE_CLASSES = {
  sm: "app-toggle-button-size-sm",
  md: "app-toggle-button-size-md",
  lg: "app-toggle-button-size-lg",
};

const AppToggleButton = forwardRef(function AppToggleButton(
  {
    children,
    selected = false,
    size = "md",
    icon = null,
    disabled = false,
    loading = false,
    fullWidth = false,
    className = "",
    type = "button",
    onClick,
    ...props
  },
  ref
) {
  const isDisabled = disabled || loading;
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;

  function handleClick(event) {
    if (isDisabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-pressed={selected}
      aria-busy={loading ? true : undefined}
      data-loading={loading ? "" : undefined}
      onClick={handleClick}
      className={[
        "app-toggle-button",
        sizeClass,
        selected ? "app-toggle-button-selected" : "",
        isDisabled ? "app-toggle-button-disabled" : "",
        fullWidth ? "app-toggle-button-full-width" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {(icon || loading) && (
        <span className="app-toggle-button-icon" aria-hidden="true">
          {loading ? (
            <SpinnerGap weight="bold" className="app-toggle-button-spinner" />
          ) : (
            icon
          )}
        </span>
      )}
      <span className="app-toggle-button-label">{children}</span>
    </button>
  );
});

export default AppToggleButton;
