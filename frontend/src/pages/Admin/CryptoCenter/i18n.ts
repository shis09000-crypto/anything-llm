import type {
  AccountType,
  AlertType,
  OrderType,
  RiskLevel,
  SocketStatus,
} from "./types";

type LocaleKey = "en" | "zh" | "ja";

export interface CryptoCenterCopy {
  pageTitle: string;
  status: Record<SocketStatus, string>;
  lastTick: string;
  snapshot: string;
  refreshStream: string;
  live: string;
  openOrders: string;
  notional: string;
  fills: string;
  today: string;
  loading: string;
  socketErrors: Record<string, string>;
  filterLabels: {
    risk: string;
    pnl: string;
    margin: string;
  };
  panels: {
    assetAllocation: string;
    exchangeAllocation: string;
    accountStructure: string;
    totalEquityTrend: string;
    riskCenter: string;
    pnlAnalysis: string;
    positionsRisk: string;
    orderMonitor: string;
    recentFills: string;
    alertCenter: string;
    fundsFlow: string;
    earnPortfolio: string;
  };
  kpis: Record<string, string>;
  positionColumns: string[];
  positionSides: {
    long: string;
    short: string;
    net: string;
  };
  tradeLabels: {
    buy: string;
    sell: string;
    qty: string;
    fee: string;
  };
  riskLevels: Record<RiskLevel, string>;
  riskBreakdown: {
    leverage: string;
    margin: string;
    assetConcentration: string;
    accountConcentration: string;
    liquidity: string;
  };
  orderTypes: Record<OrderType, string>;
  earnCategories: {
    flexible: string;
    fixed: string;
    staking: string;
    launchpool: string;
  };
  earnStats: {
    apr: string;
    accrued: string;
    today: string;
  };
  accountTypes: Record<AccountType, string>;
  accountNames: Record<string, string>;
  chartSeries: {
    assetAllocation: string;
    exchangeAllocation: string;
    totalEquity: string;
    nav: string;
    drawdown: string;
    realized: string;
    unrealized: string;
    total: string;
    risk: string;
  };
  fundsFlow: {
    deposit: string;
    funding: string;
    spot: string;
    futures: string;
    earn: string;
    withdraw: string;
  };
  alerts: {
    type: Record<AlertType, string>;
    title: Record<string, string>;
    message: Record<string, string>;
    soundToggle: string;
  };
}

