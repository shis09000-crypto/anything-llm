import React, { useCallback, useEffect, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import paths from "@/utils/paths";
import { Tooltip } from "react-tooltip";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useWorkspaceLayout } from "@/contexts/WorkspaceLayoutProvider";
import {
  LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY,
  readSidebarCollapsed,
} from "@/utils/layout/workspaceLayoutState";
export const SIDEBAR_TOGGLE_STORAGE_KEY = LEGACY_SIDEBAR_TOGGLE_STORAGE_KEY;
export const SIDEBAR_TOGGLE_EVENT = "sidebar-toggle";
export const SIDEBAR_SET_STATE_EVENT = "sidebar-set-state";

/**
 * Returns the previous state of the sidebar from localStorage.
 * If the sidebar was closed, returns false.
 * If the sidebar was open, returns true.
 * If the sidebar state is not set, returns true.
 * @returns {boolean}
 */
export function previousSidebarState() {
  return !readSidebarCollapsed();
}

export function useSidebarToggle() {
  const location = useLocation();
  const workspaceLayout = useWorkspaceLayout();
  const layoutState = workspaceLayout?.layoutState;
  const dispatchLayoutEvent = workspaceLayout?.dispatchLayoutEvent;
  const showSidebar = !(workspaceLayout?.effectiveSidebarCollapsed ?? false);
  const [canToggleSidebar, setCanToggleSidebar] = useState(true);
  const setShowSidebar = useCallback(
    (next) => {
      const nextOpen = typeof next === "function" ? next(showSidebar) : next;
      dispatchLayoutEvent?.({
        type: "SIDEBAR_TOGGLED",
        collapsed: !nextOpen,
        workspaceId: layoutState?.workspaceId || null,
      });
    },
    [dispatchLayoutEvent, layoutState?.workspaceId, showSidebar]
  );

  useEffect(() => {
    const currentPath = location.pathname;
    const isVisible =
      currentPath === paths.home() ||
      /^\/workspace\/[^\/]+$/.test(currentPath) ||
      /^\/workspace\/[^\/]+\/t\/[^\/]+$/.test(currentPath);
    setCanToggleSidebar(isVisible);
  }, [location.pathname]);

  useEffect(() => {
    function toggleSidebar(e) {
      if (!canToggleSidebar) return;
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "s"
      ) {
        setShowSidebar((prev) => {
          return !prev;
        });
      }
    }
    window.addEventListener("keydown", toggleSidebar);
    return () => {
      window.removeEventListener("keydown", toggleSidebar);
    };
  }, [canToggleSidebar, setShowSidebar]);

  useEffect(() => {
    function setSidebarState(e) {
      if (!canToggleSidebar) return;
      const open = e?.detail?.open;
      if (typeof open !== "boolean") return;
      setShowSidebar(open);
    }

    window.addEventListener(SIDEBAR_SET_STATE_EVENT, setSidebarState);
    return () => {
      window.removeEventListener(SIDEBAR_SET_STATE_EVENT, setSidebarState);
    };
  }, [canToggleSidebar, setShowSidebar]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(SIDEBAR_TOGGLE_EVENT, {
        detail: { open: showSidebar },
      })
    );
  }, [showSidebar]);

  return { showSidebar, setShowSidebar, canToggleSidebar };
}

export function ToggleSidebarButton({ showSidebar, setShowSidebar }) {
  const { t } = useTranslation();
  const isMac = navigator.userAgent.includes("Mac");
  const shortcut = isMac ? "⌘ + Shift + S" : "Ctrl + Shift + S";
  const tooltip = showSidebar
    ? t("common.controls.hideSidebar", { shortcut })
    : t("common.controls.showSidebar", { shortcut });

  return (
    <>
      <button
        type="button"
        className={`hidden md:block border-none bg-transparent outline-none ring-0 absolute motion-hover z-10 ${showSidebar ? "top-[18px] left-[248px]" : "top-[20px] left-[30px]"}`}
        onClick={() => setShowSidebar((prev) => !prev)}
        data-tooltip-id="sidebar-toggle"
        data-tooltip-content={tooltip}
        aria-label={tooltip}
      >
        <SidebarSimple
          className="text-theme-text-secondary hover:text-theme-text-primary"
          size={24}
        />
      </button>
      <Tooltip
        id="sidebar-toggle"
        place="top"
        delayShow={300}
        className="tooltip !text-xs z-99"
      />
    </>
  );
}
