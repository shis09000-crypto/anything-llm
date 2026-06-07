const EXCHANGES = ["gate", "binance", "okx", "bybit", "bitget", "other"];
const ASSETS = ["BTC", "ETH", "SOL", "USDT", "USDC", "LTC", "XRP", "OTHER"];

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function pct(value, total) {
  if (!total) return 0;
  return round((value / total) * 100, 2);
}

function trend(count = 18, base = 100, variance = 4) {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const drift = Math.sin(index / 2.7) * variance;
    const pulse = Math.cos(index / 4.4) * (variance / 2);
    return {
      ts: now - (count - index - 1) * 60 * 60 * 1000,
      value: round(base + drift + pulse, 2),
    };
  });
}

function makeKpis(totalEquity) {
  const netProfit = 18342.8;
  const realized = 9364.12;
  const unrealized = 8978.68;
  const fees = -812.43;
  const funding = 128.6;
  const earn = 442.38;
  const risk = 62;
  const connected = 4;

  return [
    {
      key: "total_equity",
      label: "Total Equity",
      value: totalEquity,
      unit: "usd",
      delta24h: 2.84,
      tone: "positive",
      trend: trend(24, totalEquity, 4200),
    },
    {
      key: "net_profit_today",
      label: "Net Profit Today",
      value: netProfit,
      unit: "usd",
      delta24h: 1.9,
      tone: "positive",
      trend: trend(24, netProfit, 900),
    },
    {
      key: "realized_pnl_today",
      label: "Realized PnL",
      value: realized,
      unit: "usd",
      delta24h: 0.74,
      tone: "positive",
      trend: trend(24, realized, 620),
    },
    {
      key: "unrealized_pnl_today",
      label: "Unrealized PnL",
      value: unrealized,
      unit: "usd",
      delta24h: -0.34,
      tone: "negative",
      trend: trend(24, unrealized, 780),
    },
    {
      key: "fees_today",
      label: "Fees Today",
      value: fees,
      unit: "usd",
      delta24h: -0.12,
      tone: "negative",
      trend: trend(24, Math.abs(fees), 80),
    },
    {
      key: "funding_today",
      label: "Funding Today",
      value: funding,
      unit: "usd",
      delta24h: 0.04,
      tone: "positive",
      trend: trend(24, funding, 36),
    },
    {
      key: "earn_income_today",
      label: "Earn Income",
      value: earn,
      unit: "usd",
      delta24h: 0.16,
      tone: "positive",
      trend: trend(24, earn, 22),
    },
    {
      key: "risk_index",
      label: "Risk Index",
      value: risk,
      unit: "score",
      delta24h: 3,
      tone: "risk",
      trend: trend(24, risk, 8),
    },
    {
      key: "exchange_connectivity",
      label: "Exchange Online",
      value: connected,
      unit: "count",
      delta24h: 0,
      tone: "neutral",
      trend: trend(24, connected, 0.35),
    },
  ];
}

function makeAssets() {
  const rows = [
    ["BTC", 14.72, 964320],
    ["ETH", 185.4, 602918],
    ["SOL", 4068, 381250],
    ["USDT", 1, 292600],
    ["USDC", 1, 176420],
    ["LTC", 1282, 107812],
    ["XRP", 70240, 88934],
    ["OTHER", 1, 138446],
  ];
  const total = rows.reduce((sum, row) => sum + row[2], 0);
  return rows.map(([symbol, amount, equityUsd]) => ({
    symbol,
    amount,
    equityUsd,
    pct: pct(equityUsd, total),
  }));
}

function makeExchanges(totalEquity) {
  const rows = [
    ["gate", 915240, 11322.4, "connected", 42],
    ["binance", 734218, 5208.8, "connected", 56],
    ["okx", 384820, -1792.7, "degraded", 148],
    ["bybit", 291530, 3250.2, "connected", 71],
    ["bitget", 186724, 892.4, "connected", 88],
    ["other", 67210, -112.6, "disconnected", null],
  ];
  return rows.map(([exchange, total, todayChangeUsd, status, latencyMs]) => ({
    exchange,
    totalEquityUsd: total,
    pct: pct(total, totalEquity),
    todayChangeUsd,
    status,
    latencyMs,
  }));
}

