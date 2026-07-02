import { taskScheduler } from "./taskScheduler.js";

export const TASK_PRIORITIES = {
  activeIntent: "P0",
  visibleSupport: "P1",
  backgroundContinuation: "P2",
  prefetch: "P3",
  maintenance: "P4",
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEV_UNSCHEDULED_WARNED = new Set();

const HIGH_RISK_PATTERNS = [
  /\/request-token\b/i,
  /\/auth\b/i,
  /\/logout\b/i,
  /\/password\b/i,
  /\/passkeys?\b/i,
  /\/email-verification\b/i,
  /\/system\/user\/state\b/i,
  /\/system\/user\b/i,
  /\/system\/api-keys?\b/i,
  /\/vault\b/i,
  /\/zk-login\b/i,
  /\/client-identity\/revoke\b/i,
  /\/devices?\/(trust|revoke|rotate)\b/i,
  /\/delete-account\b/i,
];

function normalizeMethod(method = "GET") {
  return String(method || "GET").toUpperCase();
}

function normalizePath(path = "") {
  if (!path) return "/";
  try {
    if (/^https?:\/\//i.test(path)) return new URL(path).pathname;
  } catch {}
  return String(path);
}

function isHighRiskPath(path) {
  const normalizedPath = normalizePath(path);
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function policyForPriority(priority) {
  switch (priority) {
    case "P0":
      return "foreground";
    case "P1":
      return "visible";
    case "P3":
      return "prefetch";
    case "P4":
      return "maintenance";
    default:
      return "background";
  }
}

function routeFromScene(scene, path, transport) {
  const value = String(scene || "").toLowerCase();
  const normalizedPath = normalizePath(path).toLowerCase();
  if (value.includes("crypto") || normalizedPath.includes("crypto"))
    return "crypto-center";
  if (value.includes("reader") || normalizedPath.includes("reader-document"))
    return "reader";
  if (value.includes("workspace-settings")) return "workspace-settings";
  if (value.includes("settings") || normalizedPath.startsWith("/system/"))
    return "settings";
  if (value.includes("workspace") || normalizedPath.includes("/workspace/"))
    return "workspace-chat";
  if (
    value.includes("auth") ||
    normalizedPath.includes("/auth") ||
    normalizedPath.includes("/request-token")
  )
    return "auth";
  if (transport === "stream") return "realtime";
  return "global";
}

function readPathIdentity(path) {
  const normalizedPath = normalizePath(path);
  const workspaceMatch = normalizedPath.match(/\/workspace\/([^/?#]+)/i);
  const threadMatch = normalizedPath.match(/\/(?:thread|t)\/([^/?#]+)/i);
  const readerMatch = normalizedPath.match(
    /\/reader-documents\/([^/?#]+)|\/reader\/documents\/([^/?#]+)/i
  );
  return {
    ...(workspaceMatch?.[1] ? { workspaceSlug: workspaceMatch[1] } : {}),
    ...(threadMatch?.[1] ? { threadSlug: threadMatch[1] } : {}),
    ...(readerMatch?.[1] || readerMatch?.[2]
      ? { readerDocumentId: readerMatch[1] || readerMatch[2] }
      : {}),
  };
}

function defaultKind({ transport, method, path, communicationScene }) {
  const normalizedPath = normalizePath(path).toLowerCase();
  const scene = String(communicationScene || "").toLowerCase();
  if (transport === "upload") return "upload";
  if (transport === "blob") {
    if (normalizedPath.includes("thumbnail")) return "reader-thumbnail";
    if (normalizedPath.includes("reader-documents")) return "reader-blob";
    return "blob";
  }
  if (transport === "stream") return "realtime-stream";
  if (scene.includes("crypto") || normalizedPath.includes("crypto"))
    return "crypto";
  if (scene.includes("reader") || normalizedPath.includes("reader-document"))
    return "reader";
  if (scene.includes("settings")) return "settings";
  if (scene.includes("workspace") || normalizedPath.includes("/workspace/"))
    return method === "GET" ? "workspace-read" : "workspace-write";
  if (isHighRiskPath(path)) return "security";
  return method === "GET" ? "api-read" : "api-write";
}

function defaultPriority({ method, path, transport, communicationScene }) {
  const normalizedPath = normalizePath(path).toLowerCase();
  const scene = String(communicationScene || "").toLowerCase();
  if (isHighRiskPath(path)) return "P0";
  if (WRITE_METHODS.has(method)) return "P1";
  if (transport === "upload") return "P1";
  if (transport === "stream") return scene.includes("chat") ? "P1" : "P2";
  if (
    normalizedPath.includes("thumbnail") ||
    normalizedPath.includes("classification") ||
    normalizedPath.includes("postprocess") ||
    scene.includes("maintenance")
  )
    return "P4";
  if (scene.includes("prefetch")) return "P3";
  if (scene.includes("current") || scene.includes("visible")) return "P1";
  return "P2";
}

function defaultDedupeKey({
  explicitDedupeKey,
  method,
  path,
  transport,
  communicationScene,
  protectedTask,
  priority,
}) {
  if (explicitDedupeKey !== undefined) return explicitDedupeKey;
  if (protectedTask || method !== "GET") return null;
  if (priority === "P0" || priority === "P1") return null;
  return `${transport}:${communicationScene || "default"}:${normalizePath(path)}`;
}

export function inferTaskMetadata({
  method = "GET",
  path = "",
  communicationScene = null,
  transport = "json",
  task = undefined,
} = {}) {
  if (task === false || task?.enabled === false) return { enabled: false };

  const explicitTask = task && typeof task === "object" ? task : {};
  const normalizedMethod = normalizeMethod(explicitTask.method || method);
  const highRisk = isHighRiskPath(path);
  const priority =
    explicitTask.priority ||
    defaultPriority({
      method: normalizedMethod,
      path,
      transport,
      communicationScene,
    });
  const protectedTask =
    explicitTask.protected ??
    (highRisk || (WRITE_METHODS.has(normalizedMethod) && priority !== "P4"));
  const kind =
    explicitTask.kind ||
    defaultKind({
      transport,
      method: normalizedMethod,
      path,
      communicationScene,
    });
  const route =
    explicitTask.scope?.route ||
    routeFromScene(communicationScene, path, transport);
  const scope = {
    transport,
    communicationScene: communicationScene || undefined,
    route,
    ...readPathIdentity(path),
    ...(explicitTask.scope || {}),
  };

  return {
    enabled: true,
    kind,
    label:
      explicitTask.label ||
      `${transport}:${normalizedMethod} ${normalizePath(path)}`,
    scope,
    priority,
    policy:
      explicitTask.policy ||
      (transport === "stream" ? "realtime" : policyForPriority(priority)),
    dedupeKey: defaultDedupeKey({
      explicitDedupeKey: explicitTask.dedupeKey,
      method: normalizedMethod,
      path,
      transport,
      communicationScene,
      protectedTask,
      priority,
    }),
    emergency: explicitTask.emergency === true,
    protected: protectedTask,
    abortable: explicitTask.abortable ?? !protectedTask,
    resumable: explicitTask.resumable ?? false,
    deadlineMs: explicitTask.deadlineMs,
    onAbort: explicitTask.onAbort,
    onResume: explicitTask.onResume,
    inferred: !task,
  };
}

export function schedulerAbortError(message = "Task aborted or stale.") {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
}

function warnUnscheduledRequest(
  metadata,
  { method, path, communicationScene }
) {
  if (!metadata.inferred) return;
  if (typeof window === "undefined" || !import.meta.env.DEV) return;
  const key = `${method}:${path}:${communicationScene || ""}`;
  if (DEV_UNSCHEDULED_WARNED.has(key)) return;
  DEV_UNSCHEDULED_WARNED.add(key);
  console.warn("[TaskScheduler] unscheduled request inferred", {
    method,
    path,
    communicationScene,
    task: {
      kind: metadata.kind,
      priority: metadata.priority,
      scope: metadata.scope,
    },
  });
}

export async function runScheduledTaskRequest(operation, request = {}) {
  const metadata = inferTaskMetadata(request);
  if (!metadata.enabled) {
    return operation({ signal: request.signal, handle: null });
  }

  warnUnscheduledRequest(metadata, request);
  const schedule = metadata.emergency
    ? taskScheduler.scheduleEmergency.bind(taskScheduler)
    : taskScheduler.schedule.bind(taskScheduler);
  const handle = schedule(
    ({ signal, handle: taskHandle }) =>
      operation({ signal, handle: taskHandle }),
    {
      ...metadata,
      signal: request.signal,
    }
  );
  const result = await handle.promise;
  if (result === null) throw schedulerAbortError();
  return result;
}
