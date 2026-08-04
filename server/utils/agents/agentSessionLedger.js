const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { safeJsonParse } = require("../http");
const { storageRoot: environmentStorageRoot } = require("../environment");

const MAX_PARTIAL_TEXT_PREVIEW_CHARS = 1_000;
const MAX_EVENT_CONTENT_CHARS = 1_000;
const MAX_LEDGER_EVENTS = 500;
const DURABLE_TEXT_CHECKPOINT_MS = 250;
const DURABLE_TEXT_CHECKPOINT_CHARS = 2_048;
const ACCOUNT_PRIVATE_SENSITIVITY = "account-private";
const ACCOUNT_PRIVATE_REDACTION = "[account-private output redacted]";
const DURABLE_OWNER_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const memoryStates = new Map();
const memoryEvents = new Map();
const durableChains = new Map();
const heartbeatTimers = new Map();
const durableTextBatches = new Map();
const priorityWrites = new Set();

function distributedLedger() {
  return (
    ["cloud", "distributed", "micro-modules"].includes(
      String(process.env.ATHENA_RUNTIME_TOPOLOGY || "")
        .trim()
        .toLowerCase()
    ) && process.env.ATHENA_DATABASE_PROVIDER === "postgresql"
  );
}

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
  if (distributedLedger()) return;
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

function readSessionState(uuid, fallback = null) {
  if (distributedLedger()) return memoryStates.get(String(uuid)) || fallback;
  return readJson(statePath(uuid), fallback);
}

function writeSessionState(uuid, data) {
  if (distributedLedger()) {
    memoryStates.set(String(uuid), data);
    return;
  }
  writeJson(statePath(uuid), data);
}

