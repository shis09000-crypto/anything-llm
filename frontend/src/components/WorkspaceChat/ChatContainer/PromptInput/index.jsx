import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { GlassCard } from "@developer-hub/liquid-glass";
import debounce from "lodash.debounce";
import {
  ArrowUp,
  CaretDown,
  CircleNotch,
  ClockCounterClockwise,
  PencilSimple,
  Question,
  Shield,
  X,
} from "@phosphor-icons/react";
import StopGenerationButton from "./StopGenerationButton";
import SpeechToText from "./SpeechToText";
import { Tooltip } from "react-tooltip";
import AttachmentManager from "./Attachments";
import AttachItem from "./AttachItem";
import {
  ATTACHMENTS_PROCESSED_EVENT,
  ATTACHMENTS_PROCESSING_EVENT,
  PASTE_ATTACHMENT_EVENT,
} from "../DnDWrapper";
import useTextSize from "@/hooks/useTextSize";
import { useTranslation } from "react-i18next";
import Appearance from "@/models/appearance";
import usePromptInputStorage from "@/hooks/usePromptInputStorage";
import ToolsMenu, { TOOLS_MENU_KEYBOARD_EVENT } from "./ToolsMenu";
import { useSearchParams } from "react-router-dom";
import { useIsAgentSessionActive } from "@/lib/communication/agentWebSocketClient";
import { debugChatTurn } from "@/utils/chat/debug";
import FileAccessPolicy from "@/models/fileAccessPolicy";
import { nFormatter } from "@/utils/numbers";
import ReaderTextSourceCards from "@/modules/reader/ReaderTextSourceCards";
import { useDocumentReader } from "@/modules/reader/DocumentReaderProvider";
import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";
import WorkspaceCognition from "@/models/workspaceCognition";
import { appendPromptUndoSnapshot } from "@/utils/promptInputRuntime";

export const PROMPT_INPUT_ID = "primary-prompt-input";
export const PROMPT_INPUT_EVENT = "set_prompt_input";
const MAX_EDIT_STACK_SIZE = 100;
const FILE_ACCESS_MODE_OPTIONS = [
  FileAccessPolicy.modes.sandbox,
  FileAccessPolicy.modes.authorized,
  FileAccessPolicy.modes.open,
];

/**
 * @param {Workspace} props.workspace - workspace object
 * @param {function} props.submit - form submit handler
 * @param {boolean} props.isStreaming - disables input while streaming response
 * @param {function} props.sendCommand - handler for slash commands and agent mentions
 * @param {Array} [props.attachments] - file attachments array
 * @param {boolean} [props.centered] - renders in centered layout mode (for home page)
 * @param {boolean} [props.glass] - uses a translucent shell for overlay-style home pages
 * @param {string} [props.workspaceSlug] - workspace slug for home page context
 * @param {string} [props.threadSlug] - thread slug for home page context
 * @param {string} [props.inputId] - DOM id for this prompt input
 * @param {string|null} [props.targetThreadSlug] - event target scope for this prompt input
 * @param {string|null} [props.promptStorageKey] - local draft storage scope
 * @param {function} [props.onComposeStateChange] - reports local compose state to the parent
 * @param {function} [props.onHeightChange] - reports non-centered prompt input height changes
 * @param {boolean} [props.quizModeActive] - next submission generates a quiz
 * @param {function} [props.onToggleQuizMode] - toggles quiz mode
 * @param {Object|null} [props.memoryCompaction] - cached thread compaction status and actions
 * @param {boolean} [props.editMode] - indicates an atomic chat edit is active
 * @param {function} [props.onCancelEdit] - cancels the active chat edit
 */
