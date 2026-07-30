const {
  emitSemanticEvent,
} = require("../../../../observability/semanticEvents");
const {
  MODEL_RESULT_MAX_CHARS,
} = require("../../../../goldAnalysis/constants");

const STATE_LABELS = Object.freeze({
  rising_trend: "已收盘数据呈较强上行趋势状态",
  rising_bias: "已收盘数据呈上行偏置状态",
  falling_trend: "已收盘数据呈较强下行趋势状态",
  falling_bias: "已收盘数据呈下行偏置状态",
  range_or_mixed: "已收盘数据呈区间或混合状态",
  insufficient: "数据不足",
  contemporaneous_headwind: "美元与实际利率条件构成当前逆风",
  contemporaneous_tailwind: "美元与实际利率条件构成当前顺风",
  mixed: "美元与实际利率条件混合",
});

function parseResult(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function number(value, digits = 2) {
  return value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value))
    ? Number(value).toLocaleString("zh-CN", {
        maximumFractionDigits: digits,
      })
    : "不可用";
}

function time(value) {
  return value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value))
    ? new Date(Number(value)).toISOString()
    : "不可用";
}

function state(value) {
  return STATE_LABELS[value] || String(value || "不可用");
}

function sourceLine(path, text) {
  return `- ${text}（字段：\`${path}\`）`;
}

function timeframeLine(id, value = {}) {
  const indicators = value.indicators || {};
  return sourceLine(
    `timeframes.${id}`,
    `${id}：${state(value.observedState)}；收盘样本 ${number(
      value.closedBarsUsed,
      0
    )} 根；RSI14 ${number(indicators.rsi14)}；ADX14 ${number(
      indicators.adx14
    )}；ATR14 ${number(indicators.atr14)}；最近闭合 ${time(
      value.latestClosedAtMs
    )}；成交量 ${value.volumeAvailability || "不可用"}`
  );
}

function macroLine(name, label, value = {}) {
  return sourceLine(
    `macroContext.series.${name}`,
    `${label} ${number(value.value, 4)}，近 5 个观测变化 ${number(
      value.change5,
      4
    )}，数据时点 ${time(value.observedAtMs)}`
  );
}

