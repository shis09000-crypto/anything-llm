const DEFAULT_ITEMS = [
  {
    key: "publicMarket",
    label: "公共行情连接",
    message: "连接 Gate public market",
  },
  {
    key: "privateAccount",
    label: "私有账户连接",
    message: "读取账户只读数据",
  },
  { key: "equity", label: "总资产", message: "加载总资产" },
  { key: "allocation", label: "资产分布", message: "加载资产分布" },
  { key: "topAssets", label: "现货前六资产", message: "加载现货前六资产" },
  { key: "openFutures", label: "未平仓合约", message: "加载未平仓合约" },
  {
    key: "tradeRecords",
    label: "交易明细",
    message: "检查交易明细接口并预热第一页",
  },
  { key: "marketCandles", label: "K线行情", message: "加载K线行情" },
];

const ITEM_WEIGHT = Math.round(100 / DEFAULT_ITEMS.length);

function itemPct(status) {
  if (status === "ready" || status === "degraded") return 100;
  if (status === "loading") return 55;
  if (status === "error") return 100;
  return 0;
}

function phaseFor(items) {
  const statuses = items.map((item) => item.status);
  if (statuses.every((status) => status === "pending")) return "initializing";
  if (statuses.some((status) => status === "loading")) return "loading";
  if (statuses.some((status) => status === "error")) {
    return statuses.some((status) => status === "ready") ? "degraded" : "error";
  }
  if (statuses.some((status) => status === "degraded")) return "degraded";
  return "ready";
}

class CryptoHubLoadingProgress {
  constructor() {
    this.reset();
  }

  reset() {
    this.items = DEFAULT_ITEMS.map((item) => ({
      ...item,
      status: "pending",
      pct: 0,
      safeErrorMessage: null,
    }));
    this.updatedAt = Date.now();
  }

  setItem(key, status, patch = {}) {
    this.items = this.items.map((item) =>
      item.key === key
        ? {
            ...item,
            ...patch,
            status,
            pct: patch.pct ?? itemPct(status),
          }
        : item
    );
    this.updatedAt = Date.now();
  }

  snapshot() {
    const overallPct = Math.min(
      100,
      Math.round(
        this.items.reduce(
          (sum, item) => sum + (item.pct / 100) * ITEM_WEIGHT,
          0
        )
      )
    );
    return {
      phase: phaseFor(this.items),
      overallPct,
      items: this.items,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = {
  CryptoHubLoadingProgress,
};
