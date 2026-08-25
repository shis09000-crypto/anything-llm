import {
  CaretRight,
  File,
  ListChecks,
  Plus,
  Question,
  Target,
  Wrench,
} from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { useTranslation } from "react-i18next";
import { forwardRef, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useParams } from "react-router-dom";
import Workspace from "@/models/workspace";
import {
  ATTACHMENTS_PROCESSED_EVENT,
  REMOVE_ATTACHMENT_EVENT,
} from "../../DnDWrapper";
import ParsedFilesMenu from "./ParsedFilesMenu";
import { optimisticActionCenter } from "@/utils/optimistic/optimisticActionCenter";
import { COMPOSER_ADD_MENU_ITEMS } from "@/utils/chat/composerAddMenu";
import { useTheme } from "@/hooks/useTheme";

/**
 * This is a simple proxy component that clicks on the DnD file uploader for the user.
 * @returns
 */
export default function AttachItem({
  workspaceSlug = null,
  workspaceThreadSlug = null,
  activeGoal = null,
  planActive = false,
  quizModeActive = false,
  onGoal,
  onReplaceGoal,
  onPlan,
  onTools,
  onTest,
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const params = useParams();
  const slug = workspaceSlug || params.slug;
  const threadSlug = workspaceThreadSlug ?? params.threadSlug ?? null;
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const tooltipRef = useRef(null);
  const itemRefs = useRef([]);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [files, setFiles] = useState([]);
  const [currentTokens, setCurrentTokens] = useState(0);
  const [contextWindow, setContextWindow] = useState(Infinity);
  const [showMenu, setShowMenu] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const [, setHighlightedIndex] = useState(-1);
  const [isLoading, setIsLoading] = useState(false);
  const hasFetchedRef = useRef(false);
  const inFlightRef = useRef(null);
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const fetchFiles = ({ force = false } = {}) => {
    if (!slug) return;
    if (isEmbedding) return;
    if (!force && hasFetchedRef.current) return;
    if (inFlightRef.current) return inFlightRef.current;
    setIsLoading(true);
    const request = Workspace.getParsedFiles(slug, threadSlug)
      .then(({ files, contextWindow, currentContextTokenCount }) => {
        hasFetchedRef.current = true;
        setFiles(files);
        setShowTooltip(files.length > 0);
        setContextWindow(contextWindow);
        setCurrentTokens(currentContextTokenCount);
      })
      .finally(() => {
        inFlightRef.current = null;
        setIsLoading(false);
      });
    inFlightRef.current = request;
    return request;
  };

  /**
   * Handles the removal of an attachment from the parsed files
   * and triggers a re-fetch of the parsed files.
   * This function handles when the user clicks the X on an Attachment via the AttachmentManager
   * so we need to sync the state in the ParsedFilesMenu picker here.
   */
  async function handleRemoveAttachment(e) {
    const { document } = e.detail;
    if (!document?.id) return;
    const previousFiles = filesRef.current;
    const action = optimisticActionCenter.run({
      type: "chat.attachment.remove",
      scope: {
        route: "workspace-chat",
        workspaceSlug: slug,
        threadSlug,
        fileId: document.id,
        surface: "prompt-attachments",
      },
      priority: "P1",
      policy: "visible",
      intentRank: 0,
      protected: true,
      abortable: false,
      label: "optimistic:chat-attachment-remove",
      dedupeKey: `optimistic:attachment-remove:${slug}:${document.id}`,
      optimisticPatch: () =>
        setFiles((current) =>
          current.filter((file) => file.id !== document.id)
        ),
      rollbackPatch: () => setFiles(previousFiles),
      serverCall: async ({ signal }) => {
        const ok = await Workspace.deleteParsedFiles(slug, [document.id], {
          signal,
          task: false,
        });
        if (!ok) throw new Error("Attachment removal failed");
        return true;
      },
    });
    const outcome = await action.promise;
    if (outcome.ok) fetchFiles({ force: true });
  }

  /**
   * Handles the click event for the attach item button.
   * @param {MouseEvent} e - The click event.
   * @returns {void}
   */
  function handleClick(e) {
    e?.target?.blur();
    document?.getElementById("dnd-chat-file-uploader")?.click();
    return;
  }

  function positionMenu() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(360, Math.max(260, window.innerWidth - 24));
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - width - 12)
    );
    setMenuStyle({
      position: "fixed",
      left,
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
      width,
    });
  }

  useEffect(() => {
    if (!showMenu) return;
    positionMenu();
    fetchFiles();
    const closeOutside = (event) => {
      if (buttonRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setShowMenu(false);
      setShowFiles(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowMenu(false);
        setShowFiles(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((current) => {
          const next =
            current < 0
              ? event.key === "ArrowDown"
                ? 0
                : COMPOSER_ADD_MENU_ITEMS.length - 1
              : event.key === "ArrowDown"
                ? (current + 1) % COMPOSER_ADD_MENU_ITEMS.length
                : (current + COMPOSER_ADD_MENU_ITEMS.length - 1) %
                  COMPOSER_ADD_MENU_ITEMS.length;
          itemRefs.current[next]?.focus();
          return next;
        });
      }
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [showMenu]);

  useEffect(() => {
    hasFetchedRef.current = false;
    setFiles([]);
    setShowTooltip(false);
    const handleAttachmentsProcessed = () => fetchFiles({ force: true });
    window.addEventListener(
      ATTACHMENTS_PROCESSED_EVENT,
      handleAttachmentsProcessed
    );
    window.addEventListener(REMOVE_ATTACHMENT_EVENT, handleRemoveAttachment);
    return () => {
      window.removeEventListener(
        ATTACHMENTS_PROCESSED_EVENT,
        handleAttachmentsProcessed
      );
      window.removeEventListener(
        REMOVE_ATTACHMENT_EVENT,
        handleRemoveAttachment
      );
    };
  }, [slug, threadSlug]);

  return (
    <>
      <button
        id="attach-item-btn"
        data-tooltip-id={
          showTooltip ? "tooltip-attach-item-btn" : "attach-item-btn"
        }
        data-tooltip-content={
          !showTooltip
            ? t("chat_window.controls.upload.description")
            : undefined
        }
        aria-label={t("chat_window.controls.upload.description")}
        type="button"
        onClick={handleClick}
        onPointerEnter={fetchFiles}
        onFocus={fetchFiles}
        className="group border-none relative flex md:hidden justify-center items-center cursor-pointer w-6 h-6 rounded-full hover:bg-zinc-700 light:hover:bg-slate-200"
      >
        <div className="relative">
          <Plus
            size={18}
            className="pointer-events-none text-zinc-300 light:text-slate-600 group-hover:text-white light:group-hover:text-slate-600 shrink-0"
            weight="bold"
          />
          {files.length > 0 && (
            <div className="absolute -top-2.5 -right-2 bg-white text-black light:invert text-[8px] rounded-full px-1 flex items-center justify-center">
              {files.length}
            </div>
          )}
        </div>
      </button>
      {showTooltip && (
        <Tooltip
          ref={tooltipRef}
          id="tooltip-attach-item-btn"
          place="top"
          opacity={1}
          clickable={!isEmbedding}
          delayShow={300}
          delayHide={isEmbedding ? 999999 : 800}
          arrowColor={
            theme === "light"
              ? "var(--theme-modal-border)"
              : "var(--theme-bg-primary)"
          }
          className="z-99 !w-[400px] !bg-theme-bg-primary !px-[5px] !rounded-lg !pointer-events-auto md:!hidden light:border-2 light:border-theme-modal-border"
        >
          <ParsedFilesMenu
            onEmbeddingChange={setIsEmbedding}
            tooltipRef={tooltipRef}
            isLoading={isLoading}
            files={files}
            setFiles={setFiles}
            currentTokens={currentTokens}
            setCurrentTokens={setCurrentTokens}
            contextWindow={contextWindow}
            workspaceSlug={slug}
            threadSlug={threadSlug}
          />
        </Tooltip>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setShowMenu((open) => !open);
          setShowFiles(false);
          setHighlightedIndex(-1);
        }}
        aria-haspopup="menu"
        aria-expanded={showMenu}
        aria-label={t("chat_window.controls.composerMenu.open", {
          defaultValue: "Add to message",
        })}
        className="group hidden md:flex border-none relative justify-center items-center cursor-pointer w-6 h-6 rounded-full hover:bg-zinc-700 light:hover:bg-slate-200"
      >
        <Plus
          size={18}
          className="pointer-events-none text-zinc-300 light:text-slate-600"
          weight="bold"
        />
        {files.length > 0 && (
          <span className="absolute -top-2.5 -right-2 bg-white text-black light:invert text-[8px] rounded-full px-1">
            {files.length}
          </span>
        )}
      </button>
      {showMenu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={t("chat_window.controls.composerMenu.open", {
              defaultValue: "Add to message",
            })}
            style={menuStyle}
            className="z-[9999] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 p-1.5 text-white shadow-2xl backdrop-blur-xl light:border-slate-200 light:bg-white/95 light:text-slate-800"
          >
            <MenuRow
              ref={(node) => (itemRefs.current[0] = node)}
              icon={File}
              label={t("chat_window.controls.composerMenu.file", {
                defaultValue: "File",
              })}
              onClick={() => {
                setShowMenu(false);
                handleClick();
              }}
              trailing={
                files.length > 0 ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowFiles((open) => !open);
                    }}
                    className="flex items-center gap-1 rounded-full border-none bg-white/10 px-2 py-0.5 text-[11px] text-white/70 light:bg-slate-100 light:text-slate-600"
                  >
                    {files.length}
                    <CaretRight size={12} />
                  </button>
                ) : null
              }
            />
            {showFiles && files.length > 0 && (
              <div className="max-h-[320px] overflow-auto border-y border-white/10 px-1 py-1 light:border-slate-200">
                <ParsedFilesMenu
                  onEmbeddingChange={setIsEmbedding}
                  tooltipRef={null}
                  isLoading={isLoading}
                  files={files}
                  setFiles={setFiles}
                  currentTokens={currentTokens}
                  setCurrentTokens={setCurrentTokens}
                  contextWindow={contextWindow}
                  workspaceSlug={slug}
                  threadSlug={threadSlug}
                />
              </div>
            )}
            <MenuRow
              ref={(node) => (itemRefs.current[1] = node)}
              icon={Target}
              label={t("chat_window.controls.composerMenu.goal", {
                defaultValue: "Goal",
              })}
              active={!!activeGoal}
              disabled={!threadSlug}
              onClick={() => {
                onGoal?.();
                setShowMenu(false);
              }}
              trailing={
                activeGoal ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onReplaceGoal?.();
                      setShowMenu(false);
                    }}
                    className="rounded-md border-none bg-white/10 px-2 py-1 text-[11px] text-white/70 light:bg-slate-100 light:text-slate-600"
                  >
                    {t("chat_window.controls.composerMenu.replaceGoal", {
                      defaultValue: "Replace",
                    })}
                  </button>
                ) : null
              }
            />
            <MenuRow
              ref={(node) => (itemRefs.current[2] = node)}
              icon={ListChecks}
              label={t("chat_window.controls.composerMenu.plan", {
                defaultValue: "Plan",
              })}
              active={planActive}
              onClick={() => {
                onPlan?.();
                setShowMenu(false);
              }}
            />
            <MenuRow
              ref={(node) => (itemRefs.current[3] = node)}
              icon={Wrench}
              label={t("chat_window.controls.composerMenu.tools", {
                defaultValue: "Tools",
              })}
              onClick={() => {
                onTools?.();
                setShowMenu(false);
              }}
            />
            <MenuRow
              ref={(node) => (itemRefs.current[4] = node)}
              icon={Question}
              label={t("chat_window.controls.composerMenu.test", {
                defaultValue: "Test",
              })}
              active={quizModeActive}
              onClick={() => {
                onTest?.();
                setShowMenu(false);
              }}
            />
          </div>,
          document.body
        )}
    </>
  );
}

const MenuRow = forwardRef(function MenuRow(
  {
    icon: Icon,
    label,
    active = false,
    disabled = false,
    onClick,
    trailing = null,
  },
  ref
) {
  return (
    <div
      className={`flex w-full items-center rounded-xl ${
        active
          ? "bg-sky-500/15 text-sky-200 light:bg-sky-50 light:text-sky-700"
          : "hover:bg-white/10 light:hover:bg-slate-100"
      }`}
    >
      <button
        ref={ref}
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onClick}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl border-none bg-transparent px-3 py-2.5 text-left text-sm ${
          disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"
        }`}
      >
        <Icon size={18} weight={active ? "fill" : "regular"} />
        <span className="flex-1">{label}</span>
      </button>
      {trailing && <div className="pr-2">{trailing}</div>}
    </div>
  );
});