function renderGoldMonitoringReport({ result }) {
  const current = result.currentMarket || {};
  const quality = result.dataQuality || {};
  const macro = result.macroContext || {};
  const positioning = result.positioning || {};
  const volatility = result.volatilityRisk || {};
  const shadow = result.shadowResearch || {};
  const sections = [
    "# 黄金市场量化监测（GQSS V1）",
    `本次结果为${result.analysisStatus === "complete" ? "完整" : "部分"}监测，生成时间 ${result.asOf || "不可用"}。仅整理已经可用的数据并描述当前状态，不包含任何前瞻结论、估值点位或操作建议。`,
    "## 当前市场",
    sourceLine(
      "currentMarket",
      `XAU/USD 参考价 ${number(current.price)}，主来源 ${
        current.primarySource || "不可用"
      }，时点 ${time(current.observedAtMs)}，交叉源偏差 ${number(
        current.crosscheck?.deviationBps,
        2
      )} bps，状态 ${current.status || "不可用"}`
    ),
    "## 多周期已收盘状态",
    ...Object.entries(result.timeframes || {}).map(([id, value]) =>
      timeframeLine(id, value)
    ),
    "## 宏观环境",
    sourceLine("macroContext.observedState", state(macro.observedState)),
    macroLine("dxy", "美元指数", macro.series?.dxy),
    macroLine("realYield10y", "美国 10 年实际利率", macro.series?.realYield10y),
    macroLine("vix", "VIX", macro.series?.vix),
    macroLine("gvz", "GVZ", macro.series?.gvz),
    "## 持仓、ETF 与跨市场",
    sourceLine(
      "positioning.managedMoney",
      `CFTC Managed Money 净持仓/OI ${number(
        positioning.managedMoney?.netRatio,
        4
      )}，156 周拥挤 Z 值 ${number(
        positioning.managedMoney?.crowdingZ156w,
        3
      )}，状态 ${positioning.observedState || "不可用"}，发布时间 ${time(
        positioning.availableAtMs
      )}`
    ),
    sourceLine(
      "etfFlows",
      `GLD 持仓吨数 ${number(
        result.etfFlows?.gld?.tonnesInTrust,
        4
      )}，IAU 持仓吨数 ${number(
        result.etfFlows?.iau?.tonnesInTrust,
        4
      )}；若发行人页面未提供可解析字段则保持不可用`
    ),
    sourceLine(
      "chinaMarket",
      `上海金状态 ${result.chinaMarket?.observedState || "不可用"}，相对国际参考溢折价 ${number(
        result.chinaMarket?.premiumRatio == null
          ? null
          : Number(result.chinaMarket.premiumRatio) * 100,
        3
      )}%`
    ),
    sourceLine(
      "crossMarket.goldSilver",
      `金银比 ${number(result.crossMarket?.goldSilver?.ratio, 3)}`
    ),
    "## 波动与风险监测",
    sourceLine(
      "volatilityRisk",
      `日内已收盘小时收益 RV ${number(
        volatility.dailyRealizedVariance,
        8
      )}，下行半方差 ${number(
        volatility.downsideSemivariance,
        8
      )}，BPV ${number(volatility.bipowerVariation, 8)}，跳跃强度 ${number(
        volatility.jumpIntensity,
        8
      )}`
    ),
    ...(result.monitoringSignals || []).map((signal) =>
      sourceLine(
        `monitoringSignals.${signal.id}`,
        `${signal.id}：${signal.observed ? "已观察到" : "未观察到"}，状态 ${
          signal.state || "不可用"
        }`
      )
    ),
    "## 数据质量与研究状态",
    sourceLine(
      "dataQuality",
      `质量 ${quality.status || "不可用"}；来源状态 ${
        Object.entries(quality.sourceStatuses || {})
          .map(([name, status]) => `${name}=${status}`)
          .join("，") || "不可用"
      }；部分失败 ${number(quality.partialFailureCount, 0)} 项`
    ),
    sourceLine(
      "shadowResearch",
      `研究层 ${shadow.status || "不可用"}，治理状态 ${
        shadow.governanceState || "不可用"
      }；下一交易日与下一周均保持 abstained，公开结果不含方向、概率或收益分位数`
    ),
    `审计：结果 SHA \`${result.provenance?.resultSha256 || "不可用"}\`；数据清单 SHA \`${result.provenance?.datasetManifestSha256 || "不可用"}\`；因子注册表 SHA \`${result.factorRegistrySha256 || "不可用"}\`。`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function compactTimeframe(value = {}) {
  return {
    status: value.status,
    closedBarsUsed: value.closedBarsUsed,
    latestClosedAtMs: value.latestClosedAtMs,
    volumeAvailability: value.volumeAvailability,
    indicators: value.indicators,
    observedState: value.observedState,
  };
}

function prepareGoldResultForModel(result) {
  const value = parseResult(result);
  if (!value) return result;
  const projected = {
    tool: value.tool,
    ok: value.ok,
    schema: value.schema,
    schemaVersion: value.schemaVersion,
    analysisStatus: value.analysisStatus,
    analysisPolicy: value.analysisPolicy,
    currentMarket: value.currentMarket,
    timeframes: Object.fromEntries(
      Object.entries(value.timeframes || {}).map(([id, timeframe]) => [
        id,
        compactTimeframe(timeframe),
      ])
    ),
    macroContext: value.macroContext,
    positioning: value.positioning,
    etfFlows: value.etfFlows,
    chinaMarket: value.chinaMarket,
    crossMarket: value.crossMarket,
    volatilityRisk: value.volatilityRisk,
    factorFamilies: value.factorFamilies,
    monitoringSignals: value.monitoringSignals,
    dataQuality: value.dataQuality,
    partialFailures: value.partialFailures,
    shadowResearch: value.shadowResearch,
    provenance: value.provenance,
  };
  const serialized = JSON.stringify(projected);
  return serialized.length <= MODEL_RESULT_MAX_CHARS
    ? serialized
    : JSON.stringify({
        ...projected,
        macroContext: {
          status: value.macroContext?.status,
          observedState: value.macroContext?.observedState,
          series: Object.fromEntries(
            Object.entries(value.macroContext?.series || {}).map(
              ([name, item]) => [
                name,
                {
                  value: item.value,
                  change5: item.change5,
                  zscore60: item.zscore60,
                  observedAtMs: item.observedAtMs,
                },
              ]
            )
          ),
        },
      });
}

async function validatedGoldMarketContinuation({ result, toolRun }) {
  const value = parseResult(result);
  if (!value || value.tool !== "gold_market_analysis")
    return { handled: false };
  emitSemanticEvent({
    eventType: "gold.analysis.monitoring_report",
    category: "agent_tool",
    severity: value.analysisStatus === "unavailable" ? "warning" : "info",
    outcome: value.analysisStatus === "unavailable" ? "degraded" : "success",
    subject: {
      type: "tool",
      component: "gold_market_analysis",
      operation: "interpret",
    },
    impact: { userEffect: "deterministic_gold_monitoring_report" },
    metadata: {
      runId: toolRun?.runId || value.provenance?.runId || null,
      resultSha256:
        toolRun?.resultSha256 || value.provenance?.resultSha256 || null,
      validationStatus: "deterministic_monitoring_only",
      validationErrorCount: 0,
      validationErrorCodes: "none",
      repairStrategy: "deterministic_gqss_template",
      durationMs: 0,
      modelCallCount: "0",
    },
  });
  return {
    handled: true,
    text: renderGoldMonitoringReport({ result: value }),
    validationStatus: "deterministic_monitoring_only",
    validationErrorCodes: [],
  };
}

module.exports = {
  prepareGoldResultForModel,
  renderGoldMonitoringReport,
  validatedGoldMarketContinuation,
};