function makeAccounts(totalEquity) {
  const rows = [
    ["spot", "Spot Account", "spot", "gate", 965120, "safe"],
    ["futures", "Futures Account", "futures", "gate", 612540, "watch"],
    ["earn", "Earn Account", "earn", "binance", 348900, "safe"],
    ["funding", "Funding Account", "funding", "okx", 280650, "safe"],
    ["finance", "Finance Account", "finance", "bybit", 171920, "watch"],
    ["bitget-futures", "Bitget Futures", "futures", "bitget", 114880, "danger"],
  ];
  return rows.map(([id, name, type, exchange, equityUsd, riskLevel]) => ({
    id,
    name,
    type,
    exchange,
    equityUsd,
    pct: pct(equityUsd, totalEquity),
    riskLevel,
  }));
}

function makeEquity(range = "24h", totalEquity = 0) {
  const pointsByRange = {
    "24h": 48,
    "7d": 56,
    "30d": 60,
    "90d": 90,
    "365d": 120,
  };
  const count = pointsByRange[range] || 48;
  const step = range === "24h" ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const now = Date.now();
  let peak = totalEquity * 0.96;
  return Array.from({ length: count }, (_, index) => {
    const progression = index / Math.max(1, count - 1);
    const value =
      totalEquity * (0.91 + progression * 0.09) +
      Math.sin(index / 4) * 21000 +
      Math.cos(index / 7) * 12600;
    peak = Math.max(peak, value);
    return {
      ts: now - (count - index - 1) * step,
      totalEquityUsd: round(value, 2),
      nav: round(value / totalEquity, 4),
      drawdownPct: round(((value - peak) / peak) * 100, 2),
    };
  });
}

function makePnl() {
  const now = Date.now();
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now - (29 - index) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const realizedUsd = Math.sin(index / 2) * 5200 + 2400;
    const unrealizedUsd = Math.cos(index / 3) * 4600 + 1400;
    return {
      date,
      realizedUsd: round(realizedUsd, 2),
      unrealizedUsd: round(unrealizedUsd, 2),
      totalUsd: round(realizedUsd + unrealizedUsd, 2),
    };
  });
}

function makePositions() {
  return [
    [
      "pos-btc",
      "gate",
      "BTC/USDT",
      "long",
      6.4,
      3,
      64120,
      65584,
      52840,
      9369.6,
      0.41,
      "safe",
    ],
    [
      "pos-eth",
      "binance",
      "ETH/USDT",
      "long",
      92.1,
      4,
      3180,
      3252,
      2675,
      6631.2,
      0.36,
      "safe",
    ],
    [
      "pos-sol",
      "okx",
      "SOL/USDT",
      "long",
      2680,
      5,
      148.2,
      142.6,
      118.4,
      -15008,
      0.24,
      "watch",
    ],
    [
      "pos-xrp",
      "bitget",
      "XRP/USDT",
      "short",
      48200,
      8,
      1.32,
      1.38,
      1.51,
      -2892,
      0.16,
      "danger",
    ],
    [
      "pos-ltc",
      "bybit",
      "LTC/USDT",
      "net",
      730,
      2,
      82.4,
      84.9,
      64.1,
      1825,
      0.47,
      "safe",
    ],
  ].map(
    ([
      id,
      exchange,
      symbol,
      side,
      quantity,
      leverage,
      entryPrice,
      markPrice,
      liquidationPrice,
      unrealizedPnlUsd,
      marginRatio,
      riskLevel,
    ]) => ({
      id,
      exchange,
      symbol,
      side,
      quantity,
      leverage,
      entryPrice,
      markPrice,
      liquidationPrice,
      unrealizedPnlUsd,
      marginRatio,
      riskLevel,
    })
  );
}

function makeTrades() {
  const now = Date.now();
  const symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "LTC/USDT"];
  return Array.from({ length: 16 }, (_, index) => ({
    id: `fill-${index}`,
    ts: now - index * 8 * 60 * 1000,
    exchange: EXCHANGES[index % 5],
    symbol: symbols[index % symbols.length],
    side: index % 3 === 0 ? "sell" : "buy",
    quantity: round(0.28 + index * 0.17, 4),
    price: round(64000 - index * 860 + Math.sin(index) * 420, 2),
    feeUsd: round(8 + index * 1.74, 2),
  }));
}

function makeRisk(score = 62) {
  return {
    score,
    leverageScore: 58,
    marginScore: 66,
    assetConcentrationScore: 72,
    accountConcentrationScore: 48,
    liquidityScore: 55,
    level: score >= 70 ? "danger" : score >= 40 ? "watch" : "safe",
  };
}

