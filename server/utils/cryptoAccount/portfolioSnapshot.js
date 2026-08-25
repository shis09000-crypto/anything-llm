const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const {
  GATE_UNDERLYING_ASSET_ALIASES,
  underlyingAssetSymbol,
} = require("../cryptoAssetIdentity");

const CryptoData = lazyDataAccessFacade("crypto");

const STABLE_ASSETS = new Set(["USDT", "USDC", "GUSD", "DAI"]);
const ASSET_COLORS = Object.freeze({
  BTC: "#1683FF",
  ETH: "#A855F7",
  USDT: "#FF8A00",
  USDC: "#2775CA",
  GUSD: "#14C8B8",
  OTHER: "#6B7280",
});

const RISK_THRESHOLDS = Object.freeze({
  assetConcentration: { watch: 50, danger: 70 },
  marginPressure: { watch: 50, danger: 80 },
  liquidationDistance: { watch: 20, danger: 10 },
  drawdown: { watch: 5, danger: 10 },
  staleAgeMs: { watch: 30_000, danger: 120_000 },
});

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimal(value, digits = 2) {
  return finiteNumber(value).toFixed(digits);
}

function normalizedSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function portfolioSymbol(value) {
  return underlyingAssetSymbol(value);
}

function mergeHoldingSources(current = [], incoming = []) {
  return [...new Set([...current, ...incoming].filter(Boolean))];
}

function riskLevelFromHigh(value, thresholds) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value >= thresholds.danger) return "danger";
  if (value >= thresholds.watch) return "watch";
  return "safe";
}

function riskLevelFromLow(value, thresholds) {
  if (!Number.isFinite(value)) return "unavailable";
  if (value <= thresholds.danger) return "danger";
  if (value <= thresholds.watch) return "watch";
  return "safe";
}

function severityRank(level) {
  return { unavailable: -1, safe: 0, watch: 1, danger: 2 }[level] ?? -1;
}

function highestRisk(levels = []) {
  return levels.reduce(
    (highest, level) =>
      severityRank(level) > severityRank(highest) ? level : highest,
    "safe"
  );
}

