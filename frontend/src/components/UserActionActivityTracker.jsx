import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import {
  recordLocalUserAction,
  recordServerUserAction,
  USER_ACTION_REASONS,
} from "@/utils/userAction";

export default function UserActionActivityTracker() {
  const location = useLocation();
  const previousPathRef = useRef(location.pathname);

  useEffect(() => {
    const nextPath = location.pathname;
    const previousPath = previousPathRef.current;
    previousPathRef.current = nextPath;
    if (previousPath === nextPath) return;

    recordServerUserAction(routeActionReason(previousPath, nextPath));
  }, [location.pathname]);

  useEffect(() => {
    const handleLocalInput = (event) => {
      const target = event.target;
      if (!isUserInput(target)) return;
      recordLocalUserAction();
    };

    const handleSubmit = (event) => {
      const reason = event.target?.dataset?.userActionReason;
      recordServerUserAction(
        allowedReason(reason) || USER_ACTION_REASONS.securityAction
      );
    };

    const handleFileChange = (event) => {
      if (event.target?.matches?.('input[type="file"]')) {
        recordServerUserAction(USER_ACTION_REASONS.fileUpload);
      }
    };

    const handleDrop = (event) => {
      if (event.dataTransfer?.files?.length) {
        recordServerUserAction(USER_ACTION_REASONS.fileUpload);
      }
    };

    const handleClick = (event) => {
      const target = event.target?.closest?.(
        'button,a,[role="button"],input[type="button"],input[type="submit"],.app-button'
      );
      if (!target) return;
      const reason =
        allowedReason(target.dataset?.userActionReason) ||
        linkActionReason(target) ||
        USER_ACTION_REASONS.buttonClick;
      recordServerUserAction(reason);
    };

    document.addEventListener("input", handleLocalInput, true);
    document.addEventListener("change", handleFileChange, true);
    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("drop", handleDrop, true);
    document.addEventListener("click", handleClick, true);

    return () => {
      document.removeEventListener("input", handleLocalInput, true);
      document.removeEventListener("change", handleFileChange, true);
      document.removeEventListener("submit", handleSubmit, true);
      document.removeEventListener("drop", handleDrop, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}

function isUserInput(target) {
  return target?.matches?.("input,textarea,[contenteditable='true']");
}

function allowedReason(reason) {
  return Object.values(USER_ACTION_REASONS).includes(reason) ? reason : null;
}

function linkActionReason(target) {
  const href = target?.getAttribute?.("href") || "";
  if (!href) return null;
  const pathname = href.startsWith("http")
    ? safeUrlPath(href)
    : href.split("#")[0].split("?")[0];
  if (!pathname) return null;
  return routeActionReason(window.location.pathname, pathname);
}

function routeActionReason(previousPath, nextPath) {
  const previous = workspaceRoute(previousPath);
  const next = workspaceRoute(nextPath);

  if (previous.slug && next.slug && previous.slug !== next.slug) {
    return USER_ACTION_REASONS.workspaceSwitch;
  }
  if (
    next.slug &&
    next.threadSlug &&
    (previous.slug !== next.slug || previous.threadSlug !== next.threadSlug)
  ) {
    return USER_ACTION_REASONS.threadSwitch;
  }
  if (isKnowledgeRoute(nextPath)) return USER_ACTION_REASONS.knowledgeOpen;
  return USER_ACTION_REASONS.pageNavigation;
}

function workspaceRoute(pathname = "") {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "workspace") return { slug: null, threadSlug: null };
  return {
    slug: parts[1] || null,
    threadSlug: parts[2] === "t" ? parts[3] || null : null,
  };
}

function isKnowledgeRoute(pathname = "") {
  return /knowledge|documents|workspace-settings|data-connectors/i.test(
    pathname
  );
}

function safeUrlPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}
