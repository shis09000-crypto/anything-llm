import { useEffect, useRef, useState } from "react";
import { GitBranch, GitFork } from "@phosphor-icons/react";
import { isMobile } from "react-device-detect";
import useLoginMode from "@/hooks/useLoginMode";
import WorkspaceHealthBeacon from "@/components/WorkspaceHealthBeacon";
import { WorkspaceHealthProvider } from "@/contexts/WorkspaceHealthProvider";

const MIND_MAP_REVEAL_DELAY_MS = 125;
const HIDE_DELAY_MS = 2000;
const FADE_OUT_MS = 700;

export default function TopRightActionZone({
  isMindMapOpen = false,
  onMindMap,
  onDualThreadFork,
  dualThreadMode = false,
  workspaceSlug,
}) {
  const mode = useLoginMode();
  const hasUserIcon = mode !== null;
  const revealTimer = useRef(null);
  const hideTimer = useRef(null);
  const interactionTimer = useRef(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isInteractive, setIsInteractive] = useState(!isMindMapOpen);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (!isMindMapOpen) {
      clearTimers();
      setIsInteractive(true);
      return;
    }
    if (!isMindMapOpen) return;
    clearTimers();
    setIsRevealed(false);
    setIsInteractive(false);
  }, [isMindMapOpen]);

  function clearTimers() {
    clearTimeout(revealTimer.current);
    clearTimeout(hideTimer.current);
    clearTimeout(interactionTimer.current);
  }

  function reveal({ delayed = false } = {}) {
    clearTimers();
    setIsInteractive(true);
    if (!delayed) {
      setIsRevealed(true);
      return;
    }
    revealTimer.current = setTimeout(() => {
      setIsRevealed(true);
    }, MIND_MAP_REVEAL_DELAY_MS);
  }

  function scheduleHide() {
    clearTimeout(revealTimer.current);
    clearTimeout(hideTimer.current);
    clearTimeout(interactionTimer.current);
    hideTimer.current = setTimeout(() => {
      setIsRevealed(false);
      interactionTimer.current = setTimeout(() => {
        setIsInteractive(false);
      }, FADE_OUT_MS);
    }, HIDE_DELAY_MS);
  }

  if (isMobile || dualThreadMode) return null;

  const hiddenOpacity = isMindMapOpen ? "opacity-0" : "opacity-25";

  return (
    <div
      className={`absolute top-3 md:top-5 z-30 h-[126px] w-[40px] ${hasUserIcon ? "right-[55px] md:right-[67px]" : "right-4 md:right-6"}`}
      onPointerEnter={() => reveal({ delayed: isMindMapOpen })}
      onPointerLeave={scheduleHide}
      onFocusCapture={() => reveal()}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        scheduleHide();
      }}
    >
      <WorkspaceHealthProvider workspaceSlug={workspaceSlug}>
        <WorkspaceHealthBeacon workspaceSlug={workspaceSlug} />
      </WorkspaceHealthProvider>
      <div
        className={`mt-2 flex flex-col items-center gap-2 motion-hover ${
          isRevealed
            ? "opacity-100 translate-y-0"
            : `${hiddenOpacity} translate-y-1`
        } ${isInteractive ? "pointer-events-auto" : "pointer-events-none"}`}
        style={{
          transitionDuration: isRevealed ? "200ms" : `${FADE_OUT_MS}ms`,
        }}
      >
        <MindMapQuickEntry onOpen={onMindMap} />
        <DualThreadQuickEntry onOpen={onDualThreadFork} />
      </div>
    </div>
  );
}

function MindMapQuickEntry({ onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="进入思维导图"
      aria-label="进入思维导图"
      className="liquid-glass-control group cursor-pointer flex items-center justify-center w-[35px] h-[35px] rounded-full"
    >
      <GitFork
        size={18}
        className="text-zinc-200 light:text-slate-600 group-hover:text-white light:group-hover:text-blue-600"
      />
    </button>
  );
}

function DualThreadQuickEntry({ onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="双线程分支模式"
      aria-label="双线程分支模式"
      className="liquid-glass-control group cursor-pointer flex items-center justify-center w-[35px] h-[35px] rounded-full"
    >
      <GitBranch
        size={18}
        className="text-zinc-200 light:text-slate-600 group-hover:text-white light:group-hover:text-blue-600"
      />
    </button>
  );
}
