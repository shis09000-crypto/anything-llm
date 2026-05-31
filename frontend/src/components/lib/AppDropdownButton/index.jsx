import React, {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, SpinnerGap } from "@phosphor-icons/react";
import "./styles.css";

const SIZE_CLASSES = {
  sm: "app-dropdown-button-size-sm",
  md: "app-dropdown-button-size-md",
  lg: "app-dropdown-button-size-lg",
};

const AppDropdownButton = forwardRef(function AppDropdownButton(
  {
    children,
    open = false,
    size = "md",
    icon = null,
    iconOnly = false,
    menu = null,
    menuClassName = "",
    menuStyle = null,
    menuWidth = null,
    menuMinWidth = 190,
    portalMenu = false,
    disabled = false,
    loading = false,
    fullWidth = false,
    className = "",
    type = "button",
    onClick,
    onOpenChange,
    ...props
  },
  forwardedRef
) {
  const isDisabled = disabled || loading;
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.md;
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [portalMenuStyle, setPortalMenuStyle] = useState(null);

  const setButtonRef = useCallback(
    (node) => {
      buttonRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef]
  );

  const updatePortalMenuPosition = useCallback(() => {
    if (!portalMenu || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(buttonRef.current);
    const gap =
      parseFloat(computedStyle.getPropertyValue("--app-dropdown-menu-gap")) ||
      5;
    const minWidth = Number(menuMinWidth) || 190;
    const width = Math.max(Number(menuWidth) || rect.width, minWidth);
    const anchorCenter = rect.left + rect.width / 2;
    const viewportPadding = 12;
    const left = Math.min(
      Math.max(anchorCenter, width / 2 + viewportPadding),
      window.innerWidth - width / 2 - viewportPadding
    );

    setPortalMenuStyle({
      position: "fixed",
      top: `${rect.bottom + gap}px`,
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(
        160,
        window.innerHeight - rect.bottom - gap - viewportPadding
      )}px`,
      overflowY: "auto",
      "--app-dropdown-menu-arrow-left": `${anchorCenter - left + width / 2}px`,
    });
  }, [menuMinWidth, menuWidth, portalMenu]);

  useLayoutEffect(() => {
    if (!open || !portalMenu) return;
    updatePortalMenuPosition();
    const frame = window.requestAnimationFrame(updatePortalMenuPosition);
    window.addEventListener("resize", updatePortalMenuPosition);
    window.addEventListener("scroll", updatePortalMenuPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePortalMenuPosition);
      window.removeEventListener("scroll", updatePortalMenuPosition, true);
    };
  }, [open, portalMenu, updatePortalMenuPosition]);

  useEffect(() => {
    if (!open || !onOpenChange) return;

    function handlePointerDown(event) {
      if (
        buttonRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      onOpenChange(false);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") onOpenChange(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  function handleClick(event) {
    if (isDisabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  const menuNode = useMemo(() => {
    if (!open || !menu) return null;
    return (
      <div
        ref={menuRef}
        className={[
          "app-dropdown-button-menu",
          portalMenu ? "app-dropdown-button-menu-portal" : "",
          menuClassName,
        ]
          .filter(Boolean)
          .join(" ")}
        role="menu"
        style={portalMenu ? { ...portalMenuStyle, ...menuStyle } : menuStyle}
      >
        {menu}
      </div>
    );
  }, [menu, menuClassName, menuStyle, open, portalMenu, portalMenuStyle]);

  return (
    <span
      className={[
        "app-dropdown-button-wrap",
        fullWidth ? "app-dropdown-button-full-width" : "",
        iconOnly ? "app-dropdown-button-wrap-icon-only" : "",
        open ? "app-dropdown-button-wrap-open" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        {...props}
        ref={setButtonRef}
        type={type}
        disabled={isDisabled}
        aria-expanded={open}
        aria-haspopup={menu ? "menu" : undefined}
        aria-busy={loading ? true : undefined}
        data-loading={loading ? "" : undefined}
        onClick={handleClick}
        className={[
          "app-dropdown-button",
          sizeClass,
          open ? "app-dropdown-button-open" : "",
          isDisabled ? "app-dropdown-button-disabled" : "",
          iconOnly ? "app-dropdown-button-icon-only" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {icon && <span className="app-dropdown-button-icon">{icon}</span>}
        {!iconOnly && (
          <span className="app-dropdown-button-label">{children}</span>
        )}
        {!iconOnly && (
          <span className="app-dropdown-button-caret" aria-hidden="true">
            {loading ? (
              <SpinnerGap
                weight="bold"
                className="app-dropdown-button-spinner"
              />
            ) : (
              <CaretDown weight="bold" />
            )}
          </span>
        )}
      </button>
      {portalMenu && menuNode && typeof document !== "undefined"
        ? createPortal(menuNode, document.body)
        : menuNode}
    </span>
  );
});

function DropdownItem({
  children,
  icon = null,
  disabled = false,
  className = "",
  type = "button",
  onClick,
  ...props
}) {
  function handleClick(event) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  }

  return (
    <button
      {...props}
      type={type}
      role="menuitem"
      disabled={disabled}
      onClick={handleClick}
      className={["app-dropdown-button-menu-item", className]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && (
        <span className="app-dropdown-button-menu-item-icon">{icon}</span>
      )}
      <span>{children}</span>
    </button>
  );
}

AppDropdownButton.Item = DropdownItem;

export default AppDropdownButton;
