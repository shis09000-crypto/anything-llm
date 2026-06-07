const crypto = require("crypto");
const { sanitizePayload } = require("./sanitizer");

class CryptoEventBuffer {
  constructor(limit = 500) {
    this.limit = limit;
    this.events = [];
  }

  push(event) {
    const item = {
      id: event.id || crypto.randomUUID(),
      source: event.source,
      channel: event.channel,
      event: event.event,
      receivedAt: event.receivedAt || Date.now(),
      type: event.type || event.eventType || "connection",
      sanitizedPayload: sanitizePayload(
        event.sanitizedPayload || event.payload
      ),
    };
    this.events.push(item);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    return item;
  }

  recent(limit = this.limit) {
    return [...this.events].slice(-limit).reverse();
  }

  clear() {
    this.events = [];
  }
}

const cryptoGateEventBuffer = new CryptoEventBuffer(500);

module.exports = {
  CryptoEventBuffer,
  cryptoGateEventBuffer,
};
