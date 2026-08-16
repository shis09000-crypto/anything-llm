const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { storageRoot: environmentStorageRoot } = require("../environment");
const { safeAgentProgressDetails } = require("./agentProgress");

const MAX_MODEL_TOOL_RESULT_CHARS = 12_000;
const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 500;
const MAX_AGENT_EVENT_CHARS = 500;
const MAX_CLARIFYING_QUESTIONS = 3;
const MAX_CLARIFYING_QUESTION_CHARS = 150;
const MAX_CLARIFYING_CHOICE_OPTIONS = 3;
const TOOL_RUN_RETENTION_DAYS = 7;
const TOOL_RUN_MAX_COUNT = 1_000;
const TOOL_RUN_MAX_BYTES = 1024 * 1024 * 1024;

function storageRoot() {
  return environmentStorageRoot();
}

function toolRunsRoot() {
  return path.join(storageRoot(), "tool-runs");
}

function todayFolder() {
  return new Date().toISOString().slice(0, 10);
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  if (value === null) return "null";
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function truncate(value = "", maxChars = MAX_TOOL_OUTPUT_PREVIEW_CHARS) {
  const text = value === undefined || value === null ? "" : String(value);
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function truncateUnicode(value = "", maxChars = MAX_CLARIFYING_QUESTION_CHARS) {
  const chars = Array.from(String(value || ""));
  if (chars.length <= maxChars) return chars.join("");
  return chars.slice(0, maxChars).join("");
}

function sanitizeClarifyingQuestions(questions = []) {
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, MAX_CLARIFYING_QUESTIONS).map((question) => {
    const sanitized = {
      ...question,
      question: truncateUnicode(question?.question || ""),
    };
    if (sanitized.kind === "choice") {
      sanitized.options = Array.isArray(question.options)
        ? question.options.slice(0, MAX_CLARIFYING_CHOICE_OPTIONS)
        : [];
      sanitized.optionDescriptions = Array.isArray(question.optionDescriptions)
        ? question.optionDescriptions.slice(0, MAX_CLARIFYING_CHOICE_OPTIONS)
        : [];
      sanitized.multiSelect = false;
      sanitized.allowOther = true;
    }
    return sanitized;
  });
}

function resultSize(value) {
  return Buffer.byteLength(safeStringify(value), "utf8");
}

function outputFromResult(result) {
  const parsed = parseMaybeJson(result);
  if (parsed && typeof parsed === "object") {
    return (
      parsed.output ??
      parsed.stdout ??
      parsed.stderr ??
      parsed.error ??
      parsed.message ??
      parsed.summary ??
      ""
    );
  }
  return parsed;
}

function countFor(value, key) {
  return Array.isArray(value?.[key]) ? value[key].length : value?.[key];
}

function summarizeToolResult({ toolName, result }) {
  const parsed = parseMaybeJson(result);
  const output = outputFromResult(parsed);
  const preview = truncate(output, MAX_TOOL_OUTPUT_PREVIEW_CHARS);
  const size = resultSize(result);
  const summaryParts = [];

  if (parsed && typeof parsed === "object") {
    if (parsed.success === false) summaryParts.push("Tool returned an error.");
    else if (parsed.success === true) summaryParts.push("Tool completed.");

    if (parsed.reason) summaryParts.push(`Reason: ${parsed.reason}.`);
    if (parsed.error)
      summaryParts.push(`Error: ${String(parsed.error).slice(0, 160)}.`);
    const importedCount = countFor(parsed, "importedFiles");
    const scannedCount = countFor(parsed, "scannedFiles");
    const skippedCount = countFor(parsed, "skippedFiles");
    const fileCount = countFor(parsed, "files") ?? parsed.fileCount;
    const excludedCount = parsed.excludedCount;
    if (Number.isFinite(Number(importedCount)))
      summaryParts.push(`Imported ${importedCount} file(s).`);
    if (Number.isFinite(Number(scannedCount)))
      summaryParts.push(`Scanned ${scannedCount} file(s).`);
    if (Number.isFinite(Number(fileCount)))
      summaryParts.push(`Matched ${fileCount} file(s).`);
    if (Number.isFinite(Number(skippedCount)))
      summaryParts.push(`Skipped ${skippedCount} file(s).`);
    if (Number.isFinite(Number(excludedCount)))
      summaryParts.push(`Excluded ${excludedCount} file(s).`);
    if (parsed.exitCode !== undefined)
      summaryParts.push(`Exit code ${parsed.exitCode}.`);
    if (parsed.timedOut) summaryParts.push("Command timed out.");
  }

  const fallback = preview.text
    ? `${toolName || "Tool"} result: ${preview.text}`
    : `${toolName || "Tool"} returned a result.`;

  return {
    summary: summaryParts.join(" ") || truncate(fallback, 240).text,
    outputPreview: preview.text,
    resultSize: size,
    truncated: preview.truncated || size > MAX_MODEL_TOOL_RESULT_CHARS,
    exitCode: parsed?.exitCode,
    timedOut: parsed?.timedOut,
    root: parsed?.root || parsed?.rootPath,
    fileCount:
      parsed?.fileCount ??
      countFor(parsed, "files") ??
      countFor(parsed, "importedFiles"),
    excludedCount: parsed?.excludedCount ?? countFor(parsed, "skippedFiles"),
    totalSize: parsed?.totalSize ?? parsed?.estimatedBytes,
  };
}

function runDirectory(runId) {
  return path.join(toolRunsRoot(), todayFolder(), runId);
}

function collectRunDirs() {
  const root = toolRunsRoot();
  if (!fs.existsSync(root)) return [];
  const dirs = [];
  for (const day of fs.readdirSync(root)) {
    const dayPath = path.join(root, day);
    if (!fs.existsSync(dayPath) || !fs.lstatSync(dayPath).isDirectory())
      continue;
    for (const runId of fs.readdirSync(dayPath)) {
      const runPath = path.join(dayPath, runId);
      if (!fs.existsSync(runPath) || !fs.lstatSync(runPath).isDirectory())
        continue;
      const stats = fs.statSync(runPath);
      const resultPath = path.join(runPath, "result.json");
      const size = fs.existsSync(resultPath) ? fs.statSync(resultPath).size : 0;
      dirs.push({ path: runPath, mtimeMs: stats.mtimeMs, size });
    }
  }
  return dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function removeDirQuietly(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[tool-runs] Failed to remove ${dirPath}: ${error.message}`);
  }
}

function cleanupToolRuns() {
  try {
    const cutoff = Date.now() - TOOL_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let dirs = collectRunDirs();
    for (const dir of dirs) {
      if (dir.mtimeMs < cutoff) removeDirQuietly(dir.path);
    }

    dirs = collectRunDirs();
    let totalSize = dirs.reduce((sum, dir) => sum + dir.size, 0);
    while (dirs.length > TOOL_RUN_MAX_COUNT || totalSize > TOOL_RUN_MAX_BYTES) {
      const dir = dirs.shift();
      if (!dir) break;
      totalSize -= dir.size;
      removeDirQuietly(dir.path);
    }
  } catch (error) {
    console.warn(`[tool-runs] Cleanup failed: ${error.message}`);
  }
}

async function storeToolRun({
  toolName,
  arguments: args,
  result,
  resultPolicy = null,
}) {
  const runId = uuidv4();
  const privateSummaryOnly = resultPolicy === "account-private/summary-only";
  const summary = privateSummaryOnly
    ? {
        summary: "Private account read completed.",
        outputPreview: "",
        resultSize: resultSize(result),
        truncated: false,
      }
    : summarizeToolResult({ toolName, result });
  const resultSha256 = crypto
    .createHash("sha256")
    .update(safeStringify(result))
    .digest("hex");
  const record = {
    runId,
    toolName,
    ...(privateSummaryOnly
      ? {
          resultPolicy,
          argumentsSha256: crypto
            .createHash("sha256")
            .update(safeStringify(args))
            .digest("hex"),
          resultSha256,
          status:
            parseMaybeJson(result)?.success === false ? "failed" : "completed",
          resultSize: resultSize(result),
        }
      : {
          arguments: args,
          result,
          resultSha256,
        }),
    createdAt: new Date().toISOString(),
  };

  try {
    const dir = runDirectory(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "result.json"),
      safeStringify(record),
      "utf8"
    );
    cleanupToolRuns();
    return {
      ...summary,
      ...(privateSummaryOnly ? { resultPolicy } : {}),
      runId,
      resultSha256,
      stored: true,
      storageError: null,
    };
  } catch (error) {
    console.warn(`[tool-runs] Failed to store tool run: ${error.message}`);
    return {
      ...summary,
      runId,
      resultSha256,
      stored: false,
      storageError: "write_failed",
    };
  }
}

function prepareToolResultForModel(
  result,
  storedRun = null,
  maxChars = MAX_MODEL_TOOL_RESULT_CHARS
) {
  const effectiveMaxChars = Math.min(
    100_000,
    Math.max(
      MAX_MODEL_TOOL_RESULT_CHARS,
      Number.isFinite(Number(maxChars))
        ? Math.floor(Number(maxChars))
        : MAX_MODEL_TOOL_RESULT_CHARS
    )
  );
  const text = safeStringify(result);
  if (text.length <= effectiveMaxChars) return text;

  const privateSummaryOnly =
    storedRun?.resultPolicy === "account-private/summary-only";
  const suffix = privateSummaryOnly
    ? "\n\n[Private tool result truncated in memory; the omitted private content was not persisted.]"
    : storedRun?.stored
      ? `\n\n[Tool result truncated: full result stored as runId=${storedRun.runId}]`
      : "\n\n[Tool result truncated: full result omitted because local tool-run storage failed]";
  return `${text.slice(0, effectiveMaxChars)}${suffix}`;
}

function sanitizeAgentEvent(event = {}) {
  if (!event || typeof event !== "object") return event;
  const sanitized = {
    id: event.id,
    uuid: event.uuid,
    createdAt: event.createdAt,
    type: event.type,
    phase: event.phase,
    sequence: event.sequence,
    details:
      event.type === "agent_progress" && event.details
        ? safeAgentProgressDetails(event.details)
        : undefined,
    toolName: event.toolName,
    skillName: event.skillName,
    requestId: event.requestId,
    approved: event.approved,
    reason: event.reason,
    status: event.status,
    runId: event.runId,
    stored: event.stored,
    storageError: event.storageError,
    resultSize: event.resultSize,
    truncated: event.truncated,
    exitCode: event.exitCode,
    timedOut: event.timedOut,
    root: truncate(event.root || "", 500).text || undefined,
    fileCount: event.fileCount,
    excludedCount: event.excludedCount,
    totalSize: event.totalSize,
    mode: event.mode,
    supplementKind: event.supplementKind,
    supplementId: event.supplementId,
    documentTitle: truncate(event.documentTitle || "", 500).text || undefined,
    query: truncate(event.query || "", 500).text || undefined,
    returnedCount: event.returnedCount,
    truncatedCount: event.truncatedCount,
    allowSkip: event.allowSkip,
    timeoutMs: event.timeoutMs,
    requestedAt: event.requestedAt,
    skipped: event.skipped,
  };

  const content = truncate(
    event.summary || event.content || event.outputPreview || "",
    MAX_AGENT_EVENT_CHARS
  ).text;
  if (content && event.type !== "agent_progress") sanitized.content = content;

  if (event.payload && event.type === "approval_request") {
    sanitized.payload = sanitizePayload(event.payload);
  }
  if (event.questions && event.type === "clarification_request") {
    sanitized.questions = sanitizeClarifyingQuestions(event.questions);
  }

  return Object.fromEntries(
    Object.entries(sanitized).filter(([, value]) => value !== undefined)
  );
}

function compactAgentEventKey(event = {}) {
  if (event.type === "agent_progress" && event.phase && event.sequence)
    return `agent-progress:${event.phase}:${event.sequence}`;
  if (!event.uuid) return null;
  if (["assistant_delta", "final_message"].includes(event.type))
    return `assistant:${event.uuid}`;
  if (event.type === "tool_call") return `tool-call:${event.uuid}`;
  if (event.type === "tool_result") return `tool-result:${event.uuid}`;
  return null;
}

function compactAgentEvents(events = []) {
  if (!Array.isArray(events)) return [];
  const compacted = [];
  const indexByKey = new Map();
  for (const rawEvent of events) {
    const event = sanitizeAgentEvent(rawEvent);
    const key = compactAgentEventKey(event);
    if (!key || !indexByKey.has(key)) {
      if (key) indexByKey.set(key, compacted.length);
      compacted.push(event);
      continue;
    }
    const index = indexByKey.get(key);
    const previous = compacted[index];
    compacted[index] = {
      ...event,
      id: previous.id || event.id,
      createdAt: previous.createdAt || event.createdAt,
    };
  }
  return compacted;
}

function sanitizePayload(payload = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const allowedKeys = [
    "command",
    "cwd",
    "mode",
    "risk",
    "root",
    "estimatedFiles",
    "scannedFiles",
    "excludedCount",
    "estimatedBytes",
    "fileTypes",
    "glob",
    "excludedByReason",
    "approvalClass",
    "scope",
    "exchange",
    "environment",
    "symbol",
    "days",
    "limit",
  ];
  const next = {};
  for (const key of allowedKeys) {
    if (payload[key] === undefined) continue;
    next[key] =
      typeof payload[key] === "string"
        ? truncate(payload[key], MAX_AGENT_EVENT_CHARS).text
        : payload[key];
  }
  return next;
}

module.exports = {
  compactAgentEventKey,
  compactAgentEvents,
  MAX_MODEL_TOOL_RESULT_CHARS,
  MAX_TOOL_OUTPUT_PREVIEW_CHARS,
  storeToolRun,
  prepareToolResultForModel,
  sanitizeAgentEvent,
  summarizeToolResult,
};
