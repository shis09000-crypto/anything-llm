const LOGIN_BOOT_DEBUG_KEY = "loginBootPerfDebug";
const LOGIN_BOOT_STATE_KEY = "__athenaLoginBootPerf";

function nowMs() {
  return Math.round(globalThis.performance?.now?.() ?? Date.now());
}

function shouldDebug() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LOGIN_BOOT_DEBUG_KEY) === "true";
  } catch {
    return false;
  }
}

function state() {
  if (typeof window === "undefined") return { marks: [] };
  window[LOGIN_BOOT_STATE_KEY] ||= {
    startedAt: nowMs(),
    marks: [],
  };
  return window[LOGIN_BOOT_STATE_KEY];
}

export function markLoginBoot(name, detail = {}) {
  if (!name || typeof window === "undefined") return;
  const bootState = state();
  const mark = {
    name,
    at: nowMs(),
    elapsedMs: nowMs() - bootState.startedAt,
    detail,
  };
  bootState.marks.push(mark);
  try {
    globalThis.performance?.mark?.(`athena:${name}`);
  } catch {}
  if (shouldDebug()) console.debug("[login-boot]", mark);
}

export function loginBootMarks() {
  return [...state().marks];
}
