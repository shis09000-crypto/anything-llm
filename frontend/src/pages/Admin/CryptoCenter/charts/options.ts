import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import type {
  AccountNode,
  AssetAllocation,
  ExchangeAllocation,
  EquityPoint,
  KpiMetric,
  PnlPoint,
  RiskLevel,
  RiskScore,
} from "../types";
import type { CryptoCenterCopy } from "../i18n";

export const cryptoColors = {
  bg: "#08090b",
  panel: "#111318",
  panel2: "#171a20",
  grid: "rgba(255,255,255,.06)",
  text: "#E5E7EB",
  muted: "#8B9099",
  gold: "#D6A84F",
  green: "#21C55D",
  red: "#EF4444",
  yellow: "#F5C451",
  cyan: "#43D4FF",
};

echarts.registerTheme("athenaCryptoDark", {
  backgroundColor: "transparent",
  color: [
    cryptoColors.gold,
    cryptoColors.cyan,
    cryptoColors.green,
    "#8B5CF6",
    "#38BDF8",
    "#F97316",
    "#E879F9",
    "#94A3B8",
  ],
  textStyle: {
    color: cryptoColors.text,
    fontFamily: "plus-jakarta-sans, ui-sans-serif, system-ui",
  },
  legend: {
    textStyle: { color: cryptoColors.muted },
  },
});

const axis = {
  axisLine: { lineStyle: { color: "rgba(255,255,255,.12)" } },
  axisTick: { show: false },
  axisLabel: { color: cryptoColors.muted },
  splitLine: { lineStyle: { color: cryptoColors.grid } },
};

export function formatUsd(value = 0, compact = false) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 2 : 0,
  }).format(value);
}

export function formatNumber(value = 0, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(value);
}

export function riskColor(level: RiskLevel) {
  if (level === "danger") return cryptoColors.red;
  if (level === "watch") return cryptoColors.yellow;
  return cryptoColors.green;
}

export function sparklineOption(metric: KpiMetric): EChartsOption {
  const color =
    metric.tone === "negative"
      ? cryptoColors.red
      : metric.tone === "risk"
        ? cryptoColors.yellow
        : metric.tone === "neutral"
          ? cryptoColors.gold
          : cryptoColors.green;

  return {
    grid: { top: 4, right: 0, bottom: 4, left: 0 },
    xAxis: {
      type: "category",
      show: false,
      data: metric.trend.map((point) => point.ts),
    },
    yAxis: { type: "value", show: false },
    series: [
      {
        type: "line",
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2, color },
        areaStyle: { color: `${color}24` },
        data: metric.trend.map((point) => point.value),
      },
    ],
  };
}

export function assetDonutOption(
  assets: AssetAllocation[],
  copy: CryptoCenterCopy
): EChartsOption {
  return {
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.name}<br/>${formatUsd(params.value)}<br/>${formatNumber(params.percent)}%`,
    },
    legend: {
      orient: "vertical",
      right: 8,
      top: "center",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: cryptoColors.muted, fontSize: 11 },
    },
    series: [
      {
        name: copy.chartSeries.assetAllocation,
        type: "pie",
        radius: ["58%", "78%"],
        center: ["38%", "52%"],
        avoidLabelOverlap: true,
        label: { color: cryptoColors.text, formatter: "{b}\n{d}%" },
        labelLine: { lineStyle: { color: "rgba(255,255,255,.22)" } },
        data: assets.map((asset) => ({
          name: asset.symbol,
          value: asset.equityUsd,
        })),
      },
    ],
  };
}

export function exchangeDonutOption(
  exchanges: ExchangeAllocation[],
  copy: CryptoCenterCopy
): EChartsOption {
  return {
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.name}<br/>${formatUsd(params.value)}<br/>${formatNumber(params.percent)}%`,
    },
    legend: {
      orient: "vertical",
      right: 8,
      top: "center",
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: cryptoColors.muted, fontSize: 11 },
    },
    series: [
      {
        name: copy.chartSeries.exchangeAllocation,
        type: "pie",
        radius: ["55%", "76%"],
        center: ["38%", "52%"],
        label: {
          color: cryptoColors.text,
          formatter: (params: any) =>
            `${String(params.name).toUpperCase()}\n${params.percent}%`,
        },
        data: exchanges.map((exchange) => ({
          name: exchange.exchange,
          value: exchange.totalEquityUsd,
        })),
      },
    ],
  };
}

export function treemapOption(
  accounts: AccountNode[],
  copy: CryptoCenterCopy
): EChartsOption {
  return {
    tooltip: {
      formatter: (params: any) =>
        `${params.name}<br/>${formatUsd(params.value)}<br/>${copy.chartSeries.risk}: ${copy.riskLevels[params.data.riskLevel as RiskLevel] || params.data.riskLevel}`,
    },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: {
          color: cryptoColors.text,
          formatter: "{b}",
          fontSize: 12,
        },
        upperLabel: { show: false },
        itemStyle: {
          borderColor: cryptoColors.bg,
          borderWidth: 2,
          gapWidth: 2,
        },
        data: accounts.map((account) => ({
          name:
            copy.accountNames[account.id] ||
            copy.accountTypes[account.type] ||
            account.name,
          value: account.equityUsd,
          riskLevel: account.riskLevel,
          itemStyle: {
            color: riskColor(account.riskLevel),
            opacity: account.riskLevel === "safe" ? 0.68 : 0.82,
          },
        })),
      },
    ],
  };
}

