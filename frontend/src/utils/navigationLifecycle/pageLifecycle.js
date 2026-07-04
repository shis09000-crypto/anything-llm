import { navigationLifecycle } from "./navigationLifecycleCenter.js";

let installed = false;
let teardown = null;

function canUseBrowserLifecycle() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function installNavigationPageLifecycle(
  center = navigationLifecycle,
  options = {}
) {
  if (!canUseBrowserLifecycle()) return () => {};
  if (installed && !options.force) return teardown || (() => {});
  if (teardown) teardown();

  const onVisibilityChange = () => {
    center.pageEvent(document.hidden ? "hidden" : "visible", {
      reason: document.hidden ? "visibility-hidden" : "visibility-visible",
    });
  };
  const onPageHide = (event) => {
    center.pageEvent("pagehide", {
      reason: event?.persisted ? "pagehide-bfcache" : "pagehide",
    });
  };
  const onPageShow = (event) => {
    center.pageEvent("pageshow", {
      reason: event?.persisted ? "pageshow-bfcache" : "pageshow",
    });
  };
  const onBeforeUnload = () => {
    center.pageEvent("beforeunload", { reason: "beforeunload" });
  };
  const onBlur = () => {
    center.pageEvent("blur", { reason: "window-blur" });
  };
  const onFocus = () => {
    center.pageEvent("focus", { reason: "window-focus" });
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);

  installed = true;
  teardown = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    installed = false;
    teardown = null;
  };
  return teardown;
}

export default installNavigationPageLifecycle;