export default function PromptInput({
  workspace = {},
  submit,
  isStreaming,
  sendCommand,
  attachments = [],
  centered = false,
  glass = false,
  workspaceSlug = null,
  threadSlug = null,
  inputId = PROMPT_INPUT_ID,
  targetThreadSlug = threadSlug,
  promptStorageKey = targetThreadSlug ?? threadSlug ?? workspaceSlug,
  onComposeStateChange,
  onHeightChange,
  quizModeActive = false,
  onToggleQuizMode,
  memoryCompaction = null,
  editMode = false,
  onCancelEdit = null,
}) {
  useEffect(() => {
    return () => {
      if (!workspaceSlug || !threadSlug) return;
      WorkspaceCognition.flush(workspaceSlug, {
        threadSlug,
        reason: "switch",
      }).catch?.(() => null);
    };
  }, [workspaceSlug, threadSlug]);
  const { t } = useTranslation();
  const readerContext = useDocumentReader();
  const { isDisabled: attachmentsProcessing } = useIsDisabled();
  const ocrProcessing = !!readerContext?.hasPendingReaderTextSources;
  const disabledReason = ocrProcessing
    ? "ocr"
    : attachmentsProcessing
      ? "attachments"
      : null;
  const isDisabled = !!disabledReason;
  const agentSessionActive = useIsAgentSessionActive();
  const [hasPromptInput, setHasPromptInput] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [isVoiceInputActive, setIsVoiceInputActive] = useState(false);
  const autoOpenedToolsRef = useRef(false);
  const toolsHighlightRef = useRef(-1);
  const containerRef = useRef(null);
  const formRef = useRef(null);
  const textareaRef = useRef(null);
  const promptInputRef = useRef("");
  const hasPromptInputRef = useRef(false);
  const isComposingRef = useRef(false);
  const beforeInputSnapshotRef = useRef(null);
  const compositionStartSnapshotRef = useRef(null);
  const textareaResizeFrameRef = useRef(null);
  const textareaLastHeightRef = useRef(0);
  const [_, setFocused] = useState(false);
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  const { textSizeClass, textSizeStyle } = useTextSize();
  const [searchParams] = useSearchParams();

  const scheduleTextAreaResize = useCallback(() => {
    if (textareaResizeFrameRef.current !== null) return;
    textareaResizeFrameRef.current = window.requestAnimationFrame(() => {
      textareaResizeFrameRef.current = null;
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "auto";
      const nextHeight = Math.max(0, Math.ceil(textarea.scrollHeight));
      if (nextHeight === textareaLastHeightRef.current) {
        textarea.style.height = nextHeight ? `${nextHeight}px` : "auto";
        return;
      }
      textareaLastHeightRef.current = nextHeight;
      textarea.style.height = nextHeight ? `${nextHeight}px` : "auto";
    });
  }, []);

  const writePromptValue = useCallback(
    (nextValue) => {
      const value = String(nextValue ?? "");
      promptInputRef.current = value;
      if (textareaRef.current && textareaRef.current.value !== value)
        textareaRef.current.value = value;
      const nextHasPromptInput = value.trim().length > 0;
      if (nextHasPromptInput !== hasPromptInputRef.current) {
        hasPromptInputRef.current = nextHasPromptInput;
        setHasPromptInput(nextHasPromptInput);
      }
      scheduleTextAreaResize();
    },
    [scheduleTextAreaResize]
  );

  // Synchronizes prompt input value with localStorage, scoped to the current thread.
  const schedulePromptInputStorage = usePromptInputStorage({
    promptInputRef,
    setPromptInput: writePromptValue,
    storageKey: promptStorageKey,
  });

  const commitPromptValue = useCallback(
    (value, { persist = true } = {}) => {
      writePromptValue(value);
      if (persist) schedulePromptInputStorage(String(value ?? ""));
    },
    [schedulePromptInputStorage, writePromptValue]
  );

  useEffect(
    () => () => {
      if (textareaResizeFrameRef.current !== null)
        window.cancelAnimationFrame(textareaResizeFrameRef.current);
    },
    []
  );

  // Legacy links may still carry action=set-agent-chat. Unified Responses
  // turns need no draft prefix or transport switch, so only focus the input.
  useEffect(() => {
    if (searchParams.get("action") === "set-agent-chat")
      textareaRef.current?.focus();
  }, [searchParams, textareaRef]);

  /**
   * To prevent too many re-renders we remotely listen for updates from the parent
   * via an event cycle. Otherwise, using message as a prop leads to a re-render every
   * change on the input.
   * @param {{detail: {messageContent: string, writeMode: 'replace' | 'append' | 'prepend' | 'insert', targetInputId?: string, targetThreadSlug?: string|null}}} e
   */
  function handlePromptUpdate(e) {
    const {
      messageContent,
      writeMode = "replace",
      targetInputId = null,
      targetThreadSlug: eventThreadSlug,
    } = e?.detail ?? {};
    const hasThreadTarget = Object.prototype.hasOwnProperty.call(
      e?.detail ?? {},
      "targetThreadSlug"
    );
    if (targetInputId && targetInputId !== inputId) return;
    if (hasThreadTarget && eventThreadSlug !== targetThreadSlug) return;
    if (!targetInputId && !hasThreadTarget && inputId !== PROMPT_INPUT_ID)
      return;

    const currentValue = promptInputRef.current;
    if (writeMode === "insert") {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? currentValue.length;
      const end = textarea?.selectionEnd ?? start;
      const insertedValue = String(messageContent ?? "");
      const next =
        currentValue.substring(0, start) +
        insertedValue +
        currentValue.substring(end);
      commitPromptValue(next);
      window.requestAnimationFrame(() => {
        if (!textarea) return;
        const nextCursor = start + insertedValue.length;
        textarea.selectionStart = textarea.selectionEnd = nextCursor;
      });
    } else if (writeMode === "append") {
      commitPromptValue(currentValue + String(messageContent ?? ""));
    } else if (writeMode === "prepend") {
      commitPromptValue(`${String(messageContent ?? "")} ${currentValue}`);
    } else {
      commitPromptValue(messageContent ?? "");
    }
  }

  useEffect(() => {
    if (!!window)
      window.addEventListener(PROMPT_INPUT_EVENT, handlePromptUpdate);
    return () =>
      window?.removeEventListener(PROMPT_INPUT_EVENT, handlePromptUpdate);
  }, [commitPromptValue, inputId, targetThreadSlug]);

  useEffect(() => {
    onComposeStateChange?.({
      hasDraftInput: hasPromptInput,
      isComposing,
      slashMenuOpen: showTools,
      hasAttachments: attachments.length > 0,
      isVoiceInputActive,
      isStreaming: !!isStreaming,
    });
  }, [
    attachments.length,
    isComposing,
    isStreaming,
    isVoiceInputActive,
    onComposeStateChange,
    hasPromptInput,
    showTools,
  ]);

  const reportInputHeight = useCallback(() => {
    if (centered || !onHeightChange || !containerRef.current) return;
    onHeightChange(
      Math.ceil(containerRef.current.getBoundingClientRect().height)
    );
  }, [centered, onHeightChange]);

  useEffect(() => {
    reportInputHeight();
  }, [attachments.length, isStreaming, quizModeActive, reportInputHeight]);

  useEffect(() => {
    if (centered || !onHeightChange || !containerRef.current) return;
    const element = containerRef.current;
    let frame = null;
    const scheduleReport = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reportInputHeight);
    };

    scheduleReport();
    window.addEventListener("resize", scheduleReport);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleReport);
    resizeObserver?.observe(element);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleReport);
      resizeObserver?.disconnect();
    };
  }, [centered, onHeightChange, reportInputHeight]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) textareaRef.current.focus();
    resetTextAreaHeight();
  }, [isStreaming]);

  useEffect(() => {
    debugChatTurn("PromptInput:renderState", {
      workspaceSlug: workspaceSlug || workspace?.slug || null,
      threadSlug,
      inputId,
      isStreaming: !!isStreaming,
      isDisabled: !!isDisabled,
      disabledReason,
      attachmentsProcessing: !!attachmentsProcessing,
      ocrProcessing: !!ocrProcessing,
      agentSessionActive: !!agentSessionActive,
      stopButtonVisible: !!isStreaming,
      sendButtonVisible: !isStreaming,
      hasPromptInput,
    });
  }, [
    agentSessionActive,
    attachmentsProcessing,
    disabledReason,
    isDisabled,
    isStreaming,
    inputId,
    ocrProcessing,
    hasPromptInput,
    threadSlug,
    workspace?.slug,
    workspaceSlug,
  ]);

  const pushUndoSnapshot = useCallback((snapshot) => {
    if (
      appendPromptUndoSnapshot(undoStack.current, snapshot, MAX_EDIT_STACK_SIZE)
    )
      redoStack.current = [];
  }, []);

  const debouncedSaveState = useMemo(
    () => debounce(pushUndoSnapshot, 250),
    [pushUndoSnapshot]
  );

  useEffect(() => () => debouncedSaveState.cancel(), [debouncedSaveState]);

  function currentPromptSnapshot() {
    const textarea = textareaRef.current;
    return {
      value: promptInputRef.current,
      cursorPositionStart: textarea?.selectionStart ?? 0,
      cursorPositionEnd: textarea?.selectionEnd ?? 0,
    };
  }

  function saveCurrentState(snapshot = currentPromptSnapshot()) {
    debouncedSaveState.cancel();
    pushUndoSnapshot(snapshot);
  }

  function handleSubmit(e) {
    // Ignore submits from portaled modals (slash command preset forms)
    if (e.target !== e.currentTarget) return;
    setFocused(false);
    setShowTools(false);
    submit(e);
  }

  function resetTextAreaHeight() {
    if (!textareaRef.current) return;
    if (textareaResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(textareaResizeFrameRef.current);
      textareaResizeFrameRef.current = null;
    }
    textareaLastHeightRef.current = 0;
    textareaRef.current.style.height = "auto";
    if (promptInputRef.current) scheduleTextAreaResize();
  }

  /**
   * Capture enter key press to handle submission, redo, or undo
   * via keyboard shortcuts
   * @param {KeyboardEvent} event
   */
  function captureEnterOrUndo(event) {
    if (event.isComposing || isComposingRef.current) return;

    // Forward keyboard events to the ToolsMenu when open
    if (showTools) {
      if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent(TOOLS_MENU_KEYBOARD_EVENT, {
            detail: { key: event.key },
          })
        );
        return;
      }
      // When an item is highlighted via arrow keys, Enter selects it.
      // Otherwise, Enter falls through to submit the form normally.
      if (event.key === "Enter" && toolsHighlightRef.current >= 0) {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent(TOOLS_MENU_KEYBOARD_EVENT, {
            detail: { key: "Enter" },
          })
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setShowTools(false);
        textareaRef.current?.focus();
        return;
      }
    }

    // "/" toggles the Tools menu only when the input is empty
    if (
      event.key === "/" &&
      !event.ctrlKey &&
      !event.metaKey &&
      promptInputRef.current.trim() === ""
    ) {
      setShowTools((prev) => {
        autoOpenedToolsRef.current = !prev;
        return !prev;
      });
      return;
    }

    // Is simple enter key press w/o shift key
    if (event.keyCode === 13 && !event.shiftKey) {
      event.preventDefault();
      if (isStreaming || isDisabled) {
        debugChatTurn("PromptInput:submitBlocked", {
          workspaceSlug: workspaceSlug || workspace?.slug || null,
          threadSlug,
          isStreaming: !!isStreaming,
          isDisabled: !!isDisabled,
          disabledReason,
        });
        return;
      } // Prevent submission if streaming or disabled
      setShowTools(false);
      return submit(event);
    }

    // Is undo with Ctrl+Z or Cmd+Z + Shift key = Redo
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "z" &&
      event.shiftKey
    ) {
      event.preventDefault();
      debouncedSaveState.flush();
      if (redoStack.current.length === 0) return;

      const nextState = redoStack.current.pop();
      if (!nextState) return;

      undoStack.current.push(currentPromptSnapshot());
      commitPromptValue(nextState.value);
      window.requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(
          nextState.cursorPositionStart,
          nextState.cursorPositionEnd
        );
      });
    }

    // Undo with Ctrl+Z or Cmd+Z
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "z" &&
      !event.shiftKey
    ) {
      event.preventDefault();
      debouncedSaveState.flush();
      if (undoStack.current.length === 0) return;
      const lastState = undoStack.current.pop();
      if (!lastState) return;

      redoStack.current.push(currentPromptSnapshot());
      commitPromptValue(lastState.value);
      window.requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(
          lastState.cursorPositionStart,
          lastState.cursorPositionEnd
        );
      });
    }
  }

  function handlePasteEvent(e) {
    e.preventDefault();
    if (e.clipboardData.items.length === 0) return false;

    // paste any clipboard items that are images.
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        window.dispatchEvent(
          new CustomEvent(PASTE_ATTACHMENT_EVENT, {
            detail: { files: [file] },
          })
        );
        continue;
      }

      // handle files specifically that are not images as uploads
      if (item.kind === "file") {
        const file = item.getAsFile();
        window.dispatchEvent(
          new CustomEvent(PASTE_ATTACHMENT_EVENT, {
            detail: { files: [file] },
          })
        );
        continue;
      }
    }

    const pasteText = e.clipboardData.getData("text/plain");
    if (pasteText) {
      const textarea = textareaRef.current;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const currentValue = promptInputRef.current;
      const newPromptInput =
        currentValue.substring(0, start) +
        pasteText +
        currentValue.substring(end);
      commitPromptValue(newPromptInput);

      // Set the cursor position after the pasted text
      window.requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd =
          start + pasteText.length;
      });
    }
    beforeInputSnapshotRef.current = null;
    return;
  }

  function handleBeforeInput(event) {
    if (
      isComposingRef.current ||
      event.nativeEvent?.inputType === "insertCompositionText"
    )
      return;
    beforeInputSnapshotRef.current = currentPromptSnapshot();
  }

  function handleChange(e) {
    const value = e.currentTarget.value;
    if (
      isComposingRef.current ||
      e.nativeEvent?.inputType === "insertCompositionText"
    ) {
      writePromptValue(value);
      return;
    }

    const snapshot = beforeInputSnapshotRef.current || {
      value: promptInputRef.current,
      cursorPositionStart: Math.max(0, e.currentTarget.selectionStart - 1),
      cursorPositionEnd: Math.max(0, e.currentTarget.selectionEnd - 1),
    };
    beforeInputSnapshotRef.current = null;
    debouncedSaveState(snapshot);
    commitPromptValue(value);

    // Auto-dismiss the tools menu when the "/" that opened it is modified
    if (autoOpenedToolsRef.current && showTools && value !== "/") {
      setShowTools(false);
      autoOpenedToolsRef.current = false;
    }
  }

  return (
    <div
      ref={containerRef}
      className={
        centered
          ? "w-full relative flex justify-center items-center"
          : "w-full fixed md:absolute bottom-0 left-0 z-10 flex justify-center items-center pwa:pb-5"
      }
    >
      <form
        onSubmit={handleSubmit}
        className={
          centered
            ? "flex flex-col gap-y-1 rounded-t-lg w-full items-center"
            : "athena-prompt-form flex flex-col gap-y-1 rounded-t-lg md:w-full w-full mx-auto max-w-[750px] items-center"
        }
      >
        <div
          className={`flex items-center rounded-lg md:w-full ${centered ? "mb-0" : "mb-2"}`}
        >
          <div
            className={`athena-prompt-feather chat-prompt-feather relative w-[95vw] md:w-[750px] ${
              glass ? "liquid-glass-composer-host" : ""
            }`}
          >
            <ToolsMenu
              workspace={workspace}
              showing={showTools}
              setShowing={setShowTools}
              sendCommand={sendCommand}
              promptRef={textareaRef}
              centered={centered}
              highlightedIndexRef={toolsHighlightRef}
              threadSlug={threadSlug}
            />
            <PromptInputGlassShell glass={glass}>
              {editMode && (
                <div className="mx-1 mt-2 flex items-center justify-between rounded-xl border border-white/10 px-3 py-2 text-sm text-white/75 light:border-slate-200 light:text-slate-600">
                  <div className="flex items-center gap-2">
                    <PencilSimple size={17} aria-hidden="true" />
                    <span>编辑消息</span>
                  </div>
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    className="rounded-full border-none p-1 text-current motion-hover hover:bg-white/10 light:hover:bg-slate-100"
                    aria-label="取消编辑"
                  >
                    <X size={17} aria-hidden="true" />
                  </button>
                </div>
              )}
              <AttachmentManager attachments={attachments} />
              <ReaderTextSourceCards
                sources={readerContext?.pendingReaderTextSources || []}
                focusedSignal={readerContext?.focusedReaderTextSource}
                onRemove={readerContext?.removePendingReaderTextSource}
                removable
                className="mt-2 mb-3"
              />
              <div className="flex items-center">
                <textarea
                  id={inputId}
                  ref={textareaRef}
                  onBeforeInput={handleBeforeInput}
                  onChange={handleChange}
                  onKeyDown={captureEnterOrUndo}
                  onPaste={(e) => {
                    saveCurrentState();
                    handlePasteEvent(e);
                  }}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                    compositionStartSnapshotRef.current =
                      currentPromptSnapshot();
                    setIsComposing(true);
                  }}
                  onCompositionEnd={(event) => {
                    isComposingRef.current = false;
                    setIsComposing(false);
                    if (compositionStartSnapshotRef.current)
                      debouncedSaveState(compositionStartSnapshotRef.current);
                    compositionStartSnapshotRef.current = null;
                    commitPromptValue(event.currentTarget.value);
                  }}
                  required={true}
                  onFocus={() => setFocused(true)}
                  onBlur={() => {
                    setFocused(false);
                  }}
                  defaultValue=""
                  spellCheck={Appearance.get("enableSpellCheck")}
                  className={`border-none cursor-text max-h-[50vh] md:max-h-[350px] md:min-h-[40px] pt-[20px] w-full leading-5 bg-transparent resize-none active:outline-none focus:outline-none flex-grow pwa:!text-[16px] ${
                    glass
                      ? "liquid-glass-input"
                      : "text-white light:text-slate-600 placeholder:text-white/60 light:placeholder:text-slate-400"
                  } ${textSizeClass}`}
                  style={textSizeStyle}
                  placeholder={t("chat_window.send_message")}
                />
              </div>
              <div className="flex justify-between items-center pt-3.5 pb-3">
                <div className="flex items-center gap-x-0.25">
                  <div className="flex items-center gap-x-1">
                    <AttachItem
                      workspaceSlug={workspaceSlug}
                      workspaceThreadSlug={threadSlug}
                    />
                  </div>
                  <ToolsButton
                    showTools={showTools}
                    setShowTools={setShowTools}
                    textareaRef={textareaRef}
                    autoOpenedToolsRef={autoOpenedToolsRef}
                  />
                  <QuizModeButton
                    active={quizModeActive}
                    onToggle={onToggleQuizMode}
                    textareaRef={textareaRef}
                  />
                  <FileAccessModeButton
                    workspaceSlug={workspaceSlug || workspace?.slug}
                    threadSlug={threadSlug}
                    textareaRef={textareaRef}
                  />
                </div>
                <div className="flex gap-x-2 items-center">
                  <MemoryCompactionControl
                    memoryCompaction={memoryCompaction}
                  />
                  <SpeechToText
                    sendCommand={sendCommand}
                    onListeningChange={setIsVoiceInputActive}
                  />
                  {isStreaming ? (
                    <StopGenerationButton />
                  ) : (
                    <SendPromptButton
                      formRef={formRef}
                      hasPromptInput={hasPromptInput}
                      isDisabled={isDisabled}
                      disabledReason={disabledReason}
                    />
                  )}
                </div>
              </div>
              {quizModeActive && (
                <div className="pb-3 text-xs text-sky-300 light:text-sky-600">
                  测试模式已开启：下一次输入将生成测试题
                </div>
              )}
            </PromptInputGlassShell>
          </div>
        </div>
      </form>
    </div>
  );
}

