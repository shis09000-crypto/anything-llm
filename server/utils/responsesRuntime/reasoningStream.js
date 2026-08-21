const { redactLogText } = require("../security/redaction");

const DEFAULT_FLUSH_DELAY_MS = 240;
const DEFAULT_SEGMENT_CHARS = 500;
const DEFAULT_TURN_CHARS = 20_000;
const REDACTED = "[redacted]";

function reasoningDeltaFromEvent(event = {}) {
  const type = String(event?.type || "");
  if (
    [
      "response.reasoning_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning.delta",
    ].includes(type)
  ) {
    return String(event.delta || "");
  }
  if (typeof event.reasoning_content === "string")
    return event.reasoning_content;
  if (typeof event?.delta?.reasoning_content === "string")
    return event.delta.reasoning_content;
  if (typeof event?.data?.reasoning_content === "string")
    return event.data.reasoning_content;
  if (typeof event?.choices?.[0]?.delta?.reasoning_content === "string")
    return event.choices[0].delta.reasoning_content;
  return "";
}

function completedReasoningFromEvent(event = {}) {
  if (event?.type !== "response.output_item.done") return "";
  const item = event.item;
  if (!item || item.type !== "reasoning") return "";
  const parts = [...(item.summary || []), ...(item.content || [])];
  return parts
    .filter((part) =>
      ["summary_text", "reasoning_text", "text"].includes(part?.type)
    )
    .map((part) => part.text || "")
    .join("");
}

function isReasoningProviderEvent(event = {}) {
  return (
    Boolean(reasoningDeltaFromEvent(event)) ||
    event?.item?.type === "reasoning" ||
    String(event?.type || "").startsWith("response.reasoning")
  );
}

function sanitizeReasoningText(value = "") {
  let text = redactLogText(String(value || ""));
  text = text
    .replace(
      /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
      (_, prefix) => `${prefix}${REDACTED}`
    )
    .replace(
      /\b(api[-_ ]?key|token|secret|password|authorization|cookie|private[-_ ]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (_, key) => `${key}=${REDACTED}`
    )
    .replace(
      /<(system|developer|tool|function)[^>]*>[\s\S]*?<\/\1>/gi,
      `[internal-context ${REDACTED}]`
    )
    .replace(
      /<(system|developer|tool|function)[^>]*>[\s\S]*$/gi,
      `[internal-context ${REDACTED}]`
    )
    .replace(
      /```(?:json|javascript|typescript|yaml|yml)?\s*\{[\s\S]{0,4000}?(?:authorization|api[-_]?key|token|secret|password)[\s\S]{0,4000}?\}\s*```/gi,
      `[internal-payload ${REDACTED}]`
    )
    .split("\u0000")
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return text;
}

function lastReadableBoundary(text = "") {
  const matches = Array.from(
    text.matchAll(/[。！？!?；;：:\n](?=\s|$|[^\s])/g)
  );
  return matches.length ? matches.at(-1).index + 1 : -1;
}

function hasIncompleteSensitiveContext(text = "") {
  const value = String(text || "");
  if (
    /\b(api[-_ ]?key|token|secret|password|authorization|cookie|private[-_ ]?key)\b\s*[:=]\s*["']?[^\s,;}]{0,3}$/i.test(
      value
    ) ||
    /\bBearer\s+[^\s]{0,3}$/i.test(value)
  )
    return true;
  const open = value.match(/<(system|developer|tool|function)[^>]*>/gi)?.at(-1);
  if (!open) return false;
  const tag = open.match(/^<([a-z]+)/i)?.[1];
  return tag
    ? !new RegExp(`<\\/${tag}>`, "i").test(value.slice(value.lastIndexOf(open)))
    : false;
}

class ReasoningStreamProjector {
  constructor({
    emit,
    flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
    maxSegmentChars = DEFAULT_SEGMENT_CHARS,
    maxTurnChars = DEFAULT_TURN_CHARS,
  } = {}) {
    this.emit = typeof emit === "function" ? emit : () => {};
    this.flushDelayMs = flushDelayMs;
    this.maxSegmentChars = maxSegmentChars;
    this.maxTurnChars = maxTurnChars;
    this.pendingRaw = "";
    this.rawChunks = [];
    this.emittedChars = 0;
    this.sequence = 0;
    this.started = false;
    this.done = false;
    this.truncated = false;
    this.lastSegment = "";
    this.timer = null;
  }

  get hasContent() {
    return this.started || this.pendingRaw.length > 0;
  }

  rawText() {
    return this.rawChunks.join("");
  }

  push(delta = "") {
    if (this.done) return;
    const raw = String(delta || "");
    if (!raw) return;
    this.rawChunks.push(raw);
    this.pendingRaw += raw;
    this.flushReadableSegments();
    this.scheduleFlush();
  }

  flushReadableSegments() {
    while (this.pendingRaw.length > 0) {
      const boundary = lastReadableBoundary(this.pendingRaw);
      if (boundary > 0) {
        this.flushChars(Math.min(boundary, this.maxSegmentChars));
        continue;
      }
      if (this.pendingRaw.length >= this.maxSegmentChars) {
        this.flushChars(this.maxSegmentChars);
        continue;
      }
      break;
    }
  }

  scheduleFlush() {
    if (!this.pendingRaw || this.timer || this.done) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushPending();
    }, this.flushDelayMs);
    this.timer.unref?.();
  }

  clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  flushChars(count) {
    const raw = this.pendingRaw.slice(0, count);
    this.pendingRaw = this.pendingRaw.slice(count);
    this.emitSafeSegment(raw);
  }

  flushPending({ force = false } = {}) {
    this.clearTimer();
    if (!this.pendingRaw) return;
    if (!force && hasIncompleteSensitiveContext(this.pendingRaw)) {
      this.scheduleFlush();
      return;
    }
    const raw = this.pendingRaw;
    this.pendingRaw = "";
    this.emitSafeSegment(raw);
  }

  emitSafeSegment(raw = "") {
    if (this.truncated) return;
    let content = sanitizeReasoningText(raw).trim();
    if (!content || content === this.lastSegment) return;
    const remaining = this.maxTurnChars - this.emittedChars;
    if (remaining <= 0) return this.emitTruncated();
    if (content.length > remaining) {
      content = content.slice(0, remaining).trimEnd();
      this.truncated = true;
    }
    if (!content) return;
    if (!this.started) {
      this.started = true;
      this.emit({ type: "reasoningContentStart" });
    }
    this.sequence += 1;
    this.emittedChars += content.length;
    this.lastSegment = content;
    this.emit({
      type: "reasoningContentChunk",
      sequence: this.sequence,
      content,
      truncated: this.truncated,
    });
    if (this.truncated) this.emitTruncated(false);
  }

  emitTruncated(mark = true) {
    if (mark) this.truncated = true;
    if (!this.started) return;
    if (this.lastSegment === "[思考内容已截断]") return;
    this.sequence += 1;
    this.lastSegment = "[思考内容已截断]";
    this.emit({
      type: "reasoningContentChunk",
      sequence: this.sequence,
      content: this.lastSegment,
      truncated: true,
    });
  }

  finish(status = "completed") {
    if (this.done) return;
    this.flushPending({ force: true });
    this.done = true;
    if (!this.started) return;
    this.emit({
      type: "reasoningContentDone",
      sequence: this.sequence + 1,
      status,
      truncated: this.truncated,
    });
  }
}

module.exports = {
  ReasoningStreamProjector,
  completedReasoningFromEvent,
  hasIncompleteSensitiveContext,
  isReasoningProviderEvent,
  reasoningDeltaFromEvent,
  sanitizeReasoningText,
};
