const { selectedBroadcastTransport } = require("./transportRegistry");
const { MemoryBroadcastTransport } = require("./transports/memoryTransport");
const {
  NatsJetStreamTransport,
} = require("./transports/natsJetStreamTransport");

let active = null;
let activeName = null;

function adapter(env = process.env) {
  const selected = selectedBroadcastTransport(env);
  if (active && activeName === selected) return active;
  activeName = selected;
  active =
    selected === "nats"
      ? new NatsJetStreamTransport(env)
      : MemoryBroadcastTransport;
  return active;
}

const BroadcastTransport = {
  adapter,

  async start(handler, env = process.env) {
    return adapter(env).start(handler);
  },

  async publish(event, env = process.env) {
    return adapter(env).publish(event);
  },

  async drain(env = process.env) {
    return adapter(env).drain();
  },

  health(env = process.env) {
    return adapter(env).health();
  },

  resetForTests() {
    active = null;
    activeName = null;
  },
};

module.exports = { BroadcastTransport };
