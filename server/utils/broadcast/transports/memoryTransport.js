const MemoryBroadcastTransport = {
  adapterName: "memory",
  multiInstance: false,
  durableReplay: false,

  async start() {
    return this.health();
  },

  async publish() {
    return { accepted: true, localOnly: true };
  },

  async drain() {
    return true;
  },

  health() {
    return {
      ready: true,
      adapter: this.adapterName,
      multiInstance: false,
      durableReplay: false,
      lag: 0,
    };
  },
};

module.exports = { MemoryBroadcastTransport };
