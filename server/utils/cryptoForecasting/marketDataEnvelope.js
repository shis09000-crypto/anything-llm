const crypto = require("node:crypto");
const { QUOTE } = require("./constants");

function marketDataEnvelope({
  source,
  symbol,
  market = "spot",
  eventType = "kline",
  exchangeTimeMs,
  receivedAtMs,
  availableAtMs,
  backfilled = false,
  availabilityEstimated = backfilled,
  deduplicated = false,
  gapDetected = false,
  formingCandleExcluded = true,
  availabilityQuality = availabilityEstimated ? "estimated" : "exact",
  revisionStatus = "not_revisable",
  providerVersion = null,
  licenseId = null,
  citationUrl = null,
}) {
  const exchange = Number(exchangeTimeMs);
  const received = Number(receivedAtMs);
  const available = Number(
    availableAtMs ?? (availabilityEstimated ? exchange + 1 : receivedAtMs)
  );
  if (
    !source ||
    !symbol ||
    !Number.isFinite(exchange) ||
    !Number.isFinite(received) ||
    !Number.isFinite(available)
  )
    throw new Error("market_data_envelope_invalid");
  if (!["exact", "estimated", "organic_only"].includes(availabilityQuality))
    throw new Error("market_data_availability_quality_invalid");
  if (
    !["not_revisable", "unknown", "provisional", "revised"].includes(
      revisionStatus
    )
  )
    throw new Error("market_data_revision_status_invalid");
  const envelope = {
    schema: "athena.crypto.market-data-envelope",
    schemaVersion: "2.0",
    source,
    symbol,
    pair: `${symbol}${QUOTE}`,
    market,
    eventType,
    exchangeTimeMs: exchange,
    receivedAtMs: received,
    availableAtMs: available,
    backfilled: Boolean(backfilled),
    availabilityEstimated: Boolean(availabilityEstimated),
    deduplicated: Boolean(deduplicated),
    gapDetected: Boolean(gapDetected),
    formingCandleExcluded: Boolean(formingCandleExcluded),
    availabilityQuality,
    revisionStatus,
    providerVersion: providerVersion || null,
    licenseId: licenseId || null,
    citationUrl: citationUrl || null,
  };
  return {
    ...envelope,
    eventId: crypto
      .createHash("sha256")
      .update(
        `${source}|${symbol}|${market}|${eventType}|${exchange}|${available}`
      )
      .digest("hex"),
  };
}

function envelopeForBar(
  bar,
  {
    receivedAtMs = Date.now(),
    backfilled = false,
    availabilityEstimated = backfilled,
    availableAtMs,
    gapDetected = false,
    availabilityQuality = availabilityEstimated ? "estimated" : "exact",
    revisionStatus = "not_revisable",
    providerVersion = null,
    licenseId = null,
    citationUrl = null,
  } = {}
) {
  return marketDataEnvelope({
    source: bar.source,
    symbol: bar.symbol,
    eventType: `${bar.interval}_kline_closed`,
    exchangeTimeMs: bar.closeTimeMs,
    receivedAtMs,
    availableAtMs:
      availableAtMs ??
      (availabilityEstimated ? bar.closeTimeMs + 1 : receivedAtMs),
    backfilled,
    availabilityEstimated,
    gapDetected,
    availabilityQuality,
    revisionStatus,
    providerVersion,
    licenseId,
    citationUrl,
  });
}

module.exports = {
  envelopeForBar,
  marketDataEnvelope,
};