function maxDrawdownMetrics(points = []) {
  let peak = null;
  let maxDrawdownPct = 0;
  let currentDrawdownPct = 0;
  for (const point of points) {
    const value = finiteNumber(
      point?.totalEquityUsd ?? point?.value ?? point?.equityUsd,
      NaN
    );
    if (!Number.isFinite(value) || value <= 0) continue;
    peak = peak === null ? value : Math.max(peak, value);
    const drawdown = peak > 0 ? ((peak - value) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
    currentDrawdownPct = drawdown;
  }
  return {
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
    currentDrawdownPct: Number(currentDrawdownPct.toFixed(4)),
  };
}

class SupplementalPortfolioService {
  constructor({ connection }) {
    this.connection = connection;
  }

  async activeHoldings() {
    const rows = await CryptoData.listSupplementalHoldings({
      where: {
        connectionId: String(this.connection.id),
        authUserId: Number(this.connection.authUserId),
        status: "active",
      },
      orderBy: { symbol: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      symbol: normalizedSymbol(row.symbol),
      quantity: decimal(row.quantity, 12),
      costBasisUsd: decimal(row.costBasisUsd, 2),
      source: row.source,
      effectiveAt: row.effectiveAt,
    }));
  }
}

function priceForSymbol(symbol, gateItem, priceBySymbol = {}) {
  if (STABLE_ASSETS.has(symbol)) return 1;
  const explicit = finiteNumber(priceBySymbol[symbol], NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromGate = finiteNumber(gateItem?.priceUsd, NaN);
  return Number.isFinite(fromGate) && fromGate > 0 ? fromGate : null;
}

function mergePortfolio({
  gateTotalUsd,
  gateAllocation = {},
  supplementalHoldings = [],
  priceBySymbol = {},
  asOf = Date.now(),
}) {
  const gateItems = Array.isArray(gateAllocation?.items)
    ? gateAllocation.items
    : [];
  const rows = new Map();

  for (const item of gateItems) {
    const reportedSymbol = normalizedSymbol(item.symbol);
    const symbol = portfolioSymbol(reportedSymbol);
    if (!symbol) continue;
    const valueUsd = finiteNumber(item.valueUsd);
    const quantity = finiteNumber(item.totalAmount ?? item.amount);
    const current = rows.get(symbol);
    const holdingSources = mergeHoldingSources(
      current?.gateHoldingSources,
      [
        ...(item.holdingSources || []),
        ...(reportedSymbol !== symbol ? [`underlying:${reportedSymbol}`] : []),
      ]
    );
    if (current) {
      const gateQuantity = current.gateQuantity + quantity;
      const gateValueUsd = current.gateValueUsd + valueUsd;
      rows.set(symbol, {
        ...current,
        priceUsd:
          current.priceUsd || priceForSymbol(symbol, item, priceBySymbol),
        gateQuantity,
        totalQuantity: gateQuantity + current.supplementalQuantity,
        gateValueUsd,
        totalValueUsd: gateValueUsd + current.supplementalValueUsd,
        source: current.supplementalQuantity > 0 ? "mixed" : "gate",
        gateHoldingSources: holdingSources,
      });
      continue;
    }
    rows.set(symbol, {
      symbol,
      name: reportedSymbol === symbol ? item.name || symbol : symbol,
      nameCn: reportedSymbol === symbol ? item.nameCn || symbol : symbol,
      color: ASSET_COLORS[symbol] || item.color || "#9CA3AF",
      priceUsd: priceForSymbol(symbol, item, priceBySymbol),
      gateQuantity: quantity,
      supplementalQuantity: 0,
      totalQuantity: quantity,
      gateValueUsd: valueUsd,
      supplementalValueUsd: 0,
      totalValueUsd: valueUsd,
      supplementalCostBasisUsd: 0,
      source: "gate",
      gateHoldingSources: holdingSources,
    });
  }

  const unpricedSupplemental = [];
  let supplementalCostBasisUsd = 0;
  for (const holding of supplementalHoldings) {
    const symbol = portfolioSymbol(holding.symbol);
    if (!symbol) continue;
    const quantity = finiteNumber(holding.quantity);
    const costBasisUsd = finiteNumber(holding.costBasisUsd);
    supplementalCostBasisUsd += costBasisUsd;
    const current = rows.get(symbol) || {
      symbol,
      name: STABLE_ASSETS.has(symbol) ? "USD Stablecoin" : symbol,
      nameCn: symbol,
      color: ASSET_COLORS[symbol] || "#9CA3AF",
      priceUsd: null,
      gateQuantity: 0,
      supplementalQuantity: 0,
      totalQuantity: 0,
      gateValueUsd: 0,
      supplementalValueUsd: 0,
      totalValueUsd: 0,
      supplementalCostBasisUsd: 0,
      source: "supplemental",
      gateHoldingSources: [],
    };
    const priceUsd = priceForSymbol(symbol, current, priceBySymbol);
    if (!priceUsd) {
      unpricedSupplemental.push(symbol);
      rows.set(symbol, {
        ...current,
        supplementalQuantity: current.supplementalQuantity + quantity,
        totalQuantity: current.totalQuantity + quantity,
        supplementalCostBasisUsd:
          current.supplementalCostBasisUsd + costBasisUsd,
        source: current.gateQuantity > 0 ? "mixed" : "supplemental",
      });
      continue;
    }
    const valueUsd = quantity * priceUsd;
    rows.set(symbol, {
      ...current,
      priceUsd,
      supplementalQuantity: current.supplementalQuantity + quantity,
      totalQuantity: current.totalQuantity + quantity,
      supplementalValueUsd: current.supplementalValueUsd + valueUsd,
      totalValueUsd: current.totalValueUsd + valueUsd,
      supplementalCostBasisUsd: current.supplementalCostBasisUsd + costBasisUsd,
      source: current.gateQuantity > 0 ? "mixed" : "supplemental",
    });
  }

  const authoritativeGateTotal = finiteNumber(
    gateTotalUsd,
    finiteNumber(gateAllocation?.totalValueUsd)
  );
  const reportedAllocatedGateTotal = [...rows.values()].reduce(
    (sum, item) => sum + item.gateValueUsd,
    0
  );
  const reconciliationUsd = authoritativeGateTotal - reportedAllocatedGateTotal;
  const gateNormalizationFactor =
    reportedAllocatedGateTotal > 0 && reconciliationUsd < 0
      ? authoritativeGateTotal / reportedAllocatedGateTotal
      : 1;
  if (gateNormalizationFactor < 1) {
    for (const [symbol, item] of rows.entries()) {
      const normalizedGateValue = item.gateValueUsd * gateNormalizationFactor;
      rows.set(symbol, {
        ...item,
        gateValueUsd: normalizedGateValue,
        totalValueUsd: normalizedGateValue + item.supplementalValueUsd,
      });
    }
  } else if (reconciliationUsd >= 0.01) {
    rows.set("OTHER", {
      symbol: "OTHER",
      name: "Other Gate accounts",
      nameCn: "Gate 其他账户",
      color: ASSET_COLORS.OTHER,
      priceUsd: null,
      gateQuantity: 0,
      supplementalQuantity: 0,
      totalQuantity: 0,
      gateValueUsd: reconciliationUsd,
      supplementalValueUsd: 0,
      totalValueUsd: reconciliationUsd,
      supplementalCostBasisUsd: 0,
      source: "gate_reconciliation",
      gateHoldingSources: ["account_reconciliation"],
    });
  }

  const supplementalValueUsd = [...rows.values()].reduce(
    (sum, item) => sum + item.supplementalValueUsd,
    0
  );
  const totalValueUsd = authoritativeGateTotal + supplementalValueUsd;
  const items = [...rows.values()]
    .map((item) => ({
      symbol: item.symbol,
      name: item.name,
      nameCn: item.nameCn,
      color: item.color,
      amount: decimal(item.totalQuantity, 8),
      totalAmount: decimal(item.totalQuantity, 12),
      valueUsd: decimal(item.totalValueUsd, 2),
      percentage:
        totalValueUsd > 0
          ? decimal((item.totalValueUsd / totalValueUsd) * 100, 2)
          : "0.00",
      priceUsd: item.priceUsd ? decimal(item.priceUsd, 8) : null,
      source: item.source,
      gate: {
        quantity: decimal(item.gateQuantity, 12),
        valueUsd: decimal(item.gateValueUsd, 2),
        holdingSources: item.gateHoldingSources,
      },
      supplemental: {
        quantity: decimal(item.supplementalQuantity, 12),
        valueUsd: decimal(item.supplementalValueUsd, 2),
        costBasisUsd: decimal(item.supplementalCostBasisUsd, 2),
      },
    }))
    .sort(
      (left, right) =>
        finiteNumber(right.valueUsd) - finiteNumber(left.valueUsd)
    );

  let invariantTotal = items.reduce(
    (sum, item) => sum + finiteNumber(item.valueUsd),
    0
  );
  let invariantDeltaUsd = invariantTotal - totalValueUsd;
  if (items.length && Math.abs(invariantDeltaUsd) >= 0.005) {
    const otherIndex = items.findIndex((item) => item.symbol === "OTHER");
    const adjustmentIndex = otherIndex >= 0 ? otherIndex : 0;
    const adjustment = items[adjustmentIndex];
    const correctedValue =
      finiteNumber(adjustment.valueUsd) - invariantDeltaUsd;
    items[adjustmentIndex] = {
      ...adjustment,
      valueUsd: decimal(correctedValue, 2),
      percentage:
        totalValueUsd > 0
          ? decimal((correctedValue / totalValueUsd) * 100, 2)
          : "0.00",
    };
    invariantTotal = items.reduce(
      (sum, item) => sum + finiteNumber(item.valueUsd),
      0
    );
    invariantDeltaUsd = invariantTotal - totalValueUsd;
  }

  return {
    asOf,
    quoteAsset: "USD",
    gate: {
      totalValueUsd: decimal(authoritativeGateTotal, 2),
      allocatedValueUsd: decimal(
        reportedAllocatedGateTotal * gateNormalizationFactor,
        2
      ),
      reportedAllocatedValueUsd: decimal(reportedAllocatedGateTotal, 2),
      reconciliationUsd: decimal(reconciliationUsd, 2),
      normalizationApplied: gateNormalizationFactor < 1,
      authority: "gate_read_only",
    },
    supplemental: {
      totalValueUsd: decimal(supplementalValueUsd, 2),
      costBasisUsd: decimal(supplementalCostBasisUsd, 2),
      authority: "user_supplied_portfolio_layer",
      includedInGateHistory: false,
      unpricedSymbols: [...new Set(unpricedSupplemental)],
    },
    totalValueUsd: decimal(totalValueUsd, 2),
    items,
    invariant: {
      itemTotalUsd: decimal(invariantTotal, 2),
      expectedTotalUsd: decimal(totalValueUsd, 2),
      deltaUsd: decimal(invariantDeltaUsd, 2),
      valid: Math.abs(invariantDeltaUsd) < 0.005,
    },
    connectionStatus: unpricedSupplemental.length ? "degraded" : "connected",
  };
}

function mergeSpotDetail({ detail = {}, portfolio, symbol }) {
  const normalized = portfolioSymbol(symbol);
  const item = portfolio?.items?.find(
    (candidate) => candidate.symbol === normalized
  );
  if (!item) return detail;
  const gateQuantity = finiteNumber(item.gate?.quantity);
  const totalQuantity = finiteNumber(item.totalAmount);
  const gateAverage = finiteNumber(detail.averageBuyPriceQuote, NaN);
  const gateCost = Number.isFinite(gateAverage)
    ? gateQuantity * gateAverage
    : null;
  const supplementalCost = finiteNumber(item.supplemental?.costBasisUsd);
  const combinedCost =
    gateCost === null ? supplementalCost : gateCost + supplementalCost;
  const combinedAverage =
    gateCost === null && gateQuantity > 0
      ? null
      : totalQuantity > 0 && combinedCost > 0
        ? combinedCost / totalQuantity
        : null;
  return {
    ...detail,
    holdingAmountBase: decimal(totalQuantity, 8),
    holdingValueQuote: item.valueUsd,
    holdingValueUsd: item.valueUsd,
    averageBuyPriceQuote: combinedAverage ? decimal(combinedAverage, 2) : null,
    averageBuyPriceMethod:
      gateCost === null && gateQuantity > 0
        ? "supplemental_only_gate_cost_unavailable"
        : "gate_plus_supplemental_weighted",
    averageBuyPriceScope:
      gateCost === null && gateQuantity > 0 ? "partial" : "combined",
    portfolioSources: {
      gateQuantity: item.gate.quantity,
      supplementalQuantity: item.supplemental.quantity,
      supplementalCostBasisUsd: item.supplemental.costBasisUsd,
    },
  };
}

function computePortfolioRisk({
  portfolio,
  positions = {},
  equityHistory = {},
  connectionStatus = "connected",
  now = Date.now(),
}) {
  const positiveItems = (portfolio?.items || []).filter(
    (item) => finiteNumber(item.valueUsd) > 0 && item.symbol !== "OTHER"
  );
  const largest = positiveItems.reduce(
    (current, item) =>
      finiteNumber(item.percentage) > finiteNumber(current?.percentage)
        ? item
        : current,
    null
  );
  const largestAssetPct = finiteNumber(largest?.percentage, NaN);
  const stablecoinPct = positiveItems
    .filter((item) => STABLE_ASSETS.has(item.symbol))
    .reduce((sum, item) => sum + finiteNumber(item.percentage), 0);
  const summary = positions?.summary || {};
  const portfolioValueUsd = finiteNumber(portfolio?.totalValueUsd);
  const futuresNotionalUsd = finiteNumber(summary.totalNotionalUsd);
  const marginPressurePct = finiteNumber(
    summary.initialMarginToCrossAvailablePct ?? summary.marginRatioPct,
    NaN
  );
  const liquidationDistances = (positions?.positions || [])
    .map((position) => finiteNumber(position.liquidationDistancePct, NaN))
    .filter(Number.isFinite);
  const minLiquidationDistancePct = liquidationDistances.length
    ? Math.min(...liquidationDistances)
    : null;
  const history = equityHistory?.history || equityHistory || {};
  const drawdown = maxDrawdownMetrics(history.points || []);
  const latestSnapshotAt = finiteNumber(
    history.freshness?.latestSnapshotAt ?? portfolio?.asOf,
    now
  );
  const dataAgeMs = Math.max(0, now - latestSnapshotAt);

  const levels = {
    assetConcentration: riskLevelFromHigh(
      largestAssetPct,
      RISK_THRESHOLDS.assetConcentration
    ),
    stablecoinConcentration: riskLevelFromHigh(
      stablecoinPct,
      RISK_THRESHOLDS.assetConcentration
    ),
    marginPressure: riskLevelFromHigh(
      marginPressurePct,
      RISK_THRESHOLDS.marginPressure
    ),
    liquidationDistance:
      minLiquidationDistancePct === null
        ? "unavailable"
        : riskLevelFromLow(
            minLiquidationDistancePct,
            RISK_THRESHOLDS.liquidationDistance
          ),
    drawdown: riskLevelFromHigh(
      drawdown.maxDrawdownPct,
      RISK_THRESHOLDS.drawdown
    ),
    freshness:
      connectionStatus === "disconnected"
        ? "danger"
        : riskLevelFromHigh(dataAgeMs, RISK_THRESHOLDS.staleAgeMs),
  };
  const level = highestRisk(Object.values(levels));
  const alerts = [];
  const addAlert = (rule, riskLevel, title, message, evidence) => {
    if (!["watch", "danger"].includes(riskLevel)) return;
    alerts.push({
      id: `${rule}:${evidence?.symbol || "portfolio"}`,
      rule,
      severity: riskLevel === "danger" ? "critical" : "warning",
      title,
      message,
      evidence,
    });
  };
  addAlert(
    "asset_concentration",
    levels.assetConcentration,
    "资产集中度偏高",
    largest
      ? `${largest.symbol} 占当前组合 ${decimal(largestAssetPct, 2)}%。`
      : "暂无可用资产分布。",
    { symbol: largest?.symbol || null, percentage: largestAssetPct }
  );
  addAlert(
    "stablecoin_concentration",
    levels.stablecoinConcentration,
    "稳定币集中度偏高",
    `稳定币合计占当前组合 ${decimal(stablecoinPct, 2)}%。`,
    { percentage: stablecoinPct }
  );
  addAlert(
    "margin_pressure",
    levels.marginPressure,
    "保证金压力升高",
    `Gate 账户初始保证金/可用余额为 ${decimal(marginPressurePct, 2)}%。`,
    { percentage: marginPressurePct, semantics: summary.marginRatioSemantics }
  );
  addAlert(
    "liquidation_distance",
    levels.liquidationDistance,
    "强平参考距离接近",
    `最近的 Gate 强平参考距离为 ${decimal(minLiquidationDistancePct, 2)}%；交叉保证金下该值不代表账户安全程度。`,
    { percentage: minLiquidationDistancePct, referenceOnly: true }
  );
  addAlert(
    "drawdown",
    levels.drawdown,
    "当期回撤扩大",
    `当前窗口最大回撤为 ${decimal(drawdown.maxDrawdownPct, 2)}%。`,
    { percentage: drawdown.maxDrawdownPct }
  );
  addAlert(
    "data_freshness",
    levels.freshness,
    connectionStatus === "disconnected" ? "账户连接中断" : "资产数据已过期",
    connectionStatus === "disconnected"
      ? "Gate 只读连接当前不可用。"
      : `最近可信快照距今 ${Math.round(dataAgeMs / 1000)} 秒。`,
    { ageMs: dataAgeMs, connectionStatus }
  );

  return {
    asOf: now,
    level,
    score: { safe: 15, watch: 55, danger: 85 }[level] || 0,
    thresholds: RISK_THRESHOLDS,
    metrics: {
      largestAsset: largest?.symbol || null,
      largestAssetPct: Number.isFinite(largestAssetPct)
        ? Number(largestAssetPct.toFixed(4))
        : null,
      stablecoinPct: Number(stablecoinPct.toFixed(4)),
      portfolioValueUsd: Number(portfolioValueUsd.toFixed(2)),
      futuresNotionalUsd: Number(futuresNotionalUsd.toFixed(2)),
      futuresToPortfolioPct:
        portfolioValueUsd > 0
          ? Number(((futuresNotionalUsd / portfolioValueUsd) * 100).toFixed(4))
          : null,
      accountInitialMarginUsd: finiteNumber(summary.accountInitialMarginUsd),
      accountMaintenanceMarginUsd: finiteNumber(
        summary.accountMaintenanceMarginUsd
      ),
      crossAvailableUsd: finiteNumber(summary.crossAvailableUsd),
      marginPressurePct: Number.isFinite(marginPressurePct)
        ? Number(marginPressurePct.toFixed(4))
        : null,
      minLiquidationDistancePct,
      liquidationReferenceOnly: true,
      ...drawdown,
      dataAgeMs,
    },
    breakdown: levels,
    alerts,
    guidance: {
      crossMargin:
        "Configured leverage and position liquidation prices are reference-only under shared cross margin; use Gate account-level margin fields.",
      modelGenerated: false,
      readOnly: true,
    },
  };
}

function simulateRebalance({ portfolio, targets = {} }) {
  const normalizedTargets = Object.fromEntries(
    Object.entries(targets).map(([symbol, pct]) => [
      portfolioSymbol(symbol),
      finiteNumber(pct, NaN),
    ])
  );
  const values = Object.values(normalizedTargets);
  if (
    !values.length ||
    values.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 100
    ) ||
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) > 0.01
  ) {
    const error = new Error("crypto_rebalance_targets_invalid");
    error.code = "crypto_rebalance_targets_invalid";
    throw error;
  }
  const totalValueUsd = finiteNumber(portfolio?.totalValueUsd);
  const currentBySymbol = new Map(
    (portfolio?.items || []).map((item) => [
      item.symbol,
      finiteNumber(item.valueUsd),
    ])
  );
  const items = Object.entries(normalizedTargets).map(([symbol, targetPct]) => {
    const currentValueUsd = currentBySymbol.get(symbol) || 0;
    const targetValueUsd = (totalValueUsd * targetPct) / 100;
    const currentPct =
      totalValueUsd > 0 ? (currentValueUsd / totalValueUsd) * 100 : 0;
    const action =
      targetValueUsd > currentValueUsd
        ? "increase"
        : targetValueUsd < currentValueUsd
          ? "decrease"
          : "hold";
    return {
      symbol,
      currentPct: Number(currentPct.toFixed(4)),
      targetPct: Number(targetPct.toFixed(4)),
      currentValueUsd: Number(currentValueUsd.toFixed(2)),
      targetValueUsd: Number(targetValueUsd.toFixed(2)),
      deltaUsd: Number((targetValueUsd - currentValueUsd).toFixed(2)),
      action,
      direction: action,
    };
  });
  return {
    success: true,
    asOf: Date.now(),
    readOnly: true,
    executable: false,
    totalValueUsd: Number(totalValueUsd.toFixed(2)),
    items,
  };
}

module.exports = {
  PORTFOLIO_UNDERLYING_ALIASES: GATE_UNDERLYING_ASSET_ALIASES,
  RISK_THRESHOLDS,
  SupplementalPortfolioService,
  computePortfolioRisk,
  maxDrawdownMetrics,
  mergePortfolio,
  mergeSpotDetail,
  simulateRebalance,
};