function readEvents(uuid) {
  if (distributedLedger()) return [...(memoryEvents.get(String(uuid)) || [])];
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
  const state = readSessionState(uuid, null);
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
  const current = readSessionState(uuid, {
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
  writeSessionState(uuid, next);
  return next;
}

function enqueueDurable(uuid, operation) {
  if (!distributedLedger()) return;
  const key = String(uuid);
  const previous = durableChains.get(key) || Promise.resolve();
  const next = previous
    .then(operation)
    .catch((error) =>
      console.warn("[agent-session] durable journal deferred", {
        invocationId: key,
        code: error?.code || error?.message || "agent_journal_failed",
      })
    )
    .finally(() => {
      if (durableChains.get(key) === next) durableChains.delete(key);
    });
  durableChains.set(key, next);
}

function persistDurableRecord(uuid, record, state) {
  const { DataAccessCenter } = require("../dataAccess");
  return DataAccessCenter.agentRun.append({
    invocationId: String(uuid),
    record,
    state,
    ownerId: DURABLE_OWNER_ID,
  });
}

function trackPriorityWrite(uuid, operation) {
  if (!distributedLedger()) return;
  const key = String(uuid);
  const write = Promise.resolve()
    .then(operation)
    .catch((error) =>
      console.warn("[agent-session] priority journal deferred", {
        invocationId: key,
        code: error?.code || error?.message || "agent_journal_failed",
      })
    )
    .finally(() => priorityWrites.delete(write));
  priorityWrites.add(write);
}

function durableText(record) {
  if (record?.eventType !== "textResponseChunk") return null;
  const content = record.payload?.content;
  if (!content || typeof content !== "object") return null;
  return String(content.content || content.textResponse || "");
}

function mergeDurableTextRecords(previous, next) {
  if (!previous) return next;
  const text = `${durableText(previous) || ""}${durableText(next) || ""}`;
  return {
    ...next,
    payload: {
      ...next.payload,
      seq: next.seq,
      content: {
        ...(previous.payload?.content || {}),
        ...(next.payload?.content || {}),
        seq: next.seq,
        content: text,
        textResponse: text,
      },
    },
  };
}

function flushDurableTextBatch(uuid) {
  const key = String(uuid);
  const batch = durableTextBatches.get(key);
  if (!batch) return;
  if (batch.timer) clearTimeout(batch.timer);
  durableTextBatches.delete(key);
  enqueueDurable(key, () =>
    persistDurableRecord(key, batch.record, batch.state)
  );
}

function bufferDurableTextRecord(uuid, record, state) {
  const key = String(uuid);
  const current = durableTextBatches.get(key);
  const next = {
    record: mergeDurableTextRecords(current?.record, record),
    state,
    timer: current?.timer || null,
  };
  if (!next.timer) {
    next.timer = setTimeout(
      () => flushDurableTextBatch(key),
      DURABLE_TEXT_CHECKPOINT_MS
    );
    next.timer.unref?.();
  }
  durableTextBatches.set(key, next);
  if ((durableText(next.record) || "").length >= DURABLE_TEXT_CHECKPOINT_CHARS)
    flushDurableTextBatch(key);
}

function recordAgentSessionEvent(uuid, rawPayload = {}) {
  if (!uuid || !rawPayload || typeof rawPayload !== "object") return null;
  ensureSessionDir(uuid);
  const seq = nextSeq(uuid);
  const { payload, eventType } = normalizePayload(rawPayload);
  const currentState = readSessionState(uuid, null);
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
  if (distributedLedger()) {
    const events = memoryEvents.get(String(uuid)) || [];
    events.push(record);
    if (events.length > MAX_LEDGER_EVENTS)
      events.splice(0, events.length - MAX_LEDGER_EVENTS);
    memoryEvents.set(String(uuid), events);
  } else {
    fs.appendFileSync(eventsPath(uuid), `${JSON.stringify(record)}\n`, "utf8");
  }
  const nextState = updateStateFromEvent(uuid, record);
  if (distributedLedger()) {
    if (record.eventType === "textResponseChunk") {
      bufferDurableTextRecord(uuid, record, nextState);
    } else {
      flushDurableTextBatch(uuid);
      if (nextState.terminal) {
        stopAgentRunHeartbeat(uuid);
        trackPriorityWrite(uuid, () =>
          persistDurableRecord(uuid, record, nextState)
        );
      } else {
        enqueueDurable(uuid, () =>
          persistDurableRecord(uuid, record, nextState)
        );
      }
    }
  }

  if (!distributedLedger() && seq > MAX_LEDGER_EVENTS && seq % 100 === 0) {
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
  if (distributedLedger())
    return {
      scannedSessions: memoryStates.size,
      matchedSessions: 0,
      redactedEvents: 0,
      durable: true,
    };
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
    const state = readSessionState(uuid, null);
    if (state) {
      writeSessionState(uuid, {
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
  const current = readSessionState(uuid, {
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
  writeSessionState(uuid, next);
  if (distributedLedger()) {
    flushDurableTextBatch(uuid);
    const persist = async () => {
      const { DataAccessCenter } = require("../dataAccess");
      await DataAccessCenter.agentRun.updateState(
        String(uuid),
        next,
        DURABLE_OWNER_ID
      );
    };
    if (next.terminal) {
      stopAgentRunHeartbeat(uuid);
      trackPriorityWrite(uuid, persist);
    } else {
      enqueueDurable(uuid, persist);
    }
  }
  return next;
}

function getAgentSessionState(uuid) {
  const state = readSessionState(uuid, null);
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

function seedAgentSessionState(uuid, state = {}) {
  if (!uuid || !state) return null;
  const current = readSessionState(uuid, {});
  const next = {
    ...current,
    ...state,
    uuid: String(uuid),
    latestSeq: Math.max(
      Number(current.latestSeq || 0),
      Number(state.latestSeq || state.latestSequence || 0)
    ),
  };
  writeSessionState(uuid, next);
  return next;
}

async function loadDurableAgentSession(uuid, afterSeq = 0) {
  if (!distributedLedger())
    return {
      state: getAgentSessionState(uuid),
      events: readAgentSessionEvents(uuid, afterSeq),
      durable: false,
    };
  const { DataAccessCenter } = require("../dataAccess");
  const [run, events] = await Promise.all([
    DataAccessCenter.agentRun.state(String(uuid)),
    DataAccessCenter.agentRun.eventsAfter(String(uuid), afterSeq),
  ]);
  if (!run)
    return {
      state: getAgentSessionState(uuid),
      events: readAgentSessionEvents(uuid, afterSeq),
      durable: true,
    };
  const localState = getAgentSessionState(uuid);
  const state = seedAgentSessionState(uuid, {
    status: run.status,
    latestSeq: Math.max(
      Number(run.latestSequence || 0),
      Number(localState.latestSeq || 0)
    ),
    terminal: ["completed", "failed", "stopped", "closed"].includes(run.status),
    retryable: !["completed", "failed", "stopped", "closed"].includes(
      run.status
    ),
    finalChatId: run.finalChatId || null,
    finalPublicChatId: run.finalPublicChatId || null,
    clientTurnId: run.clientTurnId || null,
    errorCode: run.errorCode || null,
  });
  const merged = new Map();
  for (const event of [...events, ...readAgentSessionEvents(uuid, afterSeq)])
    merged.set(Number(event.seq), event);
  return {
    state,
    events: [...merged.values()].sort(
      (left, right) => Number(left.seq) - Number(right.seq)
    ),
    durable: true,
  };
}

async function ensureDurableAgentSession(uuid) {
  if (!distributedLedger()) return null;
  const { DataAccessCenter } = require("../dataAccess");
  const ownership = await DataAccessCenter.agentRun.claim({
    invocationId: String(uuid),
    ownerId: DURABLE_OWNER_ID,
  });
  const run = ownership?.run || null;
  if (run)
    seedAgentSessionState(uuid, {
      status: run.status,
      latestSeq: run.latestSequence,
      terminal: ["completed", "failed", "stopped", "closed"].includes(
        run.status
      ),
      retryable: !["completed", "failed", "stopped", "closed"].includes(
        run.status
      ),
      finalChatId: run.finalChatId,
      finalPublicChatId: run.finalPublicChatId,
      clientTurnId: run.clientTurnId,
      errorCode: run.errorCode,
    });
  return {
    run,
    claimed: Boolean(ownership?.claimed),
  };
}

function startAgentRunHeartbeat(uuid) {
  if (!distributedLedger() || heartbeatTimers.has(String(uuid))) return;
  const key = String(uuid);
  const tick = () =>
    enqueueDurable(key, async () => {
      const { DataAccessCenter } = require("../dataAccess");
      await DataAccessCenter.agentRun.renewLease(key, DURABLE_OWNER_ID);
    });
  const timer = setInterval(tick, 10_000);
  timer.unref?.();
  heartbeatTimers.set(key, timer);
  tick();
}

function stopAgentRunHeartbeat(uuid) {
  const key = String(uuid);
  const timer = heartbeatTimers.get(key);
  if (timer) clearInterval(timer);
  heartbeatTimers.delete(key);
}

async function drainAgentSessionJournal() {
  for (const timer of heartbeatTimers.values()) clearInterval(timer);
  heartbeatTimers.clear();
  for (const uuid of [...durableTextBatches.keys()])
    flushDurableTextBatch(uuid);
  await Promise.allSettled([
    ...durableChains.values(),
    ...priorityWrites.values(),
  ]);
  return {
    pendingWrites: durableChains.size + priorityWrites.size,
    activeHeartbeats: heartbeatTimers.size,
  };
}

module.exports = {
  drainAgentSessionJournal,
  ensureDurableAgentSession,
  getAgentSessionState,
  loadDurableAgentSession,
  markAgentSessionState,
  readAgentSessionEvents,
  recordAgentSessionEvent,
  sanitizeAccountPrivateSessionLedgers,
  seedAgentSessionState,
  startAgentRunHeartbeat,
  stopAgentRunHeartbeat,
  _internals: {
    durableText,
    mergeDurableTextRecords,
  },
};