function cryptoCenterSnapshot(range = "24h") {
  const assets = makeAssets();
  const totalEquity = round(
    assets.reduce((sum, asset) => sum + asset.equityUsd, 0),
    2
  );
  return {
    asOf: Date.now(),
    kpis: makeKpis(totalEquity),
    assets,
    exchanges: makeExchanges(totalEquity),
    accounts: makeAccounts(totalEquity),
    equity: makeEquity(range, totalEquity),
    pnl: makePnl(),
    positions: makePositions(),
    orders: [
      { type: "limit", count: 36, notionalUsd: 284920 },
      { type: "market", count: 4, notionalUsd: 42820 },
      { type: "conditional", count: 14, notionalUsd: 148640 },
      { type: "take_profit_stop_loss", count: 21, notionalUsd: 213580 },
    ],
    trades: makeTrades(),
    earn: [
      {
        id: "earn-flex",
        category: "flexible",
        asset: "USDT",
        amountUsd: 158000,
        aprPct: 5.4,
        accruedUsd: 2840,
        todayIncomeUsd: 23.4,
      },
      {
        id: "earn-fixed",
        category: "fixed",
        asset: "ETH",
        amountUsd: 96200,
        aprPct: 4.1,
        accruedUsd: 1190,
        todayIncomeUsd: 10.8,
      },
      {
        id: "earn-staking",
        category: "staking",
        asset: "SOL",
        amountUsd: 74200,
        aprPct: 7.6,
        accruedUsd: 1698,
        todayIncomeUsd: 15.2,
      },
      {
        id: "earn-launchpool",
        category: "launchpool",
        asset: "BNB",
        amountUsd: 46400,
        aprPct: 12.8,
        accruedUsd: 940,
        todayIncomeUsd: 18.9,
      },
    ],
    risk: makeRisk(62),
    alerts: [
      {
        id: "alert-ws-okx",
        ts: Date.now() - 18 * 60 * 1000,
        type: "ws_disconnected",
        severity: "warning",
        title: "OKX WebSocket degraded",
        message: "Private order stream latency is above 140ms.",
        read: false,
        sound: true,
      },
      {
        id: "alert-margin-xrp",
        ts: Date.now() - 36 * 60 * 1000,
        type: "low_margin_ratio",
        severity: "critical",
        title: "Margin ratio below threshold",
        message: "XRP/USDT short position margin ratio is near danger zone.",
        read: false,
        sound: true,
      },
      {
        id: "alert-flow",
        ts: Date.now() - 2 * 60 * 60 * 1000,
        type: "abnormal_flow",
        severity: "info",
        title: "Unusual transfer route",
        message: "Funding to futures transfer is 38% above baseline.",
        read: true,
        sound: false,
      },
    ],
  };
}

function cryptoCenterDelta(snapshot, tick = 0) {
  const now = Date.now();
  const riskScore = 56 + Math.round(Math.abs(Math.sin(tick / 4)) * 22);
  const trade = {
    id: `fill-live-${now}`,
    ts: now,
    exchange: EXCHANGES[tick % 5],
    symbol: `${ASSETS[tick % 5]}/USDT`,
    side: tick % 2 === 0 ? "buy" : "sell",
    quantity: round(0.18 + Math.random() * 1.4, 4),
    price: round(1000 + Math.random() * 64000, 2),
    feeUsd: round(3 + Math.random() * 22, 2),
  };
  const totalKpi = snapshot.kpis.find((kpi) => kpi.key === "total_equity");
  return [
    { type: "heartbeat", ts: now },
    {
      type: "kpi:update",
      data: {
        key: "total_equity",
        value: round((totalKpi?.value || 0) + Math.sin(tick / 3) * 1280, 2),
        delta24h: round(2.4 + Math.sin(tick / 5) * 0.8, 2),
      },
    },
    { type: "trade:append", data: trade },
    { type: "risk:update", data: makeRisk(riskScore) },
    {
      type: "connection:update",
      data: snapshot.exchanges.map((exchange, index) => ({
        ...exchange,
        latencyMs:
          exchange.status === "disconnected"
            ? null
            : Math.round(
                (exchange.latencyMs || 70) + Math.sin(tick + index) * 12
              ),
      })),
    },
  ];
}

module.exports = {
  cryptoCenterSnapshot,
  cryptoCenterDelta,
};
