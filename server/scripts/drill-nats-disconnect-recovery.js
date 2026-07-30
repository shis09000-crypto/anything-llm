#!/usr/bin/env node
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  NatsJetStreamTransport,
} = require("../utils/broadcast/transports/natsJetStreamTransport");

const VERSION = "athena.preproduction-nats-replay-drill:v1";
const CONSUMER = "athena-preproduction-replay-drill";

function argument(name, fallback = null) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function statePath() {
  const value = argument("state");
  if (!value) throw new Error("replay_drill_state_file_required");
  return path.resolve(value);
}

function readState() {
  return JSON.parse(fs.readFileSync(statePath(), "utf8"));
}

function writeState(value) {
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function event(eventId, sequence) {
  return {
    eventId,
    namespace: "preproduction-drill",
    type: "replay.probe",
    visibility: "admin",
    scope: {},
    sequence,
    occurredAt: new Date().toISOString(),
    payloadHash: crypto
      .createHash("sha256")
      .update(`${eventId}:${sequence}`)
      .digest("hex"),
  };
}

function transport(consumer = CONSUMER) {
  return new NatsJetStreamTransport({
    ...process.env,
    ATHENA_NATS_CONSUMER_NAME: consumer,
  });
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function prepare() {
  const runId = crypto.randomUUID();
  const firstEventId = crypto.randomUUID();
  const received = [];
  const subscriber = transport();
  await subscriber.start(async (value) => {
    if (value.eventId === firstEventId) received.push(value);
  });
  await subscriber.publish(event(firstEventId, 1));
  if (!(await waitFor(() => received.length === 1)))
    throw new Error("replay_drill_prepare_delivery_timeout");
  await subscriber.drain();
  const state = {
    version: VERSION,
    environment: "preproduction",
    runId,
    consumer: CONSUMER,
    firstEventId,
    firstSequence: 1,
    firstDeliveryCount: received.length,
    preparedAt: new Date().toISOString(),
  };
  writeState(state);
  return { ...state, phase: "prepare", passed: true };
}

async function publishGap() {
  const state = readState();
  if (state.version !== VERSION) throw new Error("replay_drill_state_invalid");
  const secondEventId = crypto.randomUUID();
  const publisher = transport(`preproduction-replay-publisher-${process.pid}`);
  await publisher.publish(event(secondEventId, 2));
  await publisher.drain();
  const next = {
    ...state,
    secondEventId,
    secondSequence: 2,
    publishedWhileConsumerOffline: true,
    gapPublishedAt: new Date().toISOString(),
  };
  writeState(next);
  return { ...next, phase: "gap", passed: true };
}

async function verify() {
  const state = readState();
  if (!state.secondEventId || state.secondSequence !== 2)
    throw new Error("replay_drill_gap_not_published");
  const deliveries = [];
  const subscriber = transport();
  await subscriber.start(async (value) => {
    if (value.eventId === state.secondEventId) deliveries.push(value);
  });
  const delivered = await waitFor(() => deliveries.length >= 1);
  await subscriber.drain();
  if (!delivered) throw new Error("replay_drill_resume_delivery_timeout");
  if (deliveries.length !== 1)
    throw new Error("replay_drill_duplicate_delivery_detected");
  const sequences = [state.firstSequence, deliveries[0].sequence];
  if (sequences.join(",") !== "1,2")
    throw new Error("replay_drill_sequence_gap_detected");
  const result = {
    ...state,
    phase: "verify",
    passed: true,
    durableSequenceReplayVerified: true,
    duplicateEvents: 0,
    missingEvents: 0,
    observedSequences: sequences,
    verifiedAt: new Date().toISOString(),
  };
  writeState(result);
  return result;
}

async function main() {
  if (process.env.APP_ENV !== "preproduction")
    throw new Error("preproduction_environment_required");
  if (process.env.ATHENA_RUNTIME_TOPOLOGY !== "distributed")
    throw new Error("distributed_topology_required");
  const phase = argument("phase");
  let result;
  if (phase === "prepare") result = await prepare();
  else if (phase === "gap") result = await publishGap();
  else if (phase === "verify") result = await verify();
  else throw new Error("replay_drill_phase_invalid");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        version: VERSION,
        passed: false,
        error: error.code || error.message,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
