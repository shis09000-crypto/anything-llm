const {
  emitSemanticEvent,
} = require("../../../../observability/semanticEvents");

const INTERPRETATION_SCHEMA = "crypto-quant-interpretation-v1";
const MAX_SELECTED_EVIDENCE = 16;
const MAX_RECORDED_VALIDATION_ERROR_CODES = 8;
const INTERPRETATION_COMPLETION_OPTIONS = Object.freeze({
  isolated: true,
  thinking: "disabled",
  temperature: 0,
  maxTokens: 2_048,
  timeoutMs: 25_000,
  maxRetries: 0,
  responseFormat: { type: "json_object" },
});

const VALIDATION_ERROR_CODE_RULES = [
  [/^invalid_json_object$/, "invalid_json"],
  [/^generation_not_attempted$/, "generation_not_attempted"],
  [/^generation_failed:/, "generation_failed"],
  [/^deterministic_repair_unavailable$/, "deterministic_repair_unavailable"],
  [/^invalid:schema$/, "schema_mismatch"],
  [/^mismatch:marketState$/, "market_state_mismatch"],
  [/^invalid:timeframeOrder$/, "timeframe_order_invalid"],
  [/^invalid:scenarioOrder$/, "scenario_order_invalid"],
  [/^invalid:selectedEvidenceIds$/, "evidence_selection_invalid"],
  [/^unknown:selectedEvidenceId$/, "evidence_reference_unknown"],
  [/^invalid:timeframeJudgments$/, "timeframe_judgments_invalid"],
  [/^mismatch:timeframeJudgments\.[^.]+\.regime$/, "timeframe_regime_mismatch"],
  [
    /^invalid:timeframeJudgments\.[^.]+\.evidenceIds$/,
    "timeframe_evidence_invalid",
  ],
  [/^invalid:scenarioJudgments$/, "scenario_judgments_invalid"],
  [/^mismatch:scenarioJudgments\.[^.]+$/, "scenario_state_mismatch"],
  [
    /^invalid:scenarioJudgments\.[^.]+\.evidenceIds$/,
    "scenario_evidence_invalid",
  ],
  [/^missing:limitationCodes$/, "limitation_codes_missing"],
];

function validationErrorCodes(errors = []) {
  const codes = (Array.isArray(errors) ? errors : [])
    .map((error) => {
      const normalized = String(error || "");
      return (
        VALIDATION_ERROR_CODE_RULES.find(([matcher]) =>
          matcher.test(normalized)
        )?.[1] || "unknown_validation_error"
      );
    })
    .filter(Boolean);
  const unique = [...new Set(codes)].sort();
  if (unique.length <= MAX_RECORDED_VALIDATION_ERROR_CODES) return unique;
  return [
    ...unique.slice(0, MAX_RECORDED_VALIDATION_ERROR_CODES - 1),
    "additional_validation_errors",
  ];
}