const en: CryptoCenterCopy = {
  pageTitle: "Crypto Center",
  status: {
    connecting: "connecting",
    connected: "connected",
    degraded: "degraded",
    disconnected: "disconnected",
  },
  lastTick: "Last tick",
  snapshot: "Snapshot",
  refreshStream: "Refresh stream",
  live: "Live",
  openOrders: "Open Orders",
  notional: "Notional",
  fills: "fills",
  today: "Today",
  loading: "Initializing market control stream",
  socketErrors: {
    "Snapshot request failed.": "Snapshot request failed.",
    "Crypto stream connection error.": "Crypto stream connection error.",
    "Crypto stream disconnected.": "Crypto stream disconnected.",
  },
  filterLabels: {
    risk: "Risk",
    pnl: "PnL",
    margin: "Margin",
  },
  panels: {
    assetAllocation: "Asset Allocation",
    exchangeAllocation: "Exchange Allocation",
    accountStructure: "Account Structure",
    totalEquityTrend: "Total Equity Trend",
    riskCenter: "Risk Center",
    pnlAnalysis: "PnL Analysis",
    positionsRisk: "Positions Risk",
    orderMonitor: "Order Monitor",
    recentFills: "Recent Fills",
    alertCenter: "Alert Center",
    fundsFlow: "Funds Flow",
    earnPortfolio: "Earn Portfolio",
  },
  kpis: {
    total_equity: "Total Equity",
    net_profit_today: "Net Profit Today",
    realized_pnl_today: "Realized PnL",
    unrealized_pnl_today: "Unrealized PnL",
    fees_today: "Fees Today",
    funding_today: "Funding Today",
    earn_income_today: "Earn Income",
    risk_index: "Risk Index",
    exchange_connectivity: "Exchange Online",
  },
  positionColumns: [
    "Coin",
    "Side",
    "Qty",
    "Lev",
    "Entry",
    "Mark",
    "Liq",
    "Unrealized",
    "Margin",
    "Risk",
  ],
  positionSides: {
    long: "Long",
    short: "Short",
    net: "Net",
  },
  tradeLabels: {
    buy: "Buy",
    sell: "Sell",
    qty: "qty",
    fee: "fee",
  },
  riskLevels: {
    safe: "Safe",
    watch: "Watch",
    danger: "Danger",
  },
  riskBreakdown: {
    leverage: "Leverage",
    margin: "Margin",
    assetConcentration: "Asset concentration",
    accountConcentration: "Account concentration",
    liquidity: "Liquidity",
  },
  orderTypes: {
    limit: "Limit",
    market: "Market",
    conditional: "Conditional",
    take_profit_stop_loss: "Take Profit Stop Loss",
  },
  earnCategories: {
    flexible: "Flexible",
    fixed: "Fixed",
    staking: "Staking",
    launchpool: "Launchpool",
  },
  earnStats: {
    apr: "APR",
    accrued: "Accrued",
    today: "Today",
  },
  accountTypes: {
    spot: "Spot",
    futures: "Futures",
    funding: "Funding",
    earn: "Earn",
    finance: "Finance",
  },
  accountNames: {
    spot: "Spot Account",
    futures: "Futures Account",
    earn: "Earn Account",
    funding: "Funding Account",
    finance: "Finance Account",
    "bitget-futures": "Bitget Futures",
  },
  chartSeries: {
    assetAllocation: "Asset Allocation",
    exchangeAllocation: "Exchange Allocation",
    totalEquity: "Total Equity",
    nav: "NAV",
    drawdown: "Drawdown",
    realized: "Realized",
    unrealized: "Unrealized",
    total: "Total",
    risk: "Risk",
  },
  fundsFlow: {
    deposit: "Deposit",
    funding: "Funding",
    spot: "Spot",
    futures: "Futures",
    earn: "Earn",
    withdraw: "Withdraw",
  },
  alerts: {
    type: {
      large_withdrawal: "Large Withdrawal",
      api_invalid: "API Invalid",
      ws_disconnected: "WS Disconnected",
      low_margin_ratio: "Low Margin Ratio",
      liquidation_risk: "Liquidation Risk",
      abnormal_flow: "Abnormal Flow",
    },
    title: {
      "alert-ws-okx": "OKX WebSocket degraded",
      "alert-margin-xrp": "Margin ratio below threshold",
      "alert-flow": "Unusual transfer route",
    },
    message: {
      "alert-ws-okx": "Private order stream latency is above 140ms.",
      "alert-margin-xrp":
        "XRP/USDT short position margin ratio is near danger zone.",
      "alert-flow": "Funding to futures transfer is 38% above baseline.",
    },
    soundToggle: "Toggle sound",
  },
};

