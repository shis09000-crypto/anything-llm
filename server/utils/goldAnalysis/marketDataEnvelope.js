const crypto = require("node:crypto");

function marketDataEnvelope({
  source,
  market,
  eventType,
  observedAtMs,
  receivedAtMs = Date.now(),
  availableAtMs = receivedAtMs,
  availabilityQuality = "received",
  revisionStatus = "unknown",
  backfilled = false,
  formingCandleExcluded = true,
  providerVersion = null,
  citationUrl = null,
}) {
  const observed = Number(observedAtMs);
  const received = Number(receivedAtMs);
  const available = Number(availableAtMs);
  if (
    !source ||
    !market ||
    !eventType ||
    !Number.isFinite(observed) ||
    !Number.isFinite(received) ||
    !Number.isFinite(available)
  )
    throw new Error("gold_market_data_envelope_invalid");
  if (available > received && availabilityQuality === "received")
    throw new Error("gold_market_data_received_before_available");
  const envelope = {
    schema: "athena.gold.market-data-envelope",
    schemaVersion: "1.0",
    source,
    market,
    eventType,
    observedAtMs: observed,
    receivedAtMs: received,
    availableAtMs: available,
    availabilityQuality,
    availabilityEstimated: availabilityQuality !== "exact",
    revisionStatus,
    backfilled: Boolean(backfilled),
    formingCandleExcluded: Boolean(formingCandleExcluded),
    providerVersion: providerVersion || null,
    citationUrl: citationUrl || null,
  };
  return {
    ...envelope,
    eventId: crypto
      .createHash("sha256")
      .update(`${source}|${market}|${eventType}|${observed}|${available}`)
      .digest("hex"),
  };
}

function envelopeForBar(bar, receivedAtMs = Date.now()) {
  const symbol = String(bar.symbol || "XAU/USD").toUpperCase();
  return marketDataEnvelope({
    source: bar.source,
    market:
      symbol === "XAG/USD"
        ? "xag_usd_spot"
        : symbol === "XAU/USD"
          ? "xau_usd_spot"
          : symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    eventType: `${bar.interval}_candle`,
    observedAtMs: bar.closeTimeMs,
    receivedAtMs,
    availableAtMs: bar.closeTimeMs,
    availabilityQuality: bar.backfilled ? "estimated" : "received",
    revisionStatus: "not_revisable",
    backfilled: Boolean(bar.backfilled),
    formingCandleExcluded: true,
    providerVersion: bar.providerVersion || "twelve-data-v1",
    citationUrl: "https://twelvedata.com/docs",
  });
}

module.exports = { envelopeForBar, marketDataEnvelope };
