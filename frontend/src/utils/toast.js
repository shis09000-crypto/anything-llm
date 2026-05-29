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
  return {
    title: opts.title ?? message,
    description: opts.description,
  };
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

  const id = opts.toastId || `app-toast-${nextToastId++}`;
  const nextToast = {
    id,
    type: normalizeType(type),
    duration: resolveDuration(opts),
    dismissOnClick: resolveDismissOnClick(opts),
    pauseOnHover: opts.pauseOnHover !== false,
    closable: opts.closable ?? opts.closeButton !== false,
    className: opts.className || "",
    ...resolveToastContent(message, opts),
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
