import { showAppConfirm } from "@/components/lib/AppConfirmDialog/confirm";

export function confirmSignOut(options = {}) {
  return showAppConfirm({
    tone: "danger",
    title: options.title || "确认退出登录？",
    description:
      options.description ||
      "退出后，此设备上的当前会话会被清除。你可以稍后重新登录。",
    confirmText: options.confirmText || "退出登录",
    cancelText: options.cancelText || "取消",
    closeOnBackdrop: true,
    closeOnEscape: true,
  });
}
