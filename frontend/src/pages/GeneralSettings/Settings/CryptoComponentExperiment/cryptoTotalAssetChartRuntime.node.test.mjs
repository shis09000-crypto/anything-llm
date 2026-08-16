import test from "node:test";
import assert from "node:assert/strict";
import {
  bucketEquityDisplaySeries,
  equityTooltipPlacement,
  hampelFilterEquitySeries,
  monotoneCurvePath,
  normalizeEquityDisplaySeries,
  prepareEquityDisplaySeries,
  timeAwareEquityEma,
} from "./cryptoTotalAssetChartRuntime.js";

function point(timeMs, value) {
  return { timeMs, value };
}

test("normalizes invalid, duplicate, and out-of-order equity points", () => {
  const result = normalizeEquityDisplaySeries([
    point(2, 20),
    point(1, 10),
    point(2, 22),
    point(Number.NaN, 30),
  ]);
  assert.deepEqual(
    result.map(({ timeMs, value }) => [timeMs, value]),
    [
      [1, 10],
      [2, 22],
    ]
  );
});

test("Hampel display filter removes an isolated spike without mutating input", () => {
  const source = [100, 101, 500, 99, 100].map((value, index) =>
    point(index * 1_500, value)
  );
  const result = hampelFilterEquitySeries(source);
  assert.equal(result[2].value, 100);
  assert.equal(result[2].outlierAdjusted, true);
  assert.equal(source[2].value, 500);
});

test("time-aware EMA reaches half of a persistent step after one half-life", () => {
  const result = timeAwareEquityEma(
    [point(0, 0), point(12_000, 100), point(24_000, 100)],
    12_000
  );
  assert.ok(Math.abs(result[1].value - 50) < 1e-9);
  assert.ok(Math.abs(result[2].value - 75) < 1e-9);
});

test("24h median bucketing remains bounded and preserves endpoints", () => {
  const source = Array.from({ length: 2_000 }, (_, index) =>
    point(index * 40_000, index)
  );
  const result = bucketEquityDisplaySeries(source, { maxPoints: 360 });
  assert.ok(result.length <= 360);
  assert.equal(result[0].timeMs, source[0].timeMs);
  assert.equal(result.at(-1).timeMs, source.at(-1).timeMs);
});

test("balanced display pipeline suppresses a spike and caps path density", () => {
  const source = Array.from({ length: 1_000 }, (_, index) =>
    point(index * 1_500, index === 500 ? 100_000 : 80_000 + (index % 5))
  );
  const result = prepareEquityDisplaySeries(source);
  assert.ok(result.length <= 360);
  assert.ok(Math.max(...result.map(({ value }) => value)) < 81_000);
});

test("monotone curve control values do not overshoot monotonic inputs", () => {
  const path = monotoneCurvePath([
    { x: 0, y: 10 },
    { x: 1, y: 20 },
    { x: 2, y: 30 },
    { x: 3, y: 40 },
  ]);
  assert.match(path, /^M 0 10 C /);
  assert.equal(path.includes("NaN"), false);
  const cubicSegments = [...path.matchAll(/C ([^C]+)/g)];
  cubicSegments.forEach((segment) => {
    const values = segment[1].trim().split(/\s+/).map(Number);
    const yValues = [values[1], values[3], values[5]];
    yValues.forEach((value) => assert.ok(value >= 10 && value <= 40));
  });
});

test("tooltip follows the point with stable right-up fallback ordering", () => {
  const common = {
    chartHeight: 500,
    chartWidth: 700,
    tooltipHeight: 164,
    tooltipWidth: 330,
  };
  const upperRight = equityTooltipPlacement({
    ...common,
    pointX: 200,
    pointY: 300,
  });
  assert.deepEqual(upperRight, {
    placement: "upperRight",
    x: 212,
    y: 124,
  });

  const upperLeft = equityTooltipPlacement({
    ...common,
    pointX: 600,
    pointY: 300,
  });
  assert.deepEqual(upperLeft, {
    placement: "upperLeft",
    x: 258,
    y: 124,
  });

  const lowerRight = equityTooltipPlacement({
    ...common,
    pointX: 200,
    pointY: 100,
  });
  assert.deepEqual(lowerRight, {
    placement: "lowerRight",
    x: 212,
    y: 112,
  });

  const stableUpperLeft = equityTooltipPlacement({
    ...common,
    pointX: 350,
    pointY: 300,
    previousPlacement: "upperLeft",
  });
  assert.equal(stableUpperLeft.placement, "upperLeft");
});
