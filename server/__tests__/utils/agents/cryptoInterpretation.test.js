/* eslint-env jest */

process.env.NODE_ENV = "test";

const {
  INTERPRETATION_COMPLETION_OPTIONS,
  INTERPRETATION_SCHEMA,
  _internals,
  renderMonitoringReport,
  renderValidatedReport,
  validateInterpretation,
  validatedCryptoMarketContinuation,
} = require("../../../utils/agents/aibitat/plugins/crypto-market/interpretation");
const {
  resetSemanticEventsForTests,
  semanticEventSnapshot,
} = require("../../../utils/observability/semanticEvents");

function resultFixture() {
  return {
    tool: "crypto_market_snapshot",
    mode: "analysis",
    symbol: "BTC",
    quote: "USDT",
    formulaVersion: "crypto-quant-v2",
    analysisStatus: "complete",
    sourceQuality: { status: "complete" },
    partialFailures: [],
    confluence: { state: "bullish_alignment" },
    timeframes: {
      "1d": {
        candles: [[1_800_000_000_000, "99", "102", "98", "101", "1000"]],
        regime: { state: "bullish_trend" },
        indicators: {
          movingAverages: {
            ma5: { value: 100 },
            ma10: { value: 99 },
            ma30: { value: 95 },
          },
          macd: { histogram: 1 },
          rsi14: 60,
          adx14: { value: 30 },
          volume: { ratioToSma20: 1.2 },
          moneyFlow: {
            cmf20: 0.1,
            mfi14: 60,
            accumulationDistribution: {
              shortTermSlope: { normalizedByVolume: 0.5 },
            },
          },
          trendStructure: {
            pivots: { state: "bullish" },
            linearRegression20: { slopePctPerBar: 0.2, rSquared: 0.8 },
            efficiencyRatio20: 0.7,
          },
        },
      },
    },
    scenarios: [
      {
        id: "bullish_breakout",
        triggerMet: true,
        confirmed: true,
        targets: [{ value: 110, basis: "daily_previous50_resistance" }],
        invalidation: { type: "daily_close_below", value: 95 },
      },
    ],
    supportingEvidence: {
      formulaVersion: "crypto-market-evidence-v1",
      status: "complete",
      spotMicrostructure: { status: "warming" },
      derivatives: { status: "unavailable", reason: "test_fixture" },
      scenarioVerdicts: [
        {
          scenarioId: "bullish_breakout",
          supportVerdict: "conflicts",
          families: [
            { family: "price_trend", state: "supports" },
            { family: "price_volume", state: "conflicts" },
            { family: "spot_microstructure", state: "conflicts" },
          ],
        },
      ],
    },
    forecasting: {
      status: "shadow",
      modelVersion: "crypto-forecast-v1",
      featureSchemaVersion: "crypto-forecast-features-v1",
      asOf: "2026-07-29T00:00:00.000Z",
      datasetManifestSha256: "d".repeat(64),
      modelArtifactSha256: "e".repeat(64),
      horizons: {
        "4h": {
          probabilities: { up: 0.7, range: 0.1, down: 0.2 },
          predictedState: null,
          abstained: true,
          abstainReasons: ["model_shadow"],
          evidenceCoverage: 1,
          dataFreshnessMs: 10_000,
          drivers: [],
        },
      },
    },
  };
}

function validInterpretation() {
  return {
    schema: INTERPRETATION_SCHEMA,
    marketState: "bullish_alignment",
    timeframeOrder: ["1d"],
    scenarioOrder: ["bullish_breakout"],
    selectedEvidenceIds: [
      "regime:1d",
      "money-flow:1d",
      "scenario:bullish_breakout",
      "support:bullish_breakout:price_volume",
    ],
    timeframeJudgments: [
      {
        timeframeId: "1d",
        regime: "bullish_trend",
        evidenceIds: ["regime:1d"],
      },
    ],
    scenarioJudgments: [
      {
        scenarioId: "bullish_breakout",
        triggerMet: true,
        confirmed: true,
        supportVerdict: "conflicts",
        evidenceIds: [
          "scenario:bullish_breakout",
          "support:bullish_breakout:price_volume",
        ],
      },
    ],
    limitationCodes: [
      "conditional_scenarios_not_probabilities",
      "microstructure_warming",
      "derivatives_unavailable",
    ],
  };
}

