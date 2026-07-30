/* eslint-env jest */

const {
  COST_MODEL,
  COST_MODEL_SHA256,
  FEATURE_NAMES,
  FEATURE_REGISTRY,
  FEATURE_REGISTRY_SHA256,
  canonicalJson,
  sha256,
  validateFeatureRegistry,
} = require("../../../utils/cryptoForecasting/contracts");
const {
  marketDataEnvelope,
} = require("../../../utils/cryptoForecasting/marketDataEnvelope");

describe("crypto forecasting contracts", () => {
  it("exposes one canonical registry for the exact 39 model inputs", () => {
    expect(validateFeatureRegistry(FEATURE_REGISTRY)).toEqual({
      valid: true,
      errors: [],
    });
    expect(FEATURE_NAMES).toHaveLength(39);
    expect(FEATURE_REGISTRY_SHA256).toBe(
      sha256(canonicalJson(FEATURE_REGISTRY))
    );
    expect(COST_MODEL_SHA256).toBe(sha256(canonicalJson(COST_MODEL)));
  });

  it("rejects duplicate or reordered registry contracts deterministically", () => {
    const duplicate = {
      ...FEATURE_REGISTRY,
      features: [
        ...FEATURE_REGISTRY.features.slice(0, -1),
        FEATURE_REGISTRY.features[0],
      ],
    };
    expect(validateFeatureRegistry(duplicate)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(["duplicate_registry_feature"]),
    });
  });

  it("records the event-time and availability-time boundary without payload data", () => {
    const envelope = marketDataEnvelope({
      source: "binance",
      symbol: "BTC",
      exchangeTimeMs: 1_000,
      receivedAtMs: 2_000,
      backfilled: true,
      availabilityEstimated: true,
    });
    expect(envelope).toMatchObject({
      schema: "athena.crypto.market-data-envelope",
      schemaVersion: "2.0",
      exchangeTimeMs: 1_000,
      receivedAtMs: 2_000,
      availableAtMs: 1_001,
      availabilityEstimated: true,
      availabilityQuality: "estimated",
      revisionStatus: "not_revisable",
      formingCandleExcluded: true,
    });
    expect(envelope.eventId).toMatch(/^[a-f0-9]{64}$/);
  });
});
