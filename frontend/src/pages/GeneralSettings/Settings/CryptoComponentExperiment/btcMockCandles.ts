import type { BtcCandlePoint } from "./btcSpotAssetTypes";

const baseTs = Date.UTC(2026, 5, 5, 0, 0, 0);
const closeSeries = [
  102940, 103120, 103050, 103260, 103430, 103380, 103610, 103840, 103720,
  103960, 104180, 104090, 104260, 104440, 104390, 104680, 104520, 104760,
  104980, 104860, 105040, 105180, 105090, 104940, 104720, 104860, 104650,
  104520, 104730, 104980, 105160, 105060, 105230, 105420, 105300, 105610,
  105820, 105690, 105900, 106120, 106040, 105860, 105740, 105980, 106180,
  106060, 105840, 104567.89,
];

export const btcMockCandles: BtcCandlePoint[] = closeSeries.map(
  (close, index) => {
    const previous = index === 0 ? close - 180 : closeSeries[index - 1];
    const open = previous;
    const high = Math.max(open, close) + 140 + (index % 5) * 18;
    const low = Math.min(open, close) - 120 - (index % 4) * 16;
    const volume = 80 + (index % 9) * 14 + Math.abs(close - open) / 9;

    return {
      ts: baseTs + index * 30 * 60_000,
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      volume: volume.toFixed(2),
    };
  }
);
