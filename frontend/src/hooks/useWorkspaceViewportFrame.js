import { useEffect } from "react";
import { tabletDesktopRuntimeActive } from "@/utils/mobileRuntime";
import { resolveWorkspaceViewportFrame } from "@/utils/workspaceViewport";

const VIEWPORT_CLASS = "athena-workspace-viewport-active";
const HEIGHT_VAR = "--athena-workspace-viewport-height";
const OFFSET_TOP_VAR = "--athena-workspace-viewport-offset-top";
const KEYBOARD_INSET_VAR = "--athena-workspace-keyboard-inset";

function captureInlineStyle(element, properties) {
  if (!element) return null;
  return Object.fromEntries(
    properties.map((property) => [property, element.style[property]])
  );
}

function restoreInlineStyle(element, snapshot) {
  if (!element || !snapshot) return;
  for (const [property, value] of Object.entries(snapshot)) {
    element.style[property] = value;
  }
}

/**
 * Pins the desktop workspace shell to the visible tablet viewport. This is
 * deliberately workspace-scoped so settings/login pages retain their normal
 * document scrolling behavior.
 */
export default function useWorkspaceViewportFrame({ enabled = null } = {}) {
  const shouldEnable =
    enabled ??
    (typeof window !== "undefined" && tabletDesktopRuntimeActive(window));

  useEffect(() => {
    if (!shouldEnable || typeof window === "undefined") return undefined;

    const root = document.documentElement;
    const body = document.body;
    const appRoot = document.getElementById("root");
    const inlineProperties = [
      "height",
      "width",
      "overflow",
      "overscrollBehavior",
    ];
    const previous = {
      root: captureInlineStyle(root, inlineProperties),
      body: captureInlineStyle(body, inlineProperties),
      appRoot: captureInlineStyle(appRoot, inlineProperties),
      height: root.style.getPropertyValue(HEIGHT_VAR),
      offsetTop: root.style.getPropertyValue(OFFSET_TOP_VAR),
      keyboardInset: root.style.getPropertyValue(KEYBOARD_INSET_VAR),
    };
    let frame = null;
    let orientationTimer = null;

    root.classList.add(VIEWPORT_CLASS);
    for (const element of [root, body, appRoot]) {
      if (!element) continue;
      element.style.height = "100%";
      element.style.width = "100%";
      element.style.overflow = "hidden";
      element.style.overscrollBehavior = "none";
    }

    const applyFrame = () => {
      frame = null;
      const next = resolveWorkspaceViewportFrame(window);
      root.style.setProperty(HEIGHT_VAR, `${next.height}px`);
      root.style.setProperty(OFFSET_TOP_VAR, `${next.offsetTop}px`);
      root.style.setProperty(KEYBOARD_INSET_VAR, `${next.keyboardInset}px`);
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };

    const scheduleFrame = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(applyFrame);
    };

    const handleOrientationChange = () => {
      scheduleFrame();
      window.clearTimeout(orientationTimer);
      orientationTimer = window.setTimeout(scheduleFrame, 250);
    };

    applyFrame();
    window.addEventListener("resize", scheduleFrame, { passive: true });
    window.addEventListener("orientationchange", handleOrientationChange, {
      passive: true,
    });
    window.visualViewport?.addEventListener("resize", scheduleFrame, {
      passive: true,
    });
    window.visualViewport?.addEventListener("scroll", scheduleFrame, {
      passive: true,
    });

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.clearTimeout(orientationTimer);
      window.removeEventListener("resize", scheduleFrame);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.visualViewport?.removeEventListener("resize", scheduleFrame);
      window.visualViewport?.removeEventListener("scroll", scheduleFrame);
      root.classList.remove(VIEWPORT_CLASS);
      restoreInlineStyle(root, previous.root);
      restoreInlineStyle(body, previous.body);
      restoreInlineStyle(appRoot, previous.appRoot);

      for (const [property, value] of [
        [HEIGHT_VAR, previous.height],
        [OFFSET_TOP_VAR, previous.offsetTop],
        [KEYBOARD_INSET_VAR, previous.keyboardInset],
      ]) {
        if (value) root.style.setProperty(property, value);
        else root.style.removeProperty(property);
      }
    };
  }, [shouldEnable]);
}