function PromptInputGlassShell({ glass, children }) {
  if (!glass) {
    return (
      <div className="relative z-10 rounded-[20px] pwa:rounded-3xl flex flex-col px-5 overflow-hidden bg-zinc-800 light:bg-white light:border light:border-slate-300">
        {children}
      </div>
    );
  }

  return (
    <div
      className="official-liquid-glass-composer-shell relative z-10 w-full"
      style={{ "--official-liquid-glass-composer-radius": "10px" }}
    >
      <GlassCard
        className="official-liquid-glass-composer w-full"
        displacementScale={100}
        blurAmount={0.01}
        cornerRadius={10}
        padding="0px"
        shadowMode={false}
        style={{ width: "100%", borderRadius: "10px" }}
      >
        <div className="liquid-glass-composer-content flex w-full flex-col overflow-hidden px-5">
          {children}
        </div>
      </GlassCard>
    </div>
  );
}

function clampRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

function MemoryCompactionControl({ memoryCompaction = null }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState({});
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const showTimerRef = useRef(null);
  const hideTimerRef = useRef(null);
  const status = memoryCompaction?.status || null;
  const pending = !!memoryCompaction?.pending;
  const loading = !!memoryCompaction?.loading;
  const connectionState = memoryCompaction?.connectionState || "loading";
  const degraded =
    status?.state === "degraded" ||
    ["degraded", "retrying"].includes(connectionState);
  const canCompactAtRatio = Number(status?.canCompactAtRatio || 0.8);
  const usedTokens = Number(status?.usedTokens || 0);
  const limitTokens = Number(status?.limitTokens || 0);
  const safeRatio = clampRatio(status?.ratio);
  const compactableMessageCount = Number(status?.compactableMessageCount || 0);
  const coveredMessageCount = Number(status?.coveredMessageCount || 0);
  const newRawMessageCount = Number(status?.newRawMessageCount || 0);
  const targetCompactableMessageCount = Number(
    status?.targetCompactableMessageCount ?? compactableMessageCount
  );
  const latestTargetResult = status?.latestTargetResult || null;
  const cannotReachTargetReason =
    latestTargetResult?.cannotReachTargetReason ||
    status?.cannotReachTargetReason ||
    null;
  const hasLimit = !degraded && limitTokens > 0;
  const ringDegrees = degraded ? 0 : Math.round(safeRatio * 360);
  const ringTone =
    safeRatio >= 0.9
      ? "rgb(248 113 113)"
      : safeRatio >= 0.72
        ? "rgb(251 191 36)"
        : "rgb(56 189 248)";

  useEffect(() => {
    return () => {
      clearTimeout(showTimerRef.current);
      clearTimeout(hideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event) {
      if (buttonRef.current?.contains(event.target)) return;
      if (popoverRef.current?.contains(event.target)) return;
      closeNow();
    }

    function onEscape(event) {
      if (event.key === "Escape") closeNow();
    }

    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  if (!memoryCompaction?.visible) return null;

  function positionPopover() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 260;
    const gap = 10;
    setPopoverStyle({
      position: "fixed",
      width: `${width}px`,
      left: `${Math.min(
        Math.max(8, rect.right - width),
        window.innerWidth - width - 8
      )}px`,
      top: `${Math.max(8, rect.top - 190 - gap)}px`,
      zIndex: 9999,
    });
  }

  function openAfter(delay = 800) {
    clearTimeout(hideTimerRef.current);
    clearTimeout(showTimerRef.current);
    showTimerRef.current = setTimeout(() => {
      setOpen(true);
      setPinned(false);
      setTimeout(positionPopover, 0);
    }, delay);
  }

  function closeAfter(delay = 200) {
    if (pinned) return;
    clearTimeout(showTimerRef.current);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setOpen(false), delay);
  }

  function closeNow() {
    clearTimeout(showTimerRef.current);
    clearTimeout(hideTimerRef.current);
    setPinned(false);
    setOpen(false);
  }

  function togglePinned() {
    clearTimeout(showTimerRef.current);
    clearTimeout(hideTimerRef.current);
    setOpen((current) => {
      const next = !current || !pinned;
      setPinned(next);
      setTimeout(positionPopover, 0);
      return next;
    });
  }

  const disabledReason = pending
    ? "上下文记忆正在压缩"
    : degraded
      ? "压缩记忆暂时不可读取"
      : targetCompactableMessageCount <= 0
        ? "暂无可压缩记忆"
        : safeRatio < canCompactAtRatio
          ? "达到 80% 后可压缩"
          : null;
  const canCompact = !disabledReason;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="线程记忆占用"
        onPointerEnter={() => openAfter(800)}
        onPointerLeave={() => closeAfter(200)}
        onFocus={() => openAfter(180)}
        onBlur={() => closeAfter(200)}
        onClick={togglePinned}
        className="group relative border-none flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-zinc-700 light:hover:bg-slate-200"
        style={{
          backgroundImage: `conic-gradient(${ringTone} ${ringDegrees}deg, rgba(113,113,122,0.35) 0deg)`,
        }}
      >
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-zinc-900 light:bg-white">
          {loading ? (
            <CircleNotch
              size={15}
              className="animate-spin text-zinc-300 light:text-slate-600"
            />
          ) : (
            <ClockCounterClockwise
              size={15}
              className="text-zinc-300 light:text-slate-600 group-hover:text-white light:group-hover:text-slate-800"
            />
          )}
        </span>
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            style={popoverStyle}
            onPointerEnter={() => {
              clearTimeout(hideTimerRef.current);
              clearTimeout(showTimerRef.current);
            }}
            onPointerLeave={() => closeAfter(200)}
            className="motion-hover rounded-xl border border-white/10 light:border-slate-200 bg-zinc-950/95 light:bg-white p-3 text-white light:text-slate-900 shadow-2xl backdrop-blur"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="m-0 text-sm font-semibold">线程记忆占用</p>
                <p
                  className={`m-0 mt-1 text-[10px] ${
                    degraded
                      ? "text-amber-300 light:text-amber-600"
                      : "text-emerald-300 light:text-emerald-600"
                  }`}
                >
                  {degraded
                    ? "压缩记忆暂时不可读取，正在自动恢复"
                    : connectionState === "connected"
                      ? "已连接"
                      : "正在同步"}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold text-sky-300 light:text-sky-600">
                  {hasLimit ? `${Math.round(safeRatio * 100)}%` : "--"}
                </div>
                <div className="text-[10px] text-white/45 light:text-slate-400">
                  memory
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <MemoryStat
                label="已用"
                value={degraded ? "--" : nFormatter(usedTokens)}
              />
              <MemoryStat
                label="上限"
                value={hasLimit ? nFormatter(limitTokens) : "--"}
              />
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-white/55 light:text-slate-500">
              <span>目标可压缩消息</span>
              <span>{degraded ? "--" : targetCompactableMessageCount}</span>
            </div>
            {!degraded && status?.state === "active" && (
              <div className="mt-2 flex items-center justify-between text-xs text-white/55 light:text-slate-500">
                <span>已压缩 {coveredMessageCount} 条</span>
                <span>压缩后新增 {newRawMessageCount} 条</span>
              </div>
            )}
            {!degraded &&
              latestTargetResult?.targetReached === false &&
              latestTargetResult?.ratioAfterCompact !== undefined && (
                <p className="m-0 mt-2 text-xs leading-5 text-amber-300 light:text-amber-600">
                  为了保留高质量接力摘要，本次未强行压到目标。当前压缩后占用：
                  {Math.round(
                    clampRatio(latestTargetResult.ratioAfterCompact) * 100
                  )}
                  %，目标：
                  {Math.round(
                    Number(latestTargetResult.targetRatio || 0) * 100
                  )}
                  %。
                </p>
              )}
            {!degraded && cannotReachTargetReason && (
              <p className="m-0 mt-2 truncate text-xs text-white/45 light:text-slate-500">
                原因：{cannotReachTargetReason}
              </p>
            )}
            <button
              type="button"
              disabled={!canCompact}
              onClick={() => {
                if (!canCompact) return;
                memoryCompaction?.onCompact?.();
              }}
              className={`mt-3 w-full rounded-lg border-none px-3 py-2 text-sm font-semibold motion-hover ${
                canCompact
                  ? "cursor-pointer bg-sky-500 text-white hover:bg-sky-400"
                  : "cursor-not-allowed bg-zinc-800 text-white/45 light:bg-slate-100 light:text-slate-400"
              }`}
            >
              {disabledReason || "立即压缩记忆"}
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

function MemoryStat({ label, value }) {
  return (
    <div className="rounded-lg bg-white/5 px-2 py-2 light:bg-slate-100">
      <div className="text-[10px] text-white/45 light:text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 truncate text-xs font-semibold text-white light:text-slate-900">
        {value}
      </div>
    </div>
  );
}

function QuizModeButton({ active, onToggle, textareaRef }) {
  const { t } = useTranslation();
  const tooltip = active
    ? t("chat_window.controls.quizMode.activeDescription")
    : t("chat_window.controls.quizMode.description");

  return (
    <>
      <button
        type="button"
        onClick={() => {
          onToggle?.();
          textareaRef.current?.focus();
        }}
        data-tooltip-id="quiz-mode"
        data-tooltip-content={tooltip}
        className={`group border-none cursor-pointer flex items-center justify-center gap-x-1 h-6 px-2 rounded-full ${
          active
            ? "bg-sky-900/50 light:bg-sky-100"
            : "hover:bg-zinc-700 light:hover:bg-slate-200"
        }`}
        aria-label={tooltip}
      >
        <Question
          size={15}
          className={
            active
              ? "text-sky-300 light:text-sky-600"
              : "text-zinc-300 light:text-slate-600"
          }
          weight="bold"
        />
        <span
          className={`text-xs font-medium ${
            active
              ? "text-sky-300 light:text-sky-600"
              : "text-zinc-300 light:text-slate-600 group-hover:text-white light:group-hover:text-slate-800"
          }`}
        >
          {t("chat_window.controls.quizMode.label")}
        </span>
      </button>
      <Tooltip
        id="quiz-mode"
        place="bottom"
        delayShow={300}
        className="tooltip !text-xs z-99 max-w-[280px]"
      />
    </>
  );
}

function FileAccessModeButton({ workspaceSlug, threadSlug, textareaRef }) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [menuStyle, setMenuStyle] = useState({});
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [mode, setMode] = useState(
    () =>
      FileAccessPolicy.getSessionMode(workspaceSlug, threadSlug) ||
      FileAccessPolicy.modes.sandbox
  );
  const [defaultMode, setDefaultMode] = useState(
    FileAccessPolicy.modes.sandbox
  );
  const policyLoadedRef = useRef(false);

  useEffect(() => {
    const sessionMode = FileAccessPolicy.getSessionMode(
      workspaceSlug,
      threadSlug
    );
    setMode(
      FileAccessPolicy.normalizeMode(
        sessionMode || FileAccessPolicy.modes.sandbox
      )
    );
    setDefaultMode(FileAccessPolicy.modes.sandbox);
    policyLoadedRef.current = false;
  }, [workspaceSlug, threadSlug]);

  async function loadPolicyIfNeeded() {
    if (policyLoadedRef.current) return;
    const sessionMode = FileAccessPolicy.getSessionMode(
      workspaceSlug,
      threadSlug
    );
    const res = await FileAccessPolicy.getPolicy(sessionMode);
    if (!res?.policy) return;
    const nextMode =
      sessionMode ||
      res.policy.effectiveMode ||
      res.policy.defaultMode ||
      FileAccessPolicy.modes.sandbox;
    setMode(FileAccessPolicy.normalizeMode(nextMode));
    setDefaultMode(
      FileAccessPolicy.normalizeMode(
        res.policy.defaultMode || FileAccessPolicy.modes.sandbox
      )
    );
    if (!sessionMode)
      FileAccessPolicy.setSessionMode(nextMode, workspaceSlug, threadSlug);
    policyLoadedRef.current = true;
  }

  const config = {
    sandbox: {
      label: t("chat_window.controls.fileAccess.modes.sandbox.label"),
      color: "text-zinc-300 light:text-slate-600",
      active: "bg-zinc-700 light:bg-slate-200",
      tooltip: t("chat_window.controls.fileAccess.modes.sandbox.description"),
    },
    authorized: {
      label: t("chat_window.controls.fileAccess.modes.authorized.label"),
      color: "text-sky-400 light:text-sky-600",
      active: "bg-sky-900/40 light:bg-sky-100",
      tooltip: t(
        "chat_window.controls.fileAccess.modes.authorized.description"
      ),
    },
    open: {
      label: t("chat_window.controls.fileAccess.modes.open.label"),
      color: "text-red-400 light:text-red-600",
      active: "bg-red-900/40 light:bg-red-100",
      tooltip: t("chat_window.controls.fileAccess.modes.open.description"),
    },
  };

  useEffect(() => {
    if (!showMenu) return;

    function positionMenu() {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 180;
      const menuHeight = 136;
      setMenuStyle({
        position: "fixed",
        left: `${Math.min(
          Math.max(8, rect.left),
          window.innerWidth - menuWidth - 8
        )}px`,
        top: `${Math.max(8, rect.top - menuHeight)}px`,
        width: `${menuWidth}px`,
        zIndex: 9999,
      });
    }

    function handlePointerDown(event) {
      if (buttonRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setShowMenu(false);
    }

    function handleEscape(event) {
      if (event.key === "Escape") setShowMenu(false);
    }

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    window.addEventListener("keydown", handleEscape);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
      window.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [showMenu]);

  async function setSessionMode(nextMode) {
    const normalized = FileAccessPolicy.normalizeMode(nextMode);
    if (
      normalized === FileAccessPolicy.modes.open &&
      !(await showAppConfirm({
        tone: "warning",
        title: t("chat_window.controls.fileAccess.openConfirm.title"),
        description: t(
          "chat_window.controls.fileAccess.openConfirm.description"
        ),
        confirmText: t("chat_window.controls.fileAccess.openConfirm.confirm"),
      }))
    ) {
      return;
    }
    FileAccessPolicy.setSessionMode(normalized, workspaceSlug, threadSlug);
    debugChatTurn("FileAccessModeButton:setSessionMode", {
      workspaceSlug,
      threadSlug,
      fileAccessMode: normalized,
    });
    setMode(normalized);
    setShowMenu(false);
    textareaRef?.current?.focus();
    await FileAccessPolicy.logSessionModeChange({
      mode: normalized,
      workspaceSlug,
      threadSlug,
    });
  }

  const current = config[mode] || config.sandbox;
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setShowMenu((prev) => {
            const next = !prev;
            if (next) loadPolicyIfNeeded();
            return next;
          });
        }}
        data-tooltip-id="file-access-mode"
        data-tooltip-content={`${t("chat_window.controls.fileAccess.label")}: ${current.label}. ${current.tooltip}`}
        className={`group border-none cursor-pointer flex items-center justify-center gap-x-1 h-6 px-2 rounded-full hover:bg-zinc-700 light:hover:bg-slate-200 ${showMenu ? current.active : ""}`}
        aria-label={`${t("chat_window.controls.fileAccess.label")}: ${current.label}`}
      >
        <Shield size={15} className={current.color} weight="bold" />
        <span className={`text-xs font-medium ${current.color}`}>
          {current.label}
        </span>
        <CaretDown size={12} className={current.color} />
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <Tooltip
            id="file-access-mode"
            place="bottom"
            delayShow={300}
            positionStrategy="fixed"
            style={{ zIndex: 10050 }}
            className="tooltip file-access-mode-tooltip !text-xs"
          />,
          document.body
        )}
      {showMenu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={menuStyle}
            className="rounded-lg border border-white/10 light:border-slate-200 bg-zinc-900 light:bg-white shadow-xl overflow-hidden"
          >
            {FILE_ACCESS_MODE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSessionMode(option)}
                data-tooltip-id="file-access-mode"
                data-tooltip-content={config[option].tooltip}
                className={`w-full border-none text-left px-3 py-2 flex items-center gap-x-2 hover:bg-zinc-800 light:hover:bg-slate-100 ${
                  option === mode ? "bg-zinc-800 light:bg-slate-100" : ""
                }`}
              >
                <Shield
                  size={15}
                  className={config[option].color}
                  weight="bold"
                />
                <div className="flex flex-col">
                  <span className="text-sm text-white light:text-slate-900">
                    {config[option].label}
                  </span>
                  {option === defaultMode && (
                    <span className="text-[10px] text-white/50 light:text-slate-500">
                      {t("chat_window.controls.fileAccess.globalDefault")}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}

function ToolsButton({
  showTools,
  setShowTools,
  textareaRef,
  autoOpenedToolsRef,
}) {
  const { t } = useTranslation();

  return (
    <button
      id="tools-btn"
      type="button"
      onClick={() => {
        autoOpenedToolsRef.current = false;
        setShowTools(!showTools);
        textareaRef.current?.focus();
      }}
      className={`group border-none cursor-pointer flex items-center justify-center h-6 px-2 rounded-full ${
        showTools
          ? "bg-zinc-700 light:bg-slate-200"
          : "hover:bg-zinc-700 light:hover:bg-slate-200"
      }`}
    >
      <span
        className={`text-sm font-medium ${
          showTools
            ? "text-white light:text-slate-800"
            : "text-zinc-300 light:text-slate-600 group-hover:text-white light:group-hover:text-slate-800"
        }`}
      >
        {t("chat_window.tools")}
      </span>
    </button>
  );
}

function SendPromptButton({
  formRef,
  hasPromptInput,
  isDisabled,
  disabledReason = null,
}) {
  const { t } = useTranslation();
  const disabledTooltip =
    disabledReason === "ocr"
      ? t("chat_window.ocr_processing", {
          defaultValue: "OCR recognition is processing. Please wait...",
        })
      : t("chat_window.attachments_processing");

  return (
    <>
      <button
        ref={formRef}
        type="submit"
        disabled={isDisabled || !hasPromptInput}
        className={`border-none flex justify-center items-center rounded-full w-8 h-8 motion-hover ${
          hasPromptInput && !isDisabled
            ? "cursor-pointer bg-white hover:bg-zinc-200 light:bg-blue-500 light:hover:bg-blue-600"
            : "cursor-not-allowed bg-zinc-600 light:bg-slate-300"
        }`}
        data-tooltip-id="send-prompt"
        data-tooltip-content={
          isDisabled ? disabledTooltip : t("chat_window.send")
        }
        aria-label={t("chat_window.send")}
      >
        <ArrowUp
          className="w-[18px] h-[18px] pointer-events-none text-zinc-800 light:text-white"
          weight="bold"
        />
        <span className="sr-only">{t("chat_window.send")}</span>
      </button>
      <Tooltip
        id="send-prompt"
        place="bottom"
        delayShow={300}
        className="tooltip !text-xs z-99"
      />
    </>
  );
}

/**
 * Handle event listeners to prevent the send button from being used
 * for whatever reason that may we may want to prevent the user from sending a message.
 */
function useIsDisabled() {
  const [isDisabled, setIsDisabled] = useState(false);

  /**
   * Handle attachments processing and processed events
   * to prevent the send button from being clicked when attachments are processing
   * or else the query may not have relevant context since RAG is not yet ready.
   */
  useEffect(() => {
    if (!window) return;
    const onProcessing = () => setIsDisabled(true);
    const onProcessed = () => setIsDisabled(false);

    window.addEventListener(ATTACHMENTS_PROCESSING_EVENT, onProcessing);
    window.addEventListener(ATTACHMENTS_PROCESSED_EVENT, onProcessed);

    return () => {
      window.removeEventListener(ATTACHMENTS_PROCESSING_EVENT, onProcessing);
      window.removeEventListener(ATTACHMENTS_PROCESSED_EVENT, onProcessed);
    };
  }, []);

  return { isDisabled };
}
