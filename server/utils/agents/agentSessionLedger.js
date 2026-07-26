const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { safeJsonParse } = require("../http");
const { storageRoot: environmentStorageRoot } = require("../environment");

const MAX_PARTIAL_TEXT_PREVIEW_CHARS = 1_000;
const MAX_EVENT_CONTENT_CHARS = 1_000;
const MAX_LEDGER_EVENTS = 500;
const ACCOUNT_PRIVATE_SENSITIVITY = "account-private";
const ACCOUNT_PRIVATE_REDACTION = "[account-private output redacted]";

function storageRoot() {
  return environmentStorageRoot();
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

function sha256(value = "") {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function accountPrivateToolEvent(payload = {}, eventType = "") {
  if (eventType !== "toolCallInvocation") return false;
  const content =
    payload?.content && typeof payload.content === "object"
      ? payload.content
      : {};
  return String(content.toolName || payload.toolName || "").startsWith(
    "crypto_account_"
  );
}

function redactAccountPrivatePayload(payload = {}, eventType = "") {
  const next = { ...payload };
  const content =
    next.content && typeof next.content === "object"
      ? { ...next.content }
      : next.content;

  if (next.type === "reportStreamEvent" && content?.type) {
    if (content.type === "textResponseChunk") {
      const raw = content.content || content.textResponse || "";
      next.content = {
        ...content,
        content: "",
        textResponse: "",
        redacted: true,
        contentHash: sha256(raw),
      };
      return next;
    }
    if (content.type === "fullTextResponse") {
      next.content = {
        ...content,
        content: ACCOUNT_PRIVATE_REDACTION,
        redacted: true,
        contentHash: sha256(content.content || ""),
      };
      return next;
    }
    if (content.type === "toolCallResult") {
      next.content = {
        ...content,
        content: "Private account tool completed.",
        summary: "Private account tool completed.",
        outputPreview: "",
        redacted: true,
      };
      return next;
    }
  }

  if (eventType === "fullTextResponse" && typeof content === "string") {
    next.content = ACCOUNT_PRIVATE_REDACTION;
    next.redacted = true;
    next.contentHash = sha256(content);
  }
  return next;
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
  const alreadyCompleted =
    current.terminal === true && current.status === "completed";
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
    partialTextPreview:
      record.eventType === "fullTextResponse"
        ? truncate(text, MAX_PARTIAL_TEXT_PREVIEW_CHARS)
        : truncate(
            `${current.partialTextPreview || ""}${text}`,
            MAX_PARTIAL_TEXT_PREVIEW_CHARS
          ),
    sensitivity: record.sensitivity || current.sensitivity || "metadata-only",
    status: alreadyCompleted
      ? "completed"
      : record.eventType === "chatId"
        ? "completed"
        : record.eventType === "fullTextResponse"
          ? "finalizing"
          : record.eventType === "wssFailure"
            ? "failed"
            : current.status || "running",
    terminal:
      record.eventType === "chatId" || record.eventType === "wssFailure"
        ? true
        : current.terminal || false,
    retryable:
      record.eventType === "chatId" || record.eventType === "wssFailure"
        ? false
        : current.retryable !== false,
    finalChatId:
      record.eventType === "chatId"
        ? Number(content.chatId || 0) || current.finalChatId || null
        : current.finalChatId || null,
    finalPublicChatId:
      record.eventType === "chatId"
        ? content.publicChatId || current.finalPublicChatId || null
        : current.finalPublicChatId || null,
    clientTurnId: content.clientTurnId || current.clientTurnId || null,
    errorCode:
      record.eventType === "wssFailure"
        ? content.code ||
          content.errorCode ||
          record.payload?.code ||
          record.payload?.errorCode ||
          "agent_connection_failed"
        : current.errorCode || null,
  };
  writeJson(statePath(uuid), next);
  return next;
}

function recordAgentSessionEvent(uuid, rawPayload = {}) {
  if (!uuid || !rawPayload || typeof rawPayload !== "object") return null;
  ensureSessionDir(uuid);
  const seq = nextSeq(uuid);
  const { payload, eventType } = normalizePayload(rawPayload);
  const currentState = readJson(statePath(uuid), null);
  const accountPrivate =
    currentState?.sensitivity === ACCOUNT_PRIVATE_SENSITIVITY ||
    accountPrivateToolEvent(payload, eventType);
  const deliveryPayload = {
    ...payload,
    seq,
    ...(payload.type === "reportStreamEvent" &&
    payload.content &&
    typeof payload.content === "object"
      ? { content: { ...payload.content, seq } }
      : {}),
  };
  const record = {
    seq,
    eventType,
    payload: accountPrivate
      ? redactAccountPrivatePayload(deliveryPayload, eventType)
      : deliveryPayload,
    createdAt: Date.now(),
    ...(accountPrivate ? { sensitivity: ACCOUNT_PRIVATE_SENSITIVITY } : {}),
  };
  Object.defineProperty(record, "deliveryPayload", {
    value: deliveryPayload,
    enumerable: false,
  });
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

function sanitizeAccountPrivateSessionLedgers({ apply = false } = {}) {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) {
    return { scannedSessions: 0, matchedSessions: 0, redactedEvents: 0 };
  }

  let scannedSessions = 0;
  let matchedSessions = 0;
  let redactedEvents = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    scannedSessions += 1;
    const uuid = entry.name;
    const events = readEvents(uuid);
    const privateStart = events.findIndex((event) =>
      accountPrivateToolEvent(event.payload, event.eventType)
    );
    if (privateStart === -1) continue;
    matchedSessions += 1;

    const sanitized = events.map((event, index) => {
      if (index < privateStart) return event;
      const payload = redactAccountPrivatePayload(
        event.payload,
        event.eventType
      );
      if (JSON.stringify(payload) !== JSON.stringify(event.payload)) {
        redactedEvents += 1;
      }
      return {
        ...event,
        payload,
        sensitivity: ACCOUNT_PRIVATE_SENSITIVITY,
      };
    });

    if (!apply) continue;
    fs.writeFileSync(
      eventsPath(uuid),
      `${sanitized.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8"
    );
    const state = readJson(statePath(uuid), null);
    if (state) {
      writeJson(statePath(uuid), {
        ...state,
        sensitivity: ACCOUNT_PRIVATE_SENSITIVITY,
        partialTextPreview: ACCOUNT_PRIVATE_REDACTION,
      });
    }
  }

  return { scannedSessions, matchedSessions, redactedEvents };
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
  sanitizeAccountPrivateSessionLedgers,
};
