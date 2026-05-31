import React, { forwardRef } from "react";
import "./styles.css";

const VARIANT_CLASSES = {
  primary: "app-button-primary",
  secondary: "app-button-secondary",
};

const SIZE_CLASSES = {
  sm: "app-button-size-sm",
  md: "app-button-size-md",
  lg: "app-button-size-lg",
};

const AppButton = forwardRef(function AppButton(
  {
    children,
    variant = "primary",
    size = "md",
    disabled = false,
    loading = false,
    selected = false,
    iconOnly = false,
    leftIcon = null,
    rightIcon = null,
    fullWidth = false,
    className = "",
    type = "button",
    onClick,
    ...props
  },
  ref
) {
  const isDisabled = disabled || loading;
  const variantClass = VARIANT_CLASSES[variant] || VARIANT_CLASSES.primary;
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
      aria-busy={loading ? true : undefined}
      aria-pressed={selected ? true : undefined}
      data-selected={selected ? "" : undefined}
      data-loading={loading ? "" : undefined}
      onClick={handleClick}
      className={[
        "app-button",
        variantClass,
        sizeClass,
        fullWidth ? "app-button-full-width" : "",
        iconOnly ? "app-button-icon-only" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="app-button-content">
        {leftIcon && <span className="app-button-icon">{leftIcon}</span>}
        {!iconOnly && children}
        {rightIcon && <span className="app-button-icon">{rightIcon}</span>}
      </span>
      {loading && <span className="app-button-spinner" aria-hidden="true" />}
    </button>
  );
});

export default AppButton;
