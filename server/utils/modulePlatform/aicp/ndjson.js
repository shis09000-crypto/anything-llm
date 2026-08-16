const crypto = require("crypto");
const {
  AicpStreamSequence,
  STREAM_FRAME_SCHEMA,
  createStreamFrame,
} = require("./streamFrames");
const { metrics } = require("../../observability/metrics");

function streamProtocolEnabled(aicp = null) {
  return aicp?.context?.schemaVersion === "1.1";
}

class AicpNdjsonWriter {
  constructor(response, { aicp = null, streamId = crypto.randomUUID() } = {}) {
    this.response = response;
    this.enabled = streamProtocolEnabled(aicp);
    this.streamId = String(streamId);
    this.sequence = 0;
    this.opened = false;
    this.terminated = false;
  }

  write(value) {
    if (this.response.destroyed || this.response.writableEnded) return false;
    return this.response.write(`${JSON.stringify(value)}\n`);
  }

  open(payload = null) {
    if (this.opened) return;
    this.opened = true;
    if (this.enabled)
      this.write(
        createStreamFrame({
          streamId: this.streamId,
          sequence: this.sequence++,
          type: "open",
          payload,
        })
      );
    if (this.enabled)
      metrics.aicpStreamEvents.inc({ event: "open", outcome: "emitted" });
  }

  data(payload, { cursor = null } = {}) {
    this.open();
    if (this.terminated) return false;
    const written = this.enabled
      ? this.write(
          createStreamFrame({
            streamId: this.streamId,
            sequence: this.sequence++,
            type: "data",
            cursor,
            payload,
          })
        )
      : this.write(payload);
    if (this.enabled)
      metrics.aicpStreamEvents.inc({ event: "data", outcome: "emitted" });
    return written;
  }

  checkpoint(payload, cursor) {
    this.open();
    if (!this.enabled || this.terminated) return false;
    return this.write(
      createStreamFrame({
        streamId: this.streamId,
        sequence: this.sequence++,
        type: "checkpoint",
        cursor,
        payload,
      })
    );
  }

  heartbeat(payload = null) {
    this.open();
    if (!this.enabled || this.terminated) return false;
    return this.write(
      createStreamFrame({
        streamId: this.streamId,
        sequence: this.sequence++,
        type: "heartbeat",
        payload,
      })
    );
  }

  terminal(status = "completed", payload = null, legacyValue = { end: true }) {
    this.open();
    if (this.terminated) return false;
    this.terminated = true;
    const written = this.enabled
      ? this.write(
          createStreamFrame({
            streamId: this.streamId,
            sequence: this.sequence++,
            type: "terminal",
            terminalStatus: status,
            payload,
          })
        )
      : this.write(legacyValue);
    if (this.enabled)
      metrics.aicpStreamEvents.inc({
        event: "terminal",
        outcome: String(status),
      });
    return written;
  }

  end(status = "completed", payload = null, legacyValue = { end: true }) {
    this.terminal(status, payload, legacyValue);
    if (!this.response.destroyed && !this.response.writableEnded)
      this.response.end();
  }
}

async function* readAicpNdjson(response) {
  let buffered = "";
  let sequence = null;
  const process = (line) => {
    if (!line) return null;
    const parsed = JSON.parse(line);
    if (parsed?.schema !== STREAM_FRAME_SCHEMA)
      return { payload: parsed, frame: null, terminal: false, legacy: true };
    sequence ||= new AicpStreamSequence(parsed.streamId);
    const validation = sequence.accept(parsed);
    if (!validation.valid) {
      metrics.aicpStreamEvents.inc({
        event: "sequence",
        outcome: "rejected",
      });
      const error = new Error("aicp_stream_sequence_invalid");
      error.code = "AICP_STREAM_SEQUENCE_INVALID";
      error.findings = validation.findings;
      throw error;
    }
    if (parsed.type === "terminal" && parsed.terminalStatus !== "completed") {
      metrics.aicpStreamEvents.inc({
        event: "terminal",
        outcome: parsed.terminalStatus,
      });
      const error = new Error(
        parsed.payload?.error || `aicp_stream_${parsed.terminalStatus}`
      );
      error.code = String(
        parsed.payload?.error || `AICP_STREAM_${parsed.terminalStatus}`
      ).toUpperCase();
      error.terminalStatus = parsed.terminalStatus;
      throw error;
    }
    return {
      payload: parsed.payload,
      frame: parsed,
      terminal: parsed.type === "terminal",
      legacy: false,
    };
  };
  for await (const raw of response) {
    buffered += raw.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const value = process(buffered.slice(0, newline).trim());
      buffered = buffered.slice(newline + 1);
      if (value) yield value;
      newline = buffered.indexOf("\n");
    }
  }
  const tail = process(buffered.trim());
  if (tail) yield tail;
  if (sequence && !sequence.complete()) {
    metrics.aicpStreamEvents.inc({
      event: "terminal",
      outcome: "missing",
    });
    const error = new Error("aicp_stream_terminal_missing");
    error.code = "AICP_STREAM_TERMINAL_MISSING";
    throw error;
  }
}

module.exports = {
  AicpNdjsonWriter,
  readAicpNdjson,
  streamProtocolEnabled,
};
