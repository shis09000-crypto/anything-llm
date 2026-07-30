/* eslint-env jest */

const {
  _internals,
  buildSupportingEvidence,
  enhancedIndicators,
  relativeStrength,
} = require("../../../utils/agents/aibitat/plugins/crypto-market/supportingEvidence");

function rows(count = 60, step = 1) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * step;
    return {
      ts: 1_700_000_000_000 + index * 60_000,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100 + index,
    };
  });
}

describe("crypto supporting evidence formulas and fusion", () => {
  it("computes CMF, MFI, A/D, Donchian, regression, and efficiency deterministically", () => {
    const input = rows();
    const indicators = enhancedIndicators(input);

    expect(indicators.moneyFlow.cmf20).toBe(0);
    expect(indicators.moneyFlow.mfi14).toBe(100);
    expect(indicators.moneyFlow.accumulationDistribution.value).toBe(0);
    expect(
      indicators.moneyFlow.accumulationDistribution.shortTermSlope
    ).toEqual({
      bars: 3,
      valueChange: 0,
      normalizedByVolume: 0,
    });
    expect(indicators.trendStructure.donchian20).toMatchObject({
      upper: 159,
      lower: 138,
      middle: 148.5,
    });
    expect(indicators.trendStructure.linearRegression20).toMatchObject({
      slopePerBar: 1,
      rSquared: 1,
    });
    expect(indicators.trendStructure.efficiencyRatio20).toBe(1);
    expect(_internals.marketStructure(input).state).toBe("insufficient");
  });

  it("computes return differences and aligned-return correlation versus BTC", () => {
    const benchmark = rows(60, 1).map((row) => [
      row.ts,
      String(row.open),
      String(row.high),
      String(row.low),
      String(row.close),
      String(row.volume),
    ]);
    const target = rows(60, 2).map((row) => [
      row.ts,
      String(row.open),
      String(row.high),
      String(row.low),
      String(row.close),
      String(row.volume),
    ]);

    expect(relativeStrength(target, benchmark)).toMatchObject({
      benchmark: "BTC_USDT",
      alignedBars: 60,
      status: "available",
      returnDifferencePct: {
        bars5: expect.any(Number),
        bars20: expect.any(Number),
      },
      returnCorrelation30: expect.any(Number),
    });
  });

  it("treats falling OI and extreme funding as risk evidence, never as a new direction", () => {
    const scenario = {
      id: "bullish_breakout",
      triggerMet: true,
      confirmed: true,
    };
    const result = buildSupportingEvidence({
      timeframes: {
        "1d": {
          regime: { state: "bullish_trend" },
          indicators: {
            moneyFlow: {
              cmf20: 0.2,
              mfi14: 70,
              accumulationDistribution: {
                shortTermSlope: { normalizedByVolume: 0.5 },
              },
            },
          },
        },
        "4h": { regime: { state: "bullish_trend" }, indicators: {} },
      },
      confluence: { bullish: ["1d", "4h"], bearish: [] },
      scenarios: [scenario],
      marketEvidence: {
        status: "partial",
        spotMicrostructure: { status: "warming" },
        derivatives: {
          status: "complete",
          openInterest: { changePct: { "4h": -5 } },
          positioning: { takerLongShortRatio: 1.2 },
          funding: { zScore30: 2.5 },
        },
      },
    });

    const verdict = result.scenarioVerdicts[0];
    expect(verdict.triggerMet).toBe(true);
    expect(verdict.confirmed).toBe(true);
    expect(
      verdict.families.find(
        ({ family }) => family === "derivatives_positioning"
      )
    ).toMatchObject({
      state: "conflicts",
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "open_interest_expanding_4h",
          state: "conflicts",
        }),
        expect.objectContaining({
          id: "funding_crowding_risk",
          state: "conflicts",
        }),
      ]),
    });
    expect(verdict.supportVerdict).toBe("mixed");
    expect(scenario).toEqual({
      id: "bullish_breakout",
      triggerMet: true,
      confirmed: true,
    });
  });
});