const zh: CryptoCenterCopy = {
  ...en,
  pageTitle: "加密资产中心",
  status: {
    connecting: "连接中",
    connected: "已连接",
    degraded: "不稳定",
    disconnected: "已断开",
  },
  lastTick: "最近推送",
  snapshot: "快照",
  refreshStream: "刷新实时流",
  live: "实时",
  openOrders: "挂单数量",
  notional: "挂单金额",
  fills: "笔成交",
  today: "今日",
  loading: "正在初始化行情与资产控制流",
  socketErrors: {
    "Snapshot request failed.": "快照请求失败。",
    "Crypto stream connection error.": "实时流连接异常。",
    "Crypto stream disconnected.": "实时流已断开。",
  },
  filterLabels: {
    risk: "风险",
    pnl: "盈亏",
    margin: "保证金",
  },
  panels: {
    assetAllocation: "资产分布",
    exchangeAllocation: "交易所分布",
    accountStructure: "账户结构",
    totalEquityTrend: "总权益趋势",
    riskCenter: "风险中心",
    pnlAnalysis: "盈亏分析",
    positionsRisk: "持仓风险",
    orderMonitor: "订单监控",
    recentFills: "最近成交",
    alertCenter: "实时告警",
    fundsFlow: "资金流向",
    earnPortfolio: "理财组合",
  },
  kpis: {
    total_equity: "总资产估值",
    net_profit_today: "今日净收益",
    realized_pnl_today: "今日已实现盈亏",
    unrealized_pnl_today: "今日未实现盈亏",
    fees_today: "今日手续费",
    funding_today: "今日资金费率",
    earn_income_today: "活期理财收益",
    risk_index: "当前风险指数",
    exchange_connectivity: "交易所在线数",
  },
  positionColumns: [
    "币种",
    "方向",
    "数量",
    "杠杆",
    "开仓价",
    "标记价",
    "强平价",
    "未实现盈亏",
    "保证金率",
    "风险",
  ],
  positionSides: {
    long: "多头",
    short: "空头",
    net: "净持仓",
  },
  tradeLabels: {
    buy: "买入",
    sell: "卖出",
    qty: "数量",
    fee: "手续费",
  },
  riskLevels: {
    safe: "安全",
    watch: "注意",
    danger: "危险",
  },
  riskBreakdown: {
    leverage: "杠杆率",
    margin: "保证金率",
    assetConcentration: "单币集中度",
    accountConcentration: "账户集中度",
    liquidity: "流动性风险",
  },
  orderTypes: {
    limit: "限价单",
    market: "市价单",
    conditional: "条件单",
    take_profit_stop_loss: "止盈止损单",
  },
  earnCategories: {
    flexible: "活期产品",
    fixed: "定期产品",
    staking: "Staking",
    launchpool: "Launchpool",
  },
  earnStats: {
    apr: "APR",
    accrued: "累计收益",
    today: "今日收益",
  },
  accountTypes: {
    spot: "现货",
    futures: "合约",
    funding: "资金",
    earn: "Earn",
    finance: "理财",
  },
  accountNames: {
    spot: "现货账户",
    futures: "合约账户",
    earn: "Earn账户",
    funding: "资金账户",
    finance: "理财账户",
    "bitget-futures": "Bitget合约",
  },
  chartSeries: {
    assetAllocation: "资产分布",
    exchangeAllocation: "交易所分布",
    totalEquity: "总权益",
    nav: "净值",
    drawdown: "回撤",
    realized: "已实现",
    unrealized: "未实现",
    total: "总收益",
    risk: "风险",
  },
  fundsFlow: {
    deposit: "充值",
    funding: "资金账户",
    spot: "现货",
    futures: "合约",
    earn: "理财",
    withdraw: "提现",
  },
  alerts: {
    type: {
      large_withdrawal: "大额提现",
      api_invalid: "API失效",
      ws_disconnected: "WebSocket断开",
      low_margin_ratio: "保证金率过低",
      liquidation_risk: "强平风险",
      abnormal_flow: "异常资金流动",
    },
    title: {
      "alert-ws-okx": "OKX WebSocket 不稳定",
      "alert-margin-xrp": "保证金率低于阈值",
      "alert-flow": "异常资金路径",
    },
    message: {
      "alert-ws-okx": "私有订单流延迟高于 140ms。",
      "alert-margin-xrp": "XRP/USDT 空头仓位保证金率接近危险区。",
      "alert-flow": "资金账户转入合约的金额高于基准 38%。",
    },
    soundToggle: "切换声音提醒",
  },
};