export function equityTrendOption(
  points: EquityPoint[],
  copy: CryptoCenterCopy
): EChartsOption {
  return {
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      formatter: (params: any) => {
        const rows = Array.isArray(params) ? params : [params];
        const first = rows[0];
        return [
          new Date(first.axisValue).toLocaleString(),
          ...rows.map(
            (row) =>
              `${row.marker}${row.seriesName}: ${formatNumber(row.value[1], 3)}`
          ),
        ].join("<br/>");
      },
    },
    grid: { top: 28, right: 18, bottom: 48, left: 68 },
    dataZoom: [
      { type: "inside", start: 0, end: 100 },
      {
        type: "slider",
        height: 18,
        bottom: 12,
        borderColor: "rgba(255,255,255,.08)",
      },
    ],
    xAxis: { ...axis, type: "time" },
    yAxis: [
      {
        ...axis,
        type: "value",
        name: copy.chartSeries.totalEquity,
        axisLabel: {
          color: cryptoColors.muted,
          formatter: (v: number) => formatUsd(v, true),
        },
      },
      {
        ...axis,
        type: "value",
        name: copy.chartSeries.drawdown,
        axisLabel: { color: cryptoColors.muted, formatter: "{value}%" },
      },
    ],
    series: [
      {
        name: copy.chartSeries.totalEquity,
        type: "line",
        smooth: true,
        symbol: "none",
        lineStyle: { color: cryptoColors.cyan, width: 2 },
        areaStyle: { color: "rgba(67,212,255,.12)" },
        data: points.map((point) => [point.ts, point.totalEquityUsd]),
      },
      {
        name: copy.chartSeries.nav,
        type: "line",
        smooth: true,
        symbol: "none",
        yAxisIndex: 1,
        lineStyle: { color: cryptoColors.gold, width: 2 },
        data: points.map((point) => [point.ts, point.nav]),
      },
      {
        name: copy.chartSeries.drawdown,
        type: "line",
        smooth: true,
        symbol: "none",
        yAxisIndex: 1,
        lineStyle: { color: cryptoColors.red, width: 1 },
        areaStyle: { color: "rgba(239,68,68,.18)" },
        data: points.map((point) => [point.ts, point.drawdownPct]),
      },
    ],
  };
}

export function pnlOption(
  points: PnlPoint[],
  copy: CryptoCenterCopy
): EChartsOption {
  return {
    tooltip: { trigger: "axis" },
    grid: { top: 28, right: 18, bottom: 34, left: 58 },
    xAxis: {
      ...axis,
      type: "category",
      data: points.map((point) => point.date.slice(5)),
    },
    yAxis: {
      ...axis,
      type: "value",
      axisLabel: {
        color: cryptoColors.muted,
        formatter: (v: number) => formatUsd(v, true),
      },
    },
    series: [
      {
        name: copy.chartSeries.realized,
        type: "bar",
        stack: "pnl",
        itemStyle: { color: cryptoColors.green, borderRadius: [3, 3, 0, 0] },
        data: points.map((point) => point.realizedUsd),
      },
      {
        name: copy.chartSeries.unrealized,
        type: "bar",
        stack: "pnl",
        itemStyle: { color: cryptoColors.red, borderRadius: [3, 3, 0, 0] },
        data: points.map((point) => point.unrealizedUsd),
      },
      {
        name: copy.chartSeries.total,
        type: "line",
        smooth: true,
        symbol: "none",
        lineStyle: { color: cryptoColors.gold, width: 2 },
        data: points.map((point) => point.totalUsd),
      },
    ],
  };
}

export function sankeyOption(copy: CryptoCenterCopy): EChartsOption {
  const flow = copy.fundsFlow;
  return {
    tooltip: { trigger: "item" },
    series: [
      {
        type: "sankey",
        nodeWidth: 12,
        nodeGap: 14,
        draggable: false,
        label: { color: cryptoColors.text, fontSize: 12 },
        lineStyle: { color: "gradient", opacity: 0.36, curveness: 0.5 },
        data: [
          { name: flow.deposit },
          { name: flow.funding },
          { name: flow.spot },
          { name: flow.futures },
          { name: flow.earn },
          { name: flow.withdraw },
        ],
        links: [
          { source: flow.deposit, target: flow.funding, value: 480000 },
          { source: flow.funding, target: flow.spot, value: 310000 },
          { source: flow.spot, target: flow.futures, value: 180000 },
          { source: flow.futures, target: flow.earn, value: 72000 },
          {
            source: flow.earn,
            target: flow.withdraw,
            value: 28000,
            lineStyle: { color: cryptoColors.red, opacity: 0.56 },
          },
        ],
      },
    ],
  };
}

export function gaugeOption(
  risk: RiskScore,
  copy: CryptoCenterCopy
): EChartsOption {
  return {
    series: [
      {
        type: "gauge",
        min: 0,
        max: 100,
        radius: "92%",
        axisLine: {
          lineStyle: {
            width: 14,
            color: [
              [0.4, cryptoColors.green],
              [0.7, cryptoColors.yellow],
              [1, cryptoColors.red],
            ],
          },
        },
        pointer: { width: 4, itemStyle: { color: cryptoColors.gold } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { color: "rgba(255,255,255,.22)" } },
        axisLabel: { color: cryptoColors.muted, distance: 20 },
        detail: {
          valueAnimation: true,
          formatter: "{value}",
          color: cryptoColors.text,
          fontSize: 28,
          fontWeight: 700,
        },
        title: {
          color: cryptoColors.muted,
          offsetCenter: [0, "72%"],
          fontSize: 12,
        },
        data: [{ value: risk.score, name: copy.riskLevels[risk.level] }],
      },
    ],
  };
}
