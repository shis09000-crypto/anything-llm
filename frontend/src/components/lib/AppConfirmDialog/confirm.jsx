import React, { useEffect, useState } from "react";
import { Info, Question, Warning, WarningCircle } from "@phosphor-icons/react";
import AppButton from "@/components/lib/AppButton";
import AppConfirmDialog from ".";

const TONE_ICONS = {
  default: Question,
  info: Info,
  warning: Warning,
  danger: WarningCircle,
};

let requestId = 0;
let activeRequest = null;
const queue = [];
const listeners = new Set();

function fallbackConfirm(options = {}) {
  if (typeof window === "undefined") return false;
  const message = [options.title, options.description]
    .filter(Boolean)
    .join("\n\n");
  return window.confirm(message || "确认执行此操作？");
}

function emit() {
  if (!activeRequest && queue.length > 0) activeRequest = queue.shift();
  listeners.forEach((listener) => listener(activeRequest));
}

export function showAppConfirm(options = {}) {
  if (listeners.size === 0) return Promise.resolve(fallbackConfirm(options));

  return new Promise((resolve) => {
    queue.push({
      id: ++requestId,
      options,
      resolve,
    });
    emit();
  });
}

function settleActiveRequest(value) {
  if (!activeRequest) return;
  const request = activeRequest;
  activeRequest = null;
  request.resolve(Boolean(value));
  emit();
}

function subscribeToAppConfirms(listener) {
  listeners.add(listener);
  listener(activeRequest);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (activeRequest) {
      activeRequest.resolve(false);
      activeRequest = null;
    }
    while (queue.length > 0) queue.shift().resolve(false);
  };
}

export function AppConfirmDialogHost() {
  const [request, setRequest] = useState(null);

  useEffect(() => subscribeToAppConfirms(setRequest), []);

  if (!request) return null;

  const {
    tone = "default",
    title = "",
    description = "",
    body = null,
    icon = null,
    confirmText = "确认",
    cancelText = "取消",
    confirmButtonSize = "md",
    cancelButtonSize = "md",
    confirmButtonClassName = "",
    closeOnBackdrop = false,
    closeOnEscape = false,
  } = request.options || {};
  const Icon = icon ? null : TONE_ICONS[tone] || TONE_ICONS.default;
  const dangerClass =
    tone === "danger" ? "app-confirm-dialog-danger-action" : "";

  return (
    <AppConfirmDialog
      open
      tone={tone}
      title={title}
      description={description}
      icon={icon || (Icon ? <Icon weight="bold" /> : null)}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEscape={closeOnEscape}
      onClose={() => settleActiveRequest(false)}
      footer={
        <>
          <AppButton
            variant="secondary"
            size={cancelButtonSize}
            onClick={() => settleActiveRequest(false)}
          >
            {cancelText}
          </AppButton>
          <AppButton
            size={confirmButtonSize}
            onClick={() => settleActiveRequest(true)}
            className={[dangerClass, confirmButtonClassName]
              .filter(Boolean)
              .join(" ")}
          >
            {confirmText}
          </AppButton>
        </>
      }
    >
      {body}
    </AppConfirmDialog>
  );
}
