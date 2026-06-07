import type {
  TradingPairCandle,
  TradingPairCandlestickRange,
} from "./tradingPairCandlestickTypes";

const rangeMeta: Record<
  TradingPairCandlestickRange,
  { intervalMs: number; count: number }
> = {
  "15m": { intervalMs: 15 * 60_000, count: 200 },
  "1h": { intervalMs: 60 * 60_000, count: 200 },
  "4h": { intervalMs: 4 * 60 * 60_000, count: 200 },
  "1d": { intervalMs: 24 * 60 * 60_000, count: 200 },
  "7d": { intervalMs: 7 * 24 * 60 * 60_000, count: 200 },
  "30d": { intervalMs: 30 * 24 * 60 * 60_000, count: 200 },
};

function hash(input: string) {
  let value = 0;
  for (let index = 0; index < input.length; index += 1) {
    value = (value * 31 + input.charCodeAt(index)) >>> 0;
  }
  return value || 1;
}

function seededRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function fixed(value: number, decimals = 2) {
  return Math.max(value, 0.000001).toFixed(decimals);
}

export function generateMockCandles({
  pair,
  range,
  currentPrice,
  beforeTs,
}: {
  pair: string;
  range: TradingPairCandlestickRange;
  currentPrice: string;
  beforeTs?: number | null;
}): TradingPairCandle[] {
  const meta = rangeMeta[range] || rangeMeta["1d"];
  const random = seededRandom(hash(`${pair}:${range}:${beforeTs || "latest"}`));
  const basePrice = Number(currentPrice) || 100;
  const endTs = beforeTs
    ? beforeTs - meta.intervalMs
    : Math.floor(Date.now() / meta.intervalMs) * meta.intervalMs;
  let lastClose =
    basePrice * (beforeTs ? 0.94 + random() * 0.12 : 0.985 + random() * 0.03);

  return Array.from({ length: meta.count }, (_, index) => {
    const ts = endTs - (meta.count - index - 1) * meta.intervalMs;
    const trend = Math.sin((index / meta.count) * Math.PI * 2.4) * 0.006;
    const noise = (random() - 0.5) * 0.018;
    const open = lastClose;
    const close = open * (1 + trend + noise);
    const high = Math.max(open, close) * (1 + random() * 0.01);
    const low = Math.min(open, close) * (1 - random() * 0.01);
    const volume = (800 + random() * 3200) * (1 + Math.abs(noise) * 12);
    lastClose = close;

    const decimals = basePrice >= 100 ? 2 : basePrice >= 1 ? 4 : 6;
    return {
      ts,
      open: fixed(open, decimals),
      high: fixed(high, decimals),
      low: fixed(low, decimals),
      close: fixed(close, decimals),
      volume: fixed(volume, 2),
    };
  }).sort((left, right) => left.ts - right.ts);
}