describe("validated crypto interpretation", () => {
  let log;

  beforeEach(() => {
    log = jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    resetSemanticEventsForTests();
    log.mockRestore();
  });

  it("rejects invented state and unknown evidence references", () => {
    expect(
      validateInterpretation(
        {
          ...validInterpretation(),
          marketState: "bottom_stabilized",
          selectedEvidenceIds: [
            "regime:1d",
            "money-flow:1d",
            "scenario:bullish_breakout",
            "institutional_buying",
          ],
          scenarioJudgments: [
            {
              ...validInterpretation().scenarioJudgments[0],
              supportVerdict: "supports",
            },
          ],
        },
        resultFixture()
      )
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        "mismatch:marketState",
        "unknown:selectedEvidenceId",
        "mismatch:scenarioJudgments.bullish_breakout",
      ]),
    });
  });

  it("renders only validated values with family paths, conflict language, and provenance", () => {
    const text = renderValidatedReport({
      interpretation: validInterpretation(),
      result: resultFixture(),
      toolRun: { runId: "run-1", resultSha256: "a".repeat(64) },
      validationStatus: "validated",
    });

    expect(text).toContain("技术条件已触发，但支持数据冲突");
    expect(text).toContain(
      "〔量价资金流｜timeframes.1d.indicators.volume；timeframes.1d.indicators.moneyFlow〕"
    );
    expect(text).toContain(
      "`support:bullish_breakout:price_volume` — price_volume"
    );
    expect(text).toContain(`结果 SHA-256：${"a".repeat(64)}`);
    expect(text).toContain("仅为影子研究，模型已弃权");
    expect(text).toContain("forecasting.horizons.4h.abstainReasons");
    expect(text).not.toContain("forecasting.horizons.4h.probabilities");
    expect(text).not.toMatch(/筑底|企稳|机构进场|上涨概率|下跌概率|预测方向/);
  });

  it("uses a deterministic monitoring report and never calls the LLM", async () => {
    const monitoringFixture = {
      ...resultFixture(),
      analysisPolicy: {
        mode: "monitoring_only",
        directDirectionalPrediction: false,
      },
      forecasting: {
        ...resultFixture().forecasting,
        publicMode: "monitoring_only",
        analysisPolicy: { mode: "monitoring_only" },
        horizons: {
          "4h": {
            status: "shadow",
            publicMode: "monitoring_only",
            abstained: true,
            abstainReasons: ["monitoring_only_policy", "model_shadow"],
            evidenceCoverage: 1,
            dataFreshnessMs: 10_000,
          },
        },
      },
    };
    const generate = jest.fn();
    const result = await validatedCryptoMarketContinuation({
      result: JSON.stringify(monitoringFixture),
      toolRun: { runId: "monitor-1", resultSha256: "f".repeat(64) },
      generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      handled: true,
      validationStatus: "monitoring_only",
      validationErrorCodes: [],
    });
    expect(result.text).toContain("当前模式：仅数据监测");
    expect(result.text).toContain("上轨突破条件");
    expect(result.text).toContain("这是事件状态，不是未来方向判断");
    expect(result.text).not.toMatch(
      /上涨概率\s*\d|下跌概率\s*\d|条件目标位|建议做多|建议做空/
    );
    expect(
      renderMonitoringReport({
        result: monitoringFixture,
        toolRun: { runId: "monitor-1", resultSha256: "f".repeat(64) },
      })
    ).toBe(result.text);
    expect(semanticEventSnapshot().at(-1)).toMatchObject({
      eventType: "crypto.analysis.monitoring_report",
      metadata: {
        validationStatus: "monitoring_only",
        modelCallCount: "0",
      },
    });
  });

  it("repairs parsed invalid JSON deterministically without a second model call", async () => {
    const generate = jest.fn().mockResolvedValueOnce('{"schema":"wrong"}');

    const result = await validatedCryptoMarketContinuation({
      result: JSON.stringify(resultFixture()),
      toolRun: { runId: "run-2", resultSha256: "b".repeat(64) },
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      [expect.objectContaining({ role: "user" })],
      INTERPRETATION_COMPLETION_OPTIONS
    );
    expect(result).toMatchObject({
      handled: true,
      validationStatus: "repaired",
      validationErrorCodes: expect.arrayContaining([
        "schema_mismatch",
        "market_state_mismatch",
      ]),
    });
    expect(result.text).toContain("解释校验：repaired");
    expect(result.text).toContain("修复方式：deterministic_patch");
    expect(result.text).toContain("校验错误码：");
    expect(semanticEventSnapshot().at(-1)).toMatchObject({
      eventType: "crypto.analysis.interpretation_repaired",
      metadata: {
        validationErrorCodes: expect.stringContaining("schema_mismatch"),
        repairStrategy: "deterministic_patch",
        modelCallCount: "1",
      },
    });
  });

  it("falls back immediately when the single structured response is not JSON", async () => {
    const generate = jest.fn().mockResolvedValue("自由文本：机构正在吸筹");
    const result = await validatedCryptoMarketContinuation({
      result: JSON.stringify(resultFixture()),
      toolRun: { runId: "run-3", resultSha256: "c".repeat(64) },
      generate,
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      handled: true,
      validationStatus: "fallback",
      validationErrorCodes: expect.arrayContaining([
        "invalid_json",
        "deterministic_repair_unavailable",
      ]),
    });
    expect(result.text).toContain("解释校验：deterministic_fallback");
    expect(result.text).not.toMatch(
      /机构正在吸筹|已经筑底|已经企稳|上涨概率|下跌概率/
    );
  });

  it("maps dynamic validation errors to bounded low-cardinality codes", () => {
    expect(
      _internals.validationErrorCodes([
        "mismatch:timeframeJudgments.1d.regime",
        "mismatch:timeframeJudgments.4h.regime",
        "invalid:scenarioJudgments.bullish_breakout.evidenceIds",
        "generation_failed:TimeoutError",
        "unexpected:provider-specific-detail",
      ])
    ).toEqual([
      "generation_failed",
      "scenario_evidence_invalid",
      "timeframe_regime_mismatch",
      "unknown_validation_error",
    ]);

    expect(
      _internals.validationErrorCodes([
        "invalid:schema",
        "mismatch:marketState",
        "invalid:timeframeOrder",
        "invalid:scenarioOrder",
        "invalid:selectedEvidenceIds",
        "unknown:selectedEvidenceId",
        "invalid:timeframeJudgments",
        "invalid:scenarioJudgments",
        "missing:limitationCodes",
      ])
    ).toHaveLength(8);
    expect(
      _internals.validationErrorCodes([
        "invalid:schema",
        "mismatch:marketState",
        "invalid:timeframeOrder",
        "invalid:scenarioOrder",
        "invalid:selectedEvidenceIds",
        "unknown:selectedEvidenceId",
        "invalid:timeframeJudgments",
        "invalid:scenarioJudgments",
        "missing:limitationCodes",
      ])
    ).toContain("additional_validation_errors");
  });
});
