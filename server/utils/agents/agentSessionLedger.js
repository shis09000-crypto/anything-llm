const fs = require("fs");
const path = require("path");
const { safeJsonParse } = require("../http");

const MAX_PARTIAL_TEXT_PREVIEW_CHARS = 1_000;
const MAX_EVENT_CONTENT_CHARS = 1_000;
const MAX_LEDGER_EVENTS = 500;

function storageRoot() {
  return process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");
}

function sessionsRoot() {
  return path.join(storageRoot(), "agent-sessions");
}

function sessionDir(uuid) {
  return path.join(sessionsRoot(), String(uuid));
}

function eventsPath(uuid) {
  return path.join(sessionDir(uuid), "events.jsonl");
}

function statePath(uuid) {
  return path.join(sessionDir(uuid), "state.json");
}

function truncate(value = "", maxChars = MAX_EVENT_CONTENT_CHARS) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function ensureSessionDir(uuid) {
  fs.mkdirSync(sessionDir(uuid), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readEvents(uuid) {
  try {
    const filePath = eventsPath(uuid);
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => safeJsonParse(line, null))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function latestSeq(uuid) {
  const events = readEvents(uuid);
  return events.at(-1)?.seq || 0;
}

function nextSeq(uuid) {
  const state = readJson(statePath(uuid), null);
  return Number(state?.latestSeq || latestSeq(uuid) || 0) + 1;
}

function normalizePayload(rawPayload = {}) {
  const payload = { ...rawPayload };
  const content =
    payload.content && typeof payload.content === "object"
      ? { ...payload.content }
      : payload.content;
  const eventType =
    payload.type === "reportStreamEvent" && content?.type
      ? content.type
      : !payload.type && payload.content
        ? "fullTextResponse"
        : payload.type || "unknown";

  if (payload.type === "reportStreamEvent" && content?.type) {
    if (content.type === "textResponseChunk") {
      content.content = truncate(content.content || content.textResponse || "");
      content.textResponse = content.content;
    }
    if (content.type === "fullTextResponse") {
      content.content = truncate(content.content || "");
    }
    if (content.type === "toolCallResult") {
      content.content = truncate(content.summary || content.content || "");
      content.outputPreview = truncate(content.outputPreview || "", 500);
    }
  }

  if (payload.type === "statusResponse") {
    payload.content = truncate(payload.content || "");
  } else {
    payload.content = content;
  }

  return { payload, eventType };
}

function isMeaningfulEvent(eventType) {
  return [
    "textResponseChunk",
    "fullTextResponse",
    "toolCallInvocation",
    "toolCallResult",
    "usageMetrics",
    "citations",
    "chatId",
    "statusResponse",
    "toolApprovalRequest",
    "wssFailure",
  ].includes(eventType);
}

function updateStateFromEvent(uuid, record) {
  const current = readJson(statePath(uuid), {
    uuid: String(uuid),
    status: "running",
    closed: false,
    latestSeq: 0,
    toolEventsCount: 0,
    partialTextPreview: "",
    lastMeaningfulOutputAt: null,
    retryable: true,
  });
  const content = record.payload?.content || {};
  const isToolEvent = ["toolCallInvocation", "toolCallResult"].includes(
    record.eventType
  );
  const text =
    record.eventType === "textResponseChunk"
      ? content.content || content.textResponse || ""
      : record.eventType === "fullTextResponse"
        ? typeof content === "string"
          ? content
          : content.content || ""
        : "";

  const next = {
    ...current,
    uuid: String(uuid),
    latestSeq: record.seq,
    toolEventsCount: current.toolEventsCount + (isToolEvent ? 1 : 0),
    lastMeaningfulOutputAt: isMeaningfulEvent(record.eventType)
      ? record.createdAt
      : current.lastMeaningfulOutputAt,
    partialTextPreview: truncate(
      `${current.partialTextPreview || ""}${text}`,
      MAX_PARTIAL_TEXT_PREVIEW_CHARS
    ),
    status:
      record.eventType === "fullTextResponse" || record.eventType === "chatId"
        ? "finalizing"
        : record.eventType === "wssFailure"
          ? "error"
          : current.status || "running",
  };
  writeJson(statePath(uuid), next);
  return next;
}

function recordAgentSessionEvent(uuid, rawPayload = {}) {
  if (!uuid || !rawPayload || typeof rawPayload !== "object") return null;
  ensureSessionDir(uuid);
  const seq = nextSeq(uuid);
  const { payload, eventType } = normalizePayload(rawPayload);
  const record = {
    seq,
    eventType,
    payload: {
      ...payload,
      seq,
      ...(payload.type === "reportStreamEvent" &&
      payload.content &&
      typeof payload.content === "object"
        ? { content: { ...payload.content, seq } }
        : {}),
    },
    createdAt: Date.now(),
  };
  fs.appendFileSync(eventsPath(uuid), `${JSON.stringify(record)}\n`, "utf8");
  updateStateFromEvent(uuid, record);

  if (seq > MAX_LEDGER_EVENTS && seq % 100 === 0) {
    const events = readEvents(uuid);
    fs.writeFileSync(
      eventsPath(uuid),
      events
        .slice(events.length - MAX_LEDGER_EVENTS)
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf8"
    );
  }
  return record;
}

function readAgentSessionEvents(uuid, afterSeq = 0) {
  return readEvents(uuid).filter((event) => Number(event.seq) > afterSeq);
}

function markAgentSessionState(uuid, patch = {}) {
  if (!uuid) return null;
  ensureSessionDir(uuid);
  const current = readJson(statePath(uuid), {
    uuid: String(uuid),
    status: "running",
    closed: false,
    latestSeq: latestSeq(uuid),
    toolEventsCount: 0,
    partialTextPreview: "",
    lastMeaningfulOutputAt: null,
    retryable: true,
  });
  const next = {
    ...current,
    ...patch,
    uuid: String(uuid),
    latestSeq: Math.max(current.latestSeq || 0, latestSeq(uuid)),
    updatedAt: Date.now(),
  };
  writeJson(statePath(uuid), next);
  return next;
}

function getAgentSessionState(uuid) {
  const state = readJson(statePath(uuid), null);
  if (!state) {
    return {
      uuid: String(uuid),
      status: "unknown",
      closed: false,
      latestSeq: latestSeq(uuid),
      retryable: false,
      toolEventsCount: readEvents(uuid).filter((event) =>
        ["toolCallInvocation", "toolCallResult"].includes(event.eventType)
      ).length,
      lastMeaningfulOutputAt: null,
      partialTextPreview: "",
    };
  }
  return {
    ...state,
    latestSeq: Math.max(state.latestSeq || 0, latestSeq(uuid)),
  };
}

module.exports = {
  getAgentSessionState,
  markAgentSessionState,
  readAgentSessionEvents,
  recordAgentSessionEvent,
};
