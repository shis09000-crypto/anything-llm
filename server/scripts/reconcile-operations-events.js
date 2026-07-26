#!/usr/bin/env node

const { JSONCodec } = require("nats");
const {
  ClickHouseEventStore,
} = require("../utils/operations/clickHouseEventStore");
const {
  OperationsJetStreamTransport,
} = require("../utils/operations/jetStreamTransport");
const { validateRegistered } = require("../utils/operations/schemaRegistry");

const codec = JSONCodec();
const READ_CONCURRENCY = 25;

function batches(events, { maxMessages, maxBytes }) {
  const result = [];
  let batch = [];
  let bytes = 0;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    if (
      batch.length &&
      (batch.length >= maxMessages || bytes + eventBytes > maxBytes)
    ) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += eventBytes;
  }
  if (batch.length) result.push(batch);
  return result;
}

async function retainedEvents(transport) {
  await transport.connect();
  const manager = await transport.connection.jetstreamManager();
  const stream = await manager.streams.info(transport.config.stream);
  const firstSeq = Number(stream.state?.first_seq || 0);
  const lastSeq = Number(stream.state?.last_seq || 0);
  const events = new Map();
  const invalid = [];
  for (let start = firstSeq; start <= lastSeq; start += READ_CONCURRENCY) {
    const sequences = Array.from(
      { length: Math.min(READ_CONCURRENCY, lastSeq - start + 1) },
      (_unused, index) => start + index
    );
    const stored = await Promise.all(
      sequences.map((seq) =>
        manager.streams
          .getMessage(transport.config.stream, { seq })
          .catch(() => null)
      )
    );
    for (const message of stored) {
      if (!message) continue;
      try {
        const event = codec.decode(message.data);
        const validation = validateRegistered(event);
        if (!validation.valid) {
          invalid.push({ sequence: message.seq, reason: "schema_invalid" });
          continue;
        }
        events.set(event.eventId, event);
      } catch {
        invalid.push({ sequence: message.seq, reason: "json_invalid" });
      }
    }
  }
  return { events, firstSeq, invalid, lastSeq };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const transport = new OperationsJetStreamTransport(process.env);
  const store = new ClickHouseEventStore(process.env);
  try {
    const retained = await retainedEvents(transport);
    await store.ensureSchema();
    const persistedBefore = await store.eventIds();
    const missing = [...retained.events.values()].filter(
      (event) => !persistedBefore.has(event.eventId)
    );
    const report = {
      mode: apply ? "apply" : "dry-run",
      stream: transport.config.stream,
      streamFirstSeq: retained.firstSeq,
      streamLastSeq: retained.lastSeq,
      retainedEvents: retained.events.size,
      persistedEventsBefore: persistedBefore.size,
      missingEventIdsBefore: missing.map((event) => event.eventId),
      invalidMessages: retained.invalid,
    };
    if (apply) {
      for (const batch of batches(missing, transport.config.batch))
        await store.insertBatch(batch);
    }
    const persistedAfter = apply ? await store.eventIds() : persistedBefore;
    report.missingEventIds = [...retained.events.keys()].filter(
      (eventId) => !persistedAfter.has(eventId)
    );
    report.success = report.missingEventIds.length === 0;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (apply && !report.success) process.exitCode = 2;
  } finally {
    await transport.drain();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      success: false,
      error: error?.code || error?.message || String(error),
    })}\n`
  );
  process.exitCode = 1;
});