function serializedValidationErrorCodes(errors = []) {
  const codes = validationErrorCodes(errors);
  return codes.length ? codes.join(",") : "none";
}

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = String(value || "").trim();
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(withoutFence);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    const first = withoutFence.indexOf("{");
    const last = withoutFence.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      const parsed = JSON.parse(withoutFence.slice(first, last + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
}

function evidenceCatalog(result = {}) {
  const catalog = [];
  for (const [id, timeframe] of Object.entries(result.timeframes || {})) {
    const indicators = timeframe.indicators || {};
    catalog.push({
      id: `regime:${id}`,
      family: "price_trend",
      sourcePath: `timeframes.${id}.regime.state`,
      value: timeframe.regime?.state || "unavailable",
    });
    catalog.push({
      id: `ma:${id}`,
      family: "price_trend",
      sourcePath: `timeframes.${id}.indicators.movingAverages`,
      value: {
        ma5: indicators.movingAverages?.ma5?.value ?? null,
        ma10: indicators.movingAverages?.ma10?.value ?? null,
        ma30: indicators.movingAverages?.ma30?.value ?? null,
      },
    });
    catalog.push({
      id: `momentum:${id}`,
      family: "price_trend",
      sourcePath: `timeframes.${id}.indicators`,
      value: {
        macdHistogram: indicators.macd?.histogram ?? null,
        rsi14: indicators.rsi14 ?? null,
        adx14: indicators.adx14?.value ?? null,
      },
    });
    catalog.push({
      id: `money-flow:${id}`,
      family: "price_volume",
      sourcePath: `timeframes.${id}.indicators.moneyFlow`,
      value: indicators.moneyFlow || null,
    });
    catalog.push({
      id: `structure:${id}`,
      family: "price_trend",
      sourcePath: `timeframes.${id}.indicators.trendStructure`,
      value: indicators.trendStructure || null,
    });
  }
  for (const scenario of result.scenarios || []) {
    catalog.push({
      id: `scenario:${scenario.id}`,
      family: "price_trend",
      sourcePath: `scenarios.${scenario.id}`,
      value: {
        triggerMet: scenario.triggerMet,
        confirmed: scenario.confirmed,
      },
    });
  }
  for (const verdict of result.supportingEvidence?.scenarioVerdicts || []) {
    for (const family of verdict.families || []) {
      catalog.push({
        id: `support:${verdict.scenarioId}:${family.family}`,
        family: family.family,
        sourcePath: `supportingEvidence.scenarioVerdicts.${verdict.scenarioId}.families.${family.family}`,
        value: family.state,
      });
    }
  }
  return catalog;
}

function requiredLimitations(result = {}) {
  const limitations = ["conditional_scenarios_not_probabilities"];
  if (
    result.sourceQuality?.status === "degraded" ||
    (result.partialFailures || []).length > 0
  )
    limitations.push("source_quality_degraded");
  if (result.supportingEvidence?.status === "warming")
    limitations.push("microstructure_warming");
  if (
    !["complete", "partial"].includes(
      result.supportingEvidence?.derivatives?.status
    )
  )
    limitations.push("derivatives_unavailable");
  if (!result.forecasting || result.forecasting.status === "unavailable")
    limitations.push("forecast_unavailable");
  else if (result.forecasting.status === "shadow")
    limitations.push("forecast_shadow_not_directional");
  else if (
    result.forecasting.status === "abstained" ||
    Object.values(result.forecasting.horizons || {}).every(
      (horizon) => horizon?.abstained !== false
    )
  )
    limitations.push("forecast_abstained");
  else if (
    Object.values(result.forecasting.horizons || {}).some(
      (horizon) => horizon?.abstained === true
    )
  )
    limitations.push("forecast_partial_abstention");
  return limitations;
}

function compactEvidenceCatalogForModel(result = {}) {
  return evidenceCatalog(result).map((entry) => {
    let entryValue = entry.value;
    if (entry.id.startsWith("money-flow:")) {
      entryValue = {
        cmf20: entry.value?.cmf20 ?? null,
        mfi14: entry.value?.mfi14 ?? null,
        accumulationDistributionSlope:
          entry.value?.accumulationDistribution?.shortTermSlope
            ?.normalizedByVolume ?? null,
      };
    } else if (entry.id.startsWith("structure:")) {
      entryValue = {
        pivotState: entry.value?.pivots?.state || "insufficient",
        slopePctPerBar: entry.value?.linearRegression20?.slopePctPerBar ?? null,
        rSquared: entry.value?.linearRegression20?.rSquared ?? null,
        efficiencyRatio20: entry.value?.efficiencyRatio20 ?? null,
      };
    }
    return {
      id: entry.id,
      family: entry.family,
      sourcePath: entry.sourcePath,
      value: entryValue,
    };
  });
}

function interpretationPrompt(result = {}) {
  const canonicalOutput = fallbackInterpretation(result);
  return {
    role: "user",
    content: [
      "Return one minified JSON object only. Do not write Markdown, prose, or wrapper keys.",
      "Copy canonicalOutput exactly. You may only replace selectedEvidenceIds with 4-16 unique ids from allowedEvidence, prioritizing independent decision-relevant evidence.",
      "Do not change schema, marketState, orders, judgments, booleans, verdicts, limitations, values, or evidence ids inside judgments.",
      "forecasting is deterministic server output. Do not infer, copy, summarize, or relabel any direction or probability from it in this JSON task.",
      "Do not copy allowedEvidence into the output.",
      JSON.stringify({
        canonicalOutput,
        allowedEvidence: compactEvidenceCatalogForModel(result),
      }),
    ].join("\n"),
  };
}

function sameMembers(actual = [], expected = []) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function validateInterpretation(value, result = {}) {
  const errors = [];
  const parsed = parseJsonObject(value);
  if (!parsed)
    return { valid: false, errors: ["invalid_json_object"], value: null };
  if (parsed.schema !== INTERPRETATION_SCHEMA) errors.push("invalid:schema");
  const expectedState = result.confluence?.state || "insufficient_data";
  if (parsed.marketState !== expectedState) errors.push("mismatch:marketState");
  const timeframeIds = Object.keys(result.timeframes || {});
  if (!sameMembers(parsed.timeframeOrder, timeframeIds))
    errors.push("invalid:timeframeOrder");
  const scenarioIds = (result.scenarios || []).map(({ id }) => id);
  if (!sameMembers(parsed.scenarioOrder, scenarioIds))
    errors.push("invalid:scenarioOrder");
  const allowedEvidence = new Set(evidenceCatalog(result).map(({ id }) => id));
  if (
    !Array.isArray(parsed.selectedEvidenceIds) ||
    parsed.selectedEvidenceIds.length < Math.min(4, allowedEvidence.size) ||
    parsed.selectedEvidenceIds.length > MAX_SELECTED_EVIDENCE ||
    new Set(parsed.selectedEvidenceIds).size !==
      parsed.selectedEvidenceIds.length
  )
    errors.push("invalid:selectedEvidenceIds");
  else if (parsed.selectedEvidenceIds.some((id) => !allowedEvidence.has(id)))
    errors.push("unknown:selectedEvidenceId");
  const expectedTimeframes = Object.entries(result.timeframes || {}).map(
    ([timeframeId, timeframe]) => ({
      timeframeId,
      regime: timeframe.regime?.state || "unavailable",
    })
  );
  if (
    !Array.isArray(parsed.timeframeJudgments) ||
    !sameMembers(
      parsed.timeframeJudgments.map(({ timeframeId } = {}) => timeframeId),
      expectedTimeframes.map(({ timeframeId }) => timeframeId)
    )
  )
    errors.push("invalid:timeframeJudgments");
  else
    for (const expected of expectedTimeframes) {
      const judgment = parsed.timeframeJudgments.find(
        ({ timeframeId }) => timeframeId === expected.timeframeId
      );
      if (judgment.regime !== expected.regime)
        errors.push(
          `mismatch:timeframeJudgments.${expected.timeframeId}.regime`
        );
      if (
        !Array.isArray(judgment.evidenceIds) ||
        !judgment.evidenceIds.includes(`regime:${expected.timeframeId}`) ||
        judgment.evidenceIds.some((id) => !allowedEvidence.has(id))
      )
        errors.push(
          `invalid:timeframeJudgments.${expected.timeframeId}.evidenceIds`
        );
    }
  const expectedScenarios = (result.scenarios || []).map((scenario) => {
    const verdict = result.supportingEvidence?.scenarioVerdicts?.find(
      ({ scenarioId }) => scenarioId === scenario.id
    );
    return {
      scenarioId: scenario.id,
      triggerMet: scenario.triggerMet === true,
      confirmed: scenario.confirmed === true,
      supportVerdict: verdict?.supportVerdict || "insufficient",
      hasSupportEvidence: (verdict?.families || []).length > 0,
    };
  });
  if (
    !Array.isArray(parsed.scenarioJudgments) ||
    !sameMembers(
      parsed.scenarioJudgments.map(({ scenarioId } = {}) => scenarioId),
      expectedScenarios.map(({ scenarioId }) => scenarioId)
    )
  )
    errors.push("invalid:scenarioJudgments");
  else
    for (const expected of expectedScenarios) {
      const judgment = parsed.scenarioJudgments.find(
        ({ scenarioId }) => scenarioId === expected.scenarioId
      );
      if (
        judgment.triggerMet !== expected.triggerMet ||
        judgment.confirmed !== expected.confirmed ||
        judgment.supportVerdict !== expected.supportVerdict
      )
        errors.push(`mismatch:scenarioJudgments.${expected.scenarioId}`);
      if (
        !Array.isArray(judgment.evidenceIds) ||
        !judgment.evidenceIds.includes(`scenario:${expected.scenarioId}`) ||
        judgment.evidenceIds.some((id) => !allowedEvidence.has(id)) ||
        (expected.hasSupportEvidence &&
          !judgment.evidenceIds.some((id) =>
            id.startsWith(`support:${expected.scenarioId}:`)
          ))
      )
        errors.push(
          `invalid:scenarioJudgments.${expected.scenarioId}.evidenceIds`
        );
    }
  const required = requiredLimitations(result);
  if (
    !Array.isArray(parsed.limitationCodes) ||
    required.some((code) => !parsed.limitationCodes.includes(code))
  )
    errors.push("missing:limitationCodes");
  return { valid: errors.length === 0, errors, value: parsed };
}

function fallbackInterpretation(result = {}) {
  const catalog = evidenceCatalog(result);
  const preferred = [
    ...catalog.filter(({ id }) => id.startsWith("regime:")),
    ...catalog.filter(({ id }) => id.startsWith("scenario:")),
    ...catalog.filter(
      ({ id, value }) => id.startsWith("support:") && value !== "insufficient"
    ),
    ...catalog.filter(({ id }) => id.startsWith("money-flow:")),
  ];
  return {
    schema: INTERPRETATION_SCHEMA,
    marketState: result.confluence?.state || "insufficient_data",
    timeframeOrder: Object.keys(result.timeframes || {}),
    scenarioOrder: (result.scenarios || []).map(({ id }) => id),
    selectedEvidenceIds: [...new Set(preferred.map(({ id }) => id))].slice(
      0,
      MAX_SELECTED_EVIDENCE
    ),
    timeframeJudgments: Object.entries(result.timeframes || {}).map(
      ([timeframeId, timeframe]) => ({
        timeframeId,
        regime: timeframe.regime?.state || "unavailable",
        evidenceIds: [`regime:${timeframeId}`],
      })
    ),
    scenarioJudgments: (result.scenarios || []).map((scenario) => {
      const verdict = result.supportingEvidence?.scenarioVerdicts?.find(
        ({ scenarioId }) => scenarioId === scenario.id
      );
      return {
        scenarioId: scenario.id,
        triggerMet: scenario.triggerMet === true,
        confirmed: scenario.confirmed === true,
        supportVerdict: verdict?.supportVerdict || "insufficient",
        evidenceIds: [
          `scenario:${scenario.id}`,
          ...(verdict?.families || []).map(
            ({ family }) => `support:${scenario.id}:${family}`
          ),
        ].slice(0, 5),
      };
    }),
    limitationCodes: requiredLimitations(result),
  };
}

function repairInterpretationDeterministically(candidate, result = {}) {
  const fallback = fallbackInterpretation(result);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return fallback;

  const allowedEvidence = new Set(evidenceCatalog(result).map(({ id }) => id));
  const selected = [];
  for (const id of Array.isArray(candidate.selectedEvidenceIds)
    ? candidate.selectedEvidenceIds
    : []) {
    if (
      !allowedEvidence.has(id) ||
      selected.includes(id) ||
      selected.length >= MAX_SELECTED_EVIDENCE
    )
      continue;
    selected.push(id);
  }
  for (const id of fallback.selectedEvidenceIds) {
    if (selected.includes(id) || selected.length >= MAX_SELECTED_EVIDENCE)
      continue;
    selected.push(id);
  }

  return {
    ...fallback,
    timeframeOrder: sameMembers(
      candidate.timeframeOrder,
      fallback.timeframeOrder
    )
      ? candidate.timeframeOrder
      : fallback.timeframeOrder,
    scenarioOrder: sameMembers(candidate.scenarioOrder, fallback.scenarioOrder)
      ? candidate.scenarioOrder
      : fallback.scenarioOrder,
    selectedEvidenceIds: selected,
  };
}

function value(value) {
  return value === null || value === undefined ? "不可用" : String(value);
}

function regimeLabel(state) {
  return (
    {
      bullish: "高点与低点同步抬高",
      bearish: "高点与低点同步下移",
      insufficient: "结构点不足",
      bullish_trend: "多头趋势",
      bearish_trend: "空头趋势",
      range: "区间",
      volatile: "高波动",
      mixed: "混合",
      insufficient_data: "数据不足",
      bullish_alignment: "多周期偏多",
      bearish_alignment: "多周期偏空",
      range_alignment: "多周期区间",
    }[state] ||
    state ||
    "不可用"
  );
}

function verdictLabel(state) {
  return (
    {
      supports: "支持",
      conflicts: "冲突",
      mixed: "混合",
      insufficient: "证据不足",
      neutral: "中性",
    }[state] ||
    state ||
    "证据不足"
  );
}

function renderTimeframe(id, timeframe = {}) {
  const indicators = timeframe.indicators || {};
  const ma = indicators.movingAverages || {};
  const flow = indicators.moneyFlow || {};
  const structure = indicators.trendStructure || {};
  const latest = timeframe.candles?.[timeframe.candles.length - 1] || [];
  return [
    `### ${id}`,
    `状态：${regimeLabel(timeframe.regime?.state)}；最后收盘价：${value(latest[4])}。〔价格趋势｜timeframes.${id}.regime.state；timeframes.${id}.candles[-1][4]〕`,
    `MA5/10/30：${value(ma.ma5?.value)} / ${value(ma.ma10?.value)} / ${value(ma.ma30?.value)}；MACD 柱：${value(indicators.macd?.histogram)}；RSI14：${value(indicators.rsi14)}；ADX14：${value(indicators.adx14?.value)}。〔价格趋势｜timeframes.${id}.indicators〕`,
    `量价：量比 ${value(indicators.volume?.ratioToSma20)}，CMF20 ${value(flow.cmf20)}，MFI14 ${value(flow.mfi14)}，A/D 三根归一化斜率 ${value(flow.accumulationDistribution?.shortTermSlope?.normalizedByVolume)}。〔量价资金流｜timeframes.${id}.indicators.volume；timeframes.${id}.indicators.moneyFlow〕`,
    `结构：${regimeLabel(structure.pivots?.state)}；回归斜率 ${value(structure.linearRegression20?.slopePctPerBar)}%/根，R² ${value(structure.linearRegression20?.rSquared)}，效率比 ${value(structure.efficiencyRatio20)}。〔价格趋势｜timeframes.${id}.indicators.trendStructure〕`,
  ].join("\n\n");
}

function renderMicrostructure(micro = {}) {
  if (!micro || micro.status === "unavailable") return "现货微观结构：不可用。";
  const trade5 = micro.tradeFlow?.windows?.["5m"];
  const trade15 = micro.tradeFlow?.windows?.["15m"];
  const depth5 = micro.orderBook?.windows?.["5m"];
  return [
    `现货微观结构状态：${micro.status}；订单簿同步：${micro.orderBook?.synchronized === true ? "是" : "否"}。〔现货微观结构｜supportingEvidence.spotMicrostructure.status；supportingEvidence.spotMicrostructure.orderBook.synchronized〕`,
    `5 分钟 taker 买入占比 ${value(trade5?.takerBuyRatio)}，15 分钟 ${value(trade15?.takerBuyRatio)}；5 分钟 CVD ${value(trade5?.cumulativeVolumeDelta)}。〔现货微观结构｜supportingEvidence.spotMicrostructure.tradeFlow.windows〕`,
    `5 分钟 25bps 深度失衡中位数 ${value(depth5?.depth?.["25bps"]?.imbalanceMedian)}，样本数 ${value(depth5?.sampleCount)}。〔现货微观结构｜supportingEvidence.spotMicrostructure.orderBook.windows.5m〕`,
  ].join("\n\n");
}

function renderDerivatives(derivatives = {}) {
  if (!["complete", "partial"].includes(derivatives?.status))
    return `衍生品旁证：不可用（${derivatives?.reason || "provider_unavailable"}）。`;
  return [
    `衍生品旁证状态：${derivatives.status}；4 小时 OI 变化 ${value(derivatives.openInterest?.changePct?.["4h"])}%，24 小时 ${value(derivatives.openInterest?.changePct?.["24h"])}%。〔衍生品仓位｜supportingEvidence.derivatives.openInterest〕`,
    `资金费率 ${value(derivatives.funding?.latestRate)}，30 期 Z-Score ${value(derivatives.funding?.zScore30)}；taker 多空比 ${value(derivatives.positioning?.takerLongShortRatio)}。〔衍生品仓位｜supportingEvidence.derivatives.funding；supportingEvidence.derivatives.positioning〕`,
    `标记价相对现货基差 ${value(derivatives.market?.markVsSpotBasisPct)}%；4 小时多头/空头爆仓额 ${value(derivatives.liquidations?.["4h"]?.longLiquidationUsd)} / ${value(derivatives.liquidations?.["4h"]?.shortLiquidationUsd)} USD。〔衍生品仓位｜supportingEvidence.derivatives.market；supportingEvidence.derivatives.liquidations.4h〕`,
  ].join("\n\n");
}

function percentage(probability) {
  const number = Number(probability);
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : "不可用";
}

function renderForecasting(forecasting = {}) {
  if (!forecasting || forecasting.status === "unavailable")
    return `预测研究：不可用（${forecasting?.reason || "forecast_not_ready"}）。公开工具仍只展示市场监测数据。〔研究治理｜forecasting.status；forecasting.reason〕`;
  if (
    forecasting.publicMode === "monitoring_only" ||
    forecasting.analysisPolicy?.mode === "monitoring_only"
  ) {
    const lines = [
      `公开模式：仅数据监测；研究状态 ${forecasting.status}；模型 ${forecasting.modelVersion || "不可用"}；数据时间 ${forecasting.asOf || "不可用"}。方向、方向概率、收益目标和交易指令已由服务端删除。〔研究治理｜forecasting.publicMode；forecasting.status；forecasting.asOf〕`,
    ];
    for (const [horizon, forecast] of Object.entries(
      forecasting.horizons || {}
    ))
      lines.push(
        `${horizon}：公开弃权；原因 ${(forecast?.abstainReasons || ["monitoring_only_policy"]).join("、")}；证据覆盖 ${value(forecast?.evidenceCoverage)}；数据新鲜度 ${value(forecast?.dataFreshnessMs)} ms。〔研究治理｜forecasting.horizons.${horizon}.abstained；forecasting.horizons.${horizon}.abstainReasons；forecasting.horizons.${horizon}.dataFreshnessMs〕`
      );
    lines.push(
      `数据集 SHA-256：${forecasting.datasetManifestSha256 || "不可用"}；模型工件 SHA-256：${forecasting.modelArtifactSha256 || "不可用"}。这些标识只用于审计重放，不代表模型已获准预测。〔研究回溯｜forecasting.datasetManifestSha256；forecasting.modelArtifactSha256〕`
    );
    return lines.join("\n\n");
  }
  const lines = [
    `预测系统状态：${forecasting.status}；模型 ${forecasting.modelVersion || "不可用"}；特征版本 ${forecasting.featureSchemaVersion || "不可用"}；数据时间 ${forecasting.asOf || "不可用"}。〔预测系统｜forecasting.status；forecasting.modelVersion；forecasting.featureSchemaVersion；forecasting.asOf〕`,
  ];
  for (const [horizon, forecast] of Object.entries(
    forecasting.horizons || {}
  )) {
    const probabilities = forecast?.probabilities || {};
    const probabilityText = `下跌 ${percentage(probabilities.down)} / 区间 ${percentage(probabilities.range)} / 上涨 ${percentage(probabilities.up)}`;
    if (forecast?.status === "shadow" || forecasting.status === "shadow") {
      lines.push(
        `${horizon}：仅为影子研究，模型已弃权；原因 ${(forecast?.abstainReasons || ["model_shadow"]).join("、")}。方向概率、收益分位数和目标收益不会进入解释模型。〔影子预测｜forecasting.horizons.${horizon}.status；forecasting.horizons.${horizon}.abstainReasons〕`
      );
    } else if (forecast?.abstained !== false || !forecast?.predictedState) {
      lines.push(
        `${horizon}：模型弃权；原因 ${(forecast?.abstainReasons || []).join("、") || "证据不足"}；${probabilityText}。〔校准预测｜forecasting.horizons.${horizon}.abstained；forecasting.horizons.${horizon}.abstainReasons〕`
      );
    } else {
      lines.push(
        `${horizon}：校准状态 ${forecast.predictedState}；${probabilityText}；证据覆盖 ${forecast.evidenceCoverage}。〔校准预测｜forecasting.horizons.${horizon}.predictedState；forecasting.horizons.${horizon}.probabilities；forecasting.horizons.${horizon}.evidenceCoverage〕`
      );
    }
    for (const driver of (forecast?.drivers || []).slice(0, 3)) {
      if (driver.method === "conditional_family_sensitivity_v1")
        lines.push(
          `${horizon} 模型敏感度：${driver.featureFamily} 特征族相对同币种、同市场制度参考状态的类别概率差为 ${value(driver.counterfactualDelta)}（${driver.direction}）。该结果是条件化模型敏感度，不是因果解释。〔预测驱动｜forecasting.horizons.${horizon}.drivers；forecasting.horizons.${horizon}.driverMethod〕`
        );
      else
        lines.push(
          `${horizon} 敏感性：${driver.featurePath} 相对训练中位数 ${value(driver.referenceValue)} 的当前值 ${value(driver.value)}，替换后类别概率差 ${value(driver.counterfactualDelta)}（${driver.direction}）。该项是单特征反事实敏感性，不是因果解释。〔预测驱动｜forecasting.horizons.${horizon}.drivers.${driver.featureIndex}〕`
        );
    }
  }
  lines.push(
    `数据集 SHA-256：${forecasting.datasetManifestSha256 || "不可用"}；模型工件 SHA-256：${forecasting.modelArtifactSha256 || "不可用"}。〔预测回溯｜forecasting.datasetManifestSha256；forecasting.modelArtifactSha256〕`
  );
  return lines.join("\n\n");
}

function monitoringSignalLabel(scenarioId) {
  return (
    {
      bullish_breakout: "上轨突破条件",
      bearish_breakdown: "下轨跌破条件",
      range_continuation: "区间延续条件",
    }[scenarioId] || "市场条件"
  );
}

function renderMonitoringSignal(result, scenario) {
  const verdict = result.supportingEvidence?.scenarioVerdicts?.find(
    ({ scenarioId }) => scenario.id === scenarioId
  );
  const checks = (scenario.confirmationChecks || [])
    .map(
      ({ id, met, actual, threshold }) =>
        `${id}=${met === true ? "满足" : "未满足"}（当前 ${value(actual)}；阈值 ${value(threshold)}）`
    )
    .join("；");
  return [
    `### ${monitoringSignalLabel(scenario.id)}`,
    `当前观测：${scenario.triggerMet === true ? "已触发" : "未触发"}；已收盘数据确认：${scenario.confirmed === true ? "是" : "否"}；旁证：${verdictLabel(verdict?.supportVerdict || "insufficient")}。这是事件状态，不是未来方向判断。〔条件监测｜scenarios.${scenario.id}.triggerMet；scenarios.${scenario.id}.confirmed；supportingEvidence.scenarioVerdicts.${scenario.id}.supportVerdict〕`,
    checks
      ? `核对项：${checks}。〔条件监测｜scenarios.${scenario.id}.confirmationChecks〕`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderMonitoringReport({ result, toolRun = null }) {
  const sourceState =
    result.sourceQuality?.status === "degraded"
      ? `降级；失败来源：${(result.partialFailures || []).map(({ source, exchange, error }) => [source, exchange, error].filter(Boolean).join("/")).join("、") || "支持性来源不完整"}`
      : "完整";
  return [
    `# ${result.symbol}/${result.quote} 公开市场量化监测`,
    "当前模式：仅数据监测。直接方向判断、方向概率、收益或价格目标、交易指令和投资建议均已在服务端关闭。",
    `数据质量：${sourceState}。公式版本：${result.formulaVersion}；证据版本：${result.supportingEvidence?.formulaVersion || "unavailable"}。`,
    "## 多周期已收盘数据",
    ...Object.entries(result.timeframes || {}).map(([id, timeframe]) =>
      renderTimeframe(id, timeframe)
    ),
    "## 现货微观结构",
    renderMicrostructure(result.supportingEvidence?.spotMicrostructure),
    "## 永续合约旁证",
    renderDerivatives(result.supportingEvidence?.derivatives),
    "## 研究治理与回溯",
    renderForecasting(result.forecasting),
    "## 条件状态监测",
    ...(result.scenarios || []).map((scenario) =>
      renderMonitoringSignal(result, scenario)
    ),
    "## 使用边界",
    "趋势、量能、订单流、资金费率、持仓量和爆仓数据仅描述当前及历史状态，不能识别机构身份，也不能单独证明未来反转或延续。斐波那契仅保留为可复算参考位。",
    `runId：${toolRun?.runId || "unavailable"}；完整结果 SHA-256：${toolRun?.resultSha256 || "unavailable"}。内部研究资产继续保留用于审计，但公开报告不包含预测结果。`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderScenario(result, scenario) {
  const verdict = result.supportingEvidence?.scenarioVerdicts?.find(
    ({ scenarioId }) => scenario.id === scenarioId
  );
  const technical =
    scenario.confirmed === true
      ? "技术条件已确认"
      : scenario.triggerMet === true
        ? "触发条件已满足，但尚未确认"
        : "触发条件未满足";
  const support = verdict?.supportVerdict || "insufficient";
  const warning =
    scenario.triggerMet === true && support === "conflicts"
      ? "技术条件已触发，但支持数据冲突，不升级为高确定性趋势。"
      : null;
  const targets = (scenario.targets || [])
    .map(({ value: target, basis }) => `${value(target)}（${basis}）`)
    .join("、");
  return [
    `### ${scenario.id}`,
    `${technical}；旁证结论：${verdictLabel(support)}。〔价格趋势 + 独立旁证｜scenarios.${scenario.id}；supportingEvidence.scenarioVerdicts.${scenario.id}〕`,
    warning,
    targets ? `条件目标位：${targets}。` : null,
    scenario.invalidation
      ? `失效条件：${scenario.invalidation.type} ${value(scenario.invalidation.value ?? scenario.invalidation.lower)}${scenario.invalidation.upper !== undefined ? `–${value(scenario.invalidation.upper)}` : ""}。`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderEvidenceIndex(interpretation, result) {
  const byId = new Map(
    evidenceCatalog(result).map((entry) => [entry.id, entry])
  );
  return interpretation.selectedEvidenceIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map(
      ({ id, family, sourcePath }) =>
        `- \`${id}\` — ${family} — \`${sourcePath}\``
    )
    .join("\n");
}

function renderValidatedReport({
  interpretation,
  result,
  toolRun = null,
  validationStatus = "validated",
  validationErrors = [],
  repairStrategy = null,
}) {
  const sections = [
    `# ${result.symbol}/${result.quote} 多维公开市场分析`,
    `综合状态：${regimeLabel(interpretation.marketState)}。本报告只描述条件情景，不提供未经校准的涨跌概率。`,
    result.sourceQuality?.status === "degraded"
      ? `数据质量：降级。失败来源：${(result.partialFailures || []).map(({ source, exchange, error }) => [source, exchange, error].filter(Boolean).join("/")).join("、") || "支持性来源不完整"}。`
      : "数据质量：完整。",
    "## 多周期价格、量价与趋势结构",
    ...interpretation.timeframeOrder.map((id) =>
      renderTimeframe(id, result.timeframes?.[id])
    ),
    "## 现货微观结构",
    renderMicrostructure(result.supportingEvidence?.spotMicrostructure),
    "## 永续合约旁证",
    renderDerivatives(result.supportingEvidence?.derivatives),
    "## 校准概率预测",
    renderForecasting(result.forecasting),
    "## 条件情景",
    ...interpretation.scenarioOrder
      .map((id) => (result.scenarios || []).find((item) => item.id === id))
      .filter(Boolean)
      .map((scenario) => renderScenario(result, scenario)),
    "## 证据索引",
    renderEvidenceIndex(interpretation, result) ||
      "当前没有足够的可用证据索引。",
    "## 限制与回溯",
    `解释校验：${validationStatus}${repairStrategy ? `；修复方式：${repairStrategy}` : ""}；校验错误码：${serializedValidationErrorCodes(validationErrors)}；公式版本：${result.formulaVersion}；证据版本：${result.supportingEvidence?.formulaVersion || "unavailable"}；解释协议：${INTERPRETATION_SCHEMA}。`,
    `runId：${toolRun?.runId || "unavailable"}；结果 SHA-256：${toolRun?.resultSha256 || "unavailable"}。`,
    `限制：${interpretation.limitationCodes.join("、")}。斐波那契仅为规则化参考位；量能、订单流和衍生品仓位不能识别机构身份，也不能单独证明反转。`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

function emitInterpretationEvent({
  eventType,
  toolRun,
  validationStatus,
  validationErrors = [],
  repairStrategy = null,
  durationMs = 0,
  modelCallCount = 1,
}) {
  emitSemanticEvent({
    eventType,
    category: "agent_tool",
    severity: eventType.endsWith("fallback") ? "warning" : "info",
    outcome: eventType.endsWith("fallback") ? "degraded" : "success",
    subject: {
      type: "tool",
      component: "crypto_market_snapshot",
      operation: "interpret",
    },
    impact: { userEffect: "validated_market_analysis" },
    metadata: {
      runId: toolRun?.runId || null,
      resultSha256: toolRun?.resultSha256 || null,
      validationStatus,
      validationErrorCount: validationErrors.length,
      validationErrorCodes: serializedValidationErrorCodes(validationErrors),
      repairStrategy,
      durationMs: Number(durationMs || 0),
      modelCallCount: String(Number(modelCallCount || 0)),
    },
  });
}

async function validatedCryptoMarketContinuation({
  result,
  toolRun,
  generate,
}) {
  const fullResult = parseJsonObject(result);
  if (!fullResult || fullResult.mode !== "analysis") return { handled: false };
  if (fullResult.analysisPolicy?.mode === "monitoring_only") {
    emitInterpretationEvent({
      eventType: "crypto.analysis.monitoring_report",
      toolRun,
      validationStatus: "monitoring_only",
      validationErrors: [],
      repairStrategy: "deterministic_monitoring_template",
      durationMs: 0,
      modelCallCount: 0,
    });
    return {
      handled: true,
      text: renderMonitoringReport({ result: fullResult, toolRun }),
      validationStatus: "monitoring_only",
      validationErrorCodes: [],
    };
  }
  const prompt = interpretationPrompt(fullResult, toolRun);
  const startedAt = Date.now();
  let raw = null;
  let firstValidation = {
    valid: false,
    errors: ["generation_not_attempted"],
    value: null,
  };
  try {
    raw = await generate([prompt], INTERPRETATION_COMPLETION_OPTIONS);
    firstValidation = validateInterpretation(raw, fullResult);
  } catch (error) {
    firstValidation = {
      valid: false,
      errors: [`generation_failed:${error?.code || error?.name || "unknown"}`],
      value: null,
    };
  }
  if (firstValidation.valid) {
    emitInterpretationEvent({
      eventType: "crypto.analysis.interpretation_validated",
      toolRun,
      validationStatus: "validated",
      validationErrors: [],
      durationMs: Date.now() - startedAt,
      modelCallCount: 1,
    });
    return {
      handled: true,
      text: renderValidatedReport({
        interpretation: firstValidation.value,
        result: fullResult,
        toolRun,
        validationStatus: "validated",
        validationErrors: [],
      }),
      validationStatus: "validated",
      validationErrorCodes: [],
    };
  }

  const repaired = firstValidation.value
    ? repairInterpretationDeterministically(firstValidation.value, fullResult)
    : null;
  const repairValidation = repaired
    ? validateInterpretation(repaired, fullResult)
    : {
        valid: false,
        errors: ["deterministic_repair_unavailable"],
        value: null,
      };
  if (repairValidation.valid) {
    emitInterpretationEvent({
      eventType: "crypto.analysis.interpretation_repaired",
      toolRun,
      validationStatus: "repaired",
      validationErrors: firstValidation.errors,
      repairStrategy: "deterministic_patch",
      durationMs: Date.now() - startedAt,
      modelCallCount: 1,
    });
    return {
      handled: true,
      text: renderValidatedReport({
        interpretation: repairValidation.value,
        result: fullResult,
        toolRun,
        validationStatus: "repaired",
        validationErrors: firstValidation.errors,
        repairStrategy: "deterministic_patch",
      }),
      validationStatus: "repaired",
      validationErrorCodes: validationErrorCodes(firstValidation.errors),
    };
  }

  const fallback = fallbackInterpretation(fullResult);
  const fallbackErrors = [
    ...firstValidation.errors,
    ...repairValidation.errors,
  ];
  emitInterpretationEvent({
    eventType: "crypto.analysis.interpretation_fallback",
    toolRun,
    validationStatus: "fallback",
    validationErrors: fallbackErrors,
    repairStrategy: "deterministic_fallback",
    durationMs: Date.now() - startedAt,
    modelCallCount: 1,
  });
  return {
    handled: true,
    text: renderValidatedReport({
      interpretation: fallback,
      result: fullResult,
      toolRun,
      validationStatus: "deterministic_fallback",
      validationErrors: fallbackErrors,
      repairStrategy: "deterministic_fallback",
    }),
    validationStatus: "fallback",
    validationErrorCodes: validationErrorCodes(fallbackErrors),
  };
}

module.exports = {
  INTERPRETATION_SCHEMA,
  INTERPRETATION_COMPLETION_OPTIONS,
  MAX_SELECTED_EVIDENCE,
  _internals: {
    evidenceCatalog,
    compactEvidenceCatalogForModel,
    fallbackInterpretation,
    parseJsonObject,
    repairInterpretationDeterministically,
    requiredLimitations,
    serializedValidationErrorCodes,
    validationErrorCodes,
  },
  interpretationPrompt,
  renderMonitoringReport,
  renderValidatedReport,
  validateInterpretation,
  validatedCryptoMarketContinuation,
};
