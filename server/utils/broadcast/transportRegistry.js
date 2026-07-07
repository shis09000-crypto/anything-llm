const SUPPORTED_TRANSPORTS = Object.freeze({
  memory: {
    adapter: "memory",
    status: "active",
    multiInstance: false,
    durableReplay: false,
    description:
      "In-process broadcast fanout, ack, coalescing, and replay ring buffer.",
  },
});

const RESERVED_TRANSPORTS = Object.freeze({
  redis: {
    adapter: "redis",
    status: "reserved",
    multiInstance: true,
    durableReplay: false,
    description:
      "Reserved for cross-instance fanout and replay via Redis streams/pubsub.",
  },
  nats: {
    adapter: "nats",
    status: "reserved",
    multiInstance: true,
    durableReplay: true,
    description:
      "Reserved for durable realtime event routing via NATS JetStream.",
  },
});

function selectedBroadcastTransport(env = process.env) {
  return String(env.ATHENA_BROADCAST_TRANSPORT || "memory")
    .trim()
    .toLowerCase();
}

function broadcastTransportSummary(env = process.env) {
  const selected = selectedBroadcastTransport(env);
  const active =
    SUPPORTED_TRANSPORTS[selected] || RESERVED_TRANSPORTS[selected] || null;
  return {
    selected,
    supported: Object.keys(SUPPORTED_TRANSPORTS),
    reserved: Object.keys(RESERVED_TRANSPORTS),
    active: active
      ? { ...active }
      : {
          adapter: selected,
          status: "unknown",
          multiInstance: false,
          durableReplay: false,
          description: "Unknown broadcast transport.",
        },
    ready: Boolean(SUPPORTED_TRANSPORTS[selected]),
    gatewaySafe: selected === "memory",
    warning:
      selected === "memory"
        ? null
        : `Broadcast transport '${selected}' is not implemented in V1; use memory or keep realtime gateway disabled.`,
  };
}

function ensureBroadcastTransportSupported(env = process.env) {
  const summary = broadcastTransportSummary(env);
  if (summary.ready) return { ok: true, ...summary };
  return {
    ok: false,
    code: "BROADCAST_TRANSPORT_NOT_IMPLEMENTED",
    ...summary,
  };
}

module.exports = {
  RESERVED_TRANSPORTS,
  SUPPORTED_TRANSPORTS,
  broadcastTransportSummary,
  ensureBroadcastTransportSupported,
  selectedBroadcastTransport,
};