const ja: CryptoCenterCopy = {
  ...en,
  pageTitle: "暗号資産センター",
  status: {
    connecting: "接続中",
    connected: "接続済み",
    degraded: "不安定",
    disconnected: "切断",
  },
  lastTick: "最終更新",
  snapshot: "スナップショット",
  refreshStream: "リアルタイム更新",
  live: "リアルタイム",
  openOrders: "未約定注文",
  notional: "注文金額",
  fills: "約定",
  today: "本日",
  loading: "マーケット管理ストリームを初期化中",
  socketErrors: {
    "Snapshot request failed.": "スナップショットの取得に失敗しました。",
    "Crypto stream connection error.":
      "リアルタイム接続でエラーが発生しました。",
    "Crypto stream disconnected.": "リアルタイム接続が切断されました。",
  },
  filterLabels: {
    risk: "リスク",
    pnl: "損益",
    margin: "証拠金",
  },
  panels: {
    assetAllocation: "資産配分",
    exchangeAllocation: "取引所配分",
    accountStructure: "口座構成",
    totalEquityTrend: "総資産推移",
    riskCenter: "リスクセンター",
    pnlAnalysis: "損益分析",
    positionsRisk: "ポジションリスク",
    orderMonitor: "注文監視",
    recentFills: "直近約定",
    alertCenter: "リアルタイム警告",
    fundsFlow: "資金フロー",
    earnPortfolio: "Earnポートフォリオ",
  },
  kpis: {
    total_equity: "総資産評価額",
    net_profit_today: "本日の純利益",
    realized_pnl_today: "本日の実現損益",
    unrealized_pnl_today: "本日の未実現損益",
    fees_today: "本日の手数料",
    funding_today: "本日の資金調達料",
    earn_income_today: "流動型運用収益",
    risk_index: "現在のリスク指数",
    exchange_connectivity: "接続中の取引所",
  },
  positionColumns: [
    "銘柄",
    "方向",
    "数量",
    "レバ",
    "建値",
    "マーク",
    "強制決済",
    "未実現損益",
    "証拠金率",
    "リスク",
  ],
  positionSides: {
    long: "ロング",
    short: "ショート",
    net: "ネット",
  },
  tradeLabels: {
    buy: "買い",
    sell: "売り",
    qty: "数量",
    fee: "手数料",
  },
  riskLevels: {
    safe: "安全",
    watch: "注意",
    danger: "危険",
  },
  riskBreakdown: {
    leverage: "レバレッジ率",
    margin: "証拠金率",
    assetConcentration: "単一銘柄集中度",
    accountConcentration: "口座集中度",
    liquidity: "流動性リスク",
  },
  orderTypes: {
    limit: "指値注文",
    market: "成行注文",
    conditional: "条件付き注文",
    take_profit_stop_loss: "利確・損切り注文",
  },
  earnCategories: {
    flexible: "流動型商品",
    fixed: "定期商品",
    staking: "Staking",
    launchpool: "Launchpool",
  },
  earnStats: {
    apr: "APR",
    accrued: "累計収益",
    today: "本日収益",
  },
  accountTypes: {
    spot: "現物",
    futures: "先物",
    funding: "資金",
    earn: "Earn",
    finance: "運用",
  },
  accountNames: {
    spot: "現物口座",
    futures: "先物口座",
    earn: "Earn口座",
    funding: "資金口座",
    finance: "運用口座",
    "bitget-futures": "Bitget先物",
  },
  chartSeries: {
    assetAllocation: "資産配分",
    exchangeAllocation: "取引所配分",
    totalEquity: "総資産",
    nav: "基準価額",
    drawdown: "ドローダウン",
    realized: "実現損益",
    unrealized: "未実現損益",
    total: "総収益",
    risk: "リスク",
  },
  fundsFlow: {
    deposit: "入金",
    funding: "資金口座",
    spot: "現物",
    futures: "先物",
    earn: "運用",
    withdraw: "出金",
  },
  alerts: {
    type: {
      large_withdrawal: "大口出金",
      api_invalid: "API無効",
      ws_disconnected: "WebSocket切断",
      low_margin_ratio: "証拠金率低下",
      liquidation_risk: "強制決済リスク",
      abnormal_flow: "異常な資金移動",
    },
    title: {
      "alert-ws-okx": "OKX WebSocket が不安定",
      "alert-margin-xrp": "証拠金率がしきい値を下回りました",
      "alert-flow": "通常と異なる資金ルート",
    },
    message: {
      "alert-ws-okx":
        "プライベート注文ストリームの遅延が 140ms を超えています。",
      "alert-margin-xrp":
        "XRP/USDT のショートポジション証拠金率が危険域に近づいています。",
      "alert-flow": "資金口座から先物への移動額が基準値を 38% 上回っています。",
    },
    soundToggle: "音声通知を切り替え",
  },
};

function localeKey(language = "en"): LocaleKey {
  const normalized = language.toLowerCase();
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("ja")) return "ja";
  return "en";
}

export function getCryptoCopy(language = "en") {
  const copies: Record<LocaleKey, CryptoCenterCopy> = { en, zh, ja };
  return copies[localeKey(language)];
}
