const DEFAULT_TOAST_DURATION = 2_600;
const MAX_VISIBLE_TOASTS = 5;
const TOAST_TYPES = new Set(["success", "info", "warning", "error"]);

let nextToastId = 1;
let toasts = [];
const listeners = new Set();

function emitToastChange() {
  listeners.forEach((listener) => listener([...toasts]));
}

function normalizeType(type) {
  return TOAST_TYPES.has(type) ? type : "info";
}

function resolveDuration(opts = {}) {
  if (opts.autoClose === false || opts.duration === false) return 0;
  if (Number.isFinite(opts.duration)) return opts.duration;
  if (Number.isFinite(opts.autoClose)) return opts.autoClose;
  return DEFAULT_TOAST_DURATION;
}

function resolveDismissOnClick(opts = {}) {
  if (typeof opts.dismissOnClick === "boolean") return opts.dismissOnClick;
  if (typeof opts.closeOnClick === "boolean") return opts.closeOnClick;
  return true;
}

function resolveToastContent(message, opts = {}) {
  const type = normalizeType(opts.type);
  const normalizedMessage = normalizeToastMessage(message, type);
  return {
    title: opts.title ?? normalizedMessage,
    description: opts.description,
  };
}

function normalizeToastMessage(message, type = "info") {
  const fallbackByType = {
    success: "操作成功。",
    info: "已更新。",
    warning: "请检查后重试。",
    error: "操作失败，请稍后重试。",
  };
  const text =
    typeof message === "string" ? message.trim() : String(message || "").trim();
  if (!text) return fallbackByType[type] || fallbackByType.info;

  if (
    /failed to fetch/i.test(text) ||
    /networkerror/i.test(text) ||
    /load failed/i.test(text)
  ) {
    return "无法连接服务，请确认后端已启动后重试。";
  }

  if (/not found/i.test(text))
    return "服务接口不存在，请刷新或重启后端后重试。";
  return text;
}

export function subscribeToToasts(listener) {
  listeners.add(listener);
  listener([...toasts]);
  return () => listeners.delete(listener);
}

export function dismissToast(id) {
  toasts = toasts.filter((toast) => toast.id !== id);
  emitToastChange();
}

export function clearToasts() {
  toasts = [];
  emitToastChange();
}

// Additional Configs (opts)
// clear: false, // Dismisses all visible toasts before rendering the next toast.
// autoClose: false, // Keeps the toast visible until the user closes it.
const showToast = (message, type = "default", opts = {}) => {
  if (opts?.clear === true) clearToasts();

  const normalizedType = normalizeType(type);
  const id = opts.toastId || `app-toast-${nextToastId++}`;
  const nextToast = {
    id,
    type: normalizedType,
    duration: resolveDuration(opts),
    dismissOnClick: resolveDismissOnClick(opts),
    pauseOnHover: opts.pauseOnHover !== false,
    closable: opts.closable ?? opts.closeButton !== false,
    className: opts.className || "",
    ...resolveToastContent(message, { ...opts, type: normalizedType }),
  };

  const existingIndex = toasts.findIndex((toast) => toast.id === id);
  if (existingIndex >= 0) {
    toasts = [
      ...toasts.slice(0, existingIndex),
      nextToast,
      ...toasts.slice(existingIndex + 1),
    ];
  } else {
    toasts = [...toasts, nextToast].slice(-MAX_VISIBLE_TOASTS);
  }

  emitToastChange();
  return id;
};

export default showToast;
