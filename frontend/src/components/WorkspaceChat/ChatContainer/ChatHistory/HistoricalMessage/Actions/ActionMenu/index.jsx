import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Trash, DotsThreeVertical, TreeView } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

const MENU_WIDTH = 112;
const MENU_HEIGHT = 76;
const MENU_GAP = 6;
const VIEWPORT_PADDING = 8;

function ActionMenu({
  chatId,
  publicChatId = null,
  forkThread,
  isEditing,
  role,
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const updateMenuPosition = useCallback(() => {
    if (typeof window === "undefined") return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      window.innerWidth - MENU_WIDTH - VIEWPORT_PADDING
    );
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - MENU_HEIGHT - VIEWPORT_PADDING
    );
    const preferredRight = rect.right + MENU_GAP;
    const preferredLeft = rect.left - MENU_WIDTH - MENU_GAP;
    const left =
      preferredRight <= maxLeft
        ? preferredRight
        : Math.max(VIEWPORT_PADDING, preferredLeft);

    setMenuPosition({
      left: `${Math.min(Math.max(VIEWPORT_PADDING, left), maxLeft)}px`,
      top: `${Math.min(Math.max(VIEWPORT_PADDING, rect.top - 4), maxTop)}px`,
    });
  }, []);

  const toggleMenu = () => {
    if (!open) updateMenuPosition();
    setOpen((current) => !current);
  };

  const handleFork = () => {
    forkThread(chatId, publicChatId);
    setOpen(false);
  };

  const handleDelete = () => {
    window.dispatchEvent(
      new CustomEvent("delete-message", {
        detail: { chatId, publicChatId, role },
      })
    );
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event) => {
      if (buttonRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, updateMenuPosition]);

  if (!chatId || isEditing || role === "user") return null;

  return (
    <div className="mt-2 -ml-0.5 relative">
      <button
        ref={buttonRef}
        onClick={toggleMenu}
        className="border-none text-zinc-300 light:text-slate-500 motion-hover"
        data-tooltip-id="action-menu"
        data-tooltip-content={t("chat_window.more_actions")}
        aria-label={t("chat_window.more_actions")}
      >
        <DotsThreeVertical size={24} weight="bold" />
      </button>
      {open &&
        menuPosition &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed border-[1.5px] border-white/40 rounded-lg bg-theme-action-menu-bg flex flex-col shadow-[0_4px_14px_rgba(0,0,0,0.25)] text-white z-[9999]"
            style={{ ...menuPosition, minWidth: `${MENU_WIDTH}px` }}
          >
            <button
              onClick={handleFork}
              className="border-none rounded-t-lg flex items-center text-white gap-x-2 hover:bg-theme-action-menu-item-hover py-1.5 px-2 motion-hover w-full text-left"
            >
              <TreeView size={18} />
              <span className="text-sm">{t("chat_window.fork")}</span>
            </button>
            <button
              onClick={handleDelete}
              className="border-none flex rounded-b-lg items-center text-white gap-x-2 hover:bg-theme-action-menu-item-hover py-1.5 px-2 motion-hover w-full text-left"
            >
              <Trash size={18} />
              <span className="text-sm">{t("chat_window.delete")}</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

export default ActionMenu;
