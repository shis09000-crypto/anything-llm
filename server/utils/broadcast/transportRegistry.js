const SUPPORTED_TRANSPORTS = Object.freeze({
  memory: {
    adapter: "memory",
    status: "active",
    multiInstance: false,
    durableReplay: false,
    description:
      "In-process broadcast fanout, ack, coalescing, and replay ring buffer.",
  },
  nats: {
    adapter: "nats",
    status: "active",
    multiInstance: true,
    durableReplay: true,
    description:
      "NATS JetStream fanout with durable consumers and Outbox event-id deduplication.",
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
});

function natsConfigured(env = process.env) {
  return Boolean(String(env.ATHENA_NATS_SERVERS || env.NATS_URL || "").trim());
}

function selectedBroadcastTransport(env = process.env) {
  return String(env.ATHENA_BROADCAST_TRANSPORT || "memory")
    .trim()
    .toLowerCase();
}

function broadcastTransportSummary(env = process.env) {
  const selected = selectedBroadcastTransport(env);
  const active =
    SUPPORTED_TRANSPORTS[selected] || RESERVED_TRANSPORTS[selected] || null;
  const configured = selected !== "nats" || natsConfigured(env);
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
    configured,
    ready: Boolean(SUPPORTED_TRANSPORTS[selected]) && configured,
    gatewaySafe: Boolean(
      SUPPORTED_TRANSPORTS[selected]?.multiInstance &&
        SUPPORTED_TRANSPORTS[selected]?.durableReplay &&
        configured
    ),
    warning:
      selected === "memory"
        ? "Memory transport is process-local; keep realtime routes in the API process."
        : selected === "nats" && !configured
          ? "NATS transport is selected but ATHENA_NATS_SERVERS is missing."
          : active?.status === "active"
            ? null
            : `Broadcast transport '${selected}' is not implemented; keep realtime gateway disabled.`,
  };
}

function ensureBroadcastTransportSupported(env = process.env) {
  const summary = broadcastTransportSummary(env);
  if (summary.ready) return { ok: true, ...summary };
  return {
    ok: false,
    code:
      summary.active?.status === "active"
        ? "BROADCAST_TRANSPORT_CONFIG_MISSING"
        : "BROADCAST_TRANSPORT_NOT_IMPLEMENTED",
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
