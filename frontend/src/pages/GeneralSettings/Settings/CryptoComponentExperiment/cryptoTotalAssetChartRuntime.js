export const EQUITY_CHART_EMA_HALF_LIFE_MS = 12_000;
export const EQUITY_CHART_HAMPEL_WINDOW_SIZE = 5;
export const EQUITY_CHART_MAX_DISPLAY_POINTS = 360;
export const EQUITY_CHART_WINDOW_MS = 24 * 60 * 60 * 1_000;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function normalizeEquityDisplaySeries(points = []) {
  const normalized = new Map();
  points.forEach((point, index) => {
    const timeMs = Number(point?.timeMs);
    const value = Number(point?.value);
    if (!Number.isFinite(timeMs) || !Number.isFinite(value)) return;
    normalized.set(timeMs, { ...point, index, timeMs, value });
  });
  return [...normalized.values()].sort(
    (left, right) => left.timeMs - right.timeMs
  );
}

export function hampelFilterEquitySeries(
  points,
  windowSize = EQUITY_CHART_HAMPEL_WINDOW_SIZE
) {
  const radius = Math.floor(Math.max(3, windowSize) / 2);
  if (points.length < radius * 2 + 1)
    return points.map((point) => ({ ...point }));

  return points.map((point, index) => {
    if (index < radius || index >= points.length - radius) return { ...point };

    const window = points.slice(index - radius, index + radius + 1);
    const center = median(window.map((entry) => entry.value));
    const mad = median(window.map((entry) => Math.abs(entry.value - center)));
    const robustSigma = 1.4826 * mad;
    const minimumThreshold = Math.max(Math.abs(center) * 1e-8, 0.01);
    const threshold = Math.max(3 * robustSigma, minimumThreshold);

    return Math.abs(point.value - center) > threshold
      ? { ...point, value: center, outlierAdjusted: true }
      : { ...point };
  });
}

export function timeAwareEquityEma(
  points,
  halfLifeMs = EQUITY_CHART_EMA_HALF_LIFE_MS
) {
  if (!points.length) return [];
  const safeHalfLifeMs = Math.max(1, Number(halfLifeMs) || 1);
  let previousValue = points[0].value;
  let previousTime = points[0].timeMs;

  return points.map((point, index) => {
    if (index === 0) return { ...point, value: previousValue };
    const elapsedMs = Math.max(0, point.timeMs - previousTime);
    const alpha = 1 - Math.exp((-Math.LN2 * elapsedMs) / safeHalfLifeMs);
    previousValue += alpha * (point.value - previousValue);
    previousTime = point.timeMs;
    return { ...point, value: previousValue };
  });
}

export function bucketEquityDisplaySeries(
  points,
  {
    maxPoints = EQUITY_CHART_MAX_DISPLAY_POINTS,
    windowMs = EQUITY_CHART_WINDOW_MS,
  } = {}
) {
  if (points.length <= maxPoints) return points.map((point) => ({ ...point }));

  const interiorBucketCount = Math.max(1, maxPoints - 2);
  const bucketWidthMs = Math.max(1, windowMs / interiorBucketCount);
  const buckets = new Map();
  points.forEach((point) => {
    const bucketIndex = Math.min(
      interiorBucketCount - 1,
      Math.max(0, Math.floor(point.timeMs / bucketWidthMs))
    );
    const bucket = buckets.get(bucketIndex) || [];
    bucket.push(point);
    buckets.set(bucketIndex, bucket);
  });

  const bucketed = [...buckets.values()].map((bucket) => ({
    ...bucket[Math.floor(bucket.length / 2)],
    timeMs: median(bucket.map((point) => point.timeMs)),
    value: median(bucket.map((point) => point.value)),
    bucketSize: bucket.length,
  }));
  const first = points[0];
  const last = points[points.length - 1];
  return normalizeEquityDisplaySeries([first, ...bucketed, last]).slice(
    0,
    maxPoints
  );
}

export function prepareEquityDisplaySeries(
  points,
  {
    halfLifeMs = EQUITY_CHART_EMA_HALF_LIFE_MS,
    maxPoints = EQUITY_CHART_MAX_DISPLAY_POINTS,
    windowMs = EQUITY_CHART_WINDOW_MS,
  } = {}
) {
  const normalized = normalizeEquityDisplaySeries(points);
  const filtered = hampelFilterEquitySeries(normalized);
  const smoothed = timeAwareEquityEma(filtered, halfLifeMs);
  return bucketEquityDisplaySeries(smoothed, { maxPoints, windowMs });
}

export function monotoneCurvePath(points = []) {
  const normalized = normalizeEquityDisplaySeries(
    points.map((point) => ({ ...point, timeMs: point.x, value: point.y }))
  ).map((point) => ({ ...point, x: point.timeMs, y: point.value }));
  if (!normalized.length) return "";
  if (normalized.length === 1) return `M ${normalized[0].x} ${normalized[0].y}`;
  if (normalized.length === 2)
    return `M ${normalized[0].x} ${normalized[0].y} L ${normalized[1].x} ${normalized[1].y}`;

  const deltas = [];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const left = normalized[index];
    const right = normalized[index + 1];
    deltas.push((right.y - left.y) / (right.x - left.x));
  }

  const tangents = [deltas[0]];
  for (let index = 1; index < normalized.length - 1; index += 1) {
    const previous = deltas[index - 1];
    const next = deltas[index];
    tangents.push(
      previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)
        ? 0
        : (previous + next) / 2
    );
  }
  tangents.push(deltas[deltas.length - 1]);

  for (let index = 0; index < deltas.length; index += 1) {
    if (deltas[index] === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const leftRatio = tangents[index] / deltas[index];
    const rightRatio = tangents[index + 1] / deltas[index];
    const magnitude = leftRatio ** 2 + rightRatio ** 2;
    if (magnitude <= 9) continue;
    const scale = 3 / Math.sqrt(magnitude);
    tangents[index] = scale * leftRatio * deltas[index];
    tangents[index + 1] = scale * rightRatio * deltas[index];
  }

  const segments = [`M ${normalized[0].x} ${normalized[0].y}`];
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const left = normalized[index];
    const right = normalized[index + 1];
    const width = right.x - left.x;
    segments.push(
      `C ${left.x + width / 3} ${left.y + (tangents[index] * width) / 3} ${right.x - width / 3} ${right.y - (tangents[index + 1] * width) / 3} ${right.x} ${right.y}`
    );
  }
  return segments.join(" ");
}

export function interpolateEquityDisplayValue(points, timeMs) {
  if (!points.length) return null;
  if (timeMs <= points[0].timeMs) return points[0].value;
  const last = points[points.length - 1];
  if (timeMs >= last.timeMs) return last.value;

  let left = 0;
  let right = points.length - 1;
  while (left + 1 < right) {
    const middle = Math.floor((left + right) / 2);
    if (points[middle].timeMs <= timeMs) left = middle;
    else right = middle;
  }
  const start = points[left];
  const end = points[right];
  const ratio = (timeMs - start.timeMs) / (end.timeMs - start.timeMs);
  return start.value + ratio * (end.value - start.value);
}

export function equityTooltipPlacement({
  chartHeight,
  chartWidth,
  pointX,
  pointY,
  previousPlacement = null,
  tooltipHeight,
  tooltipWidth,
  gap = 12,
  margin = 8,
}) {
  const candidates = {
    upperRight: {
      placement: "upperRight",
      x: pointX + gap,
      y: pointY - gap - tooltipHeight,
    },
    upperLeft: {
      placement: "upperLeft",
      x: pointX - gap - tooltipWidth,
      y: pointY - gap - tooltipHeight,
    },
    lowerRight: {
      placement: "lowerRight",
      x: pointX + gap,
      y: pointY + gap,
    },
    lowerLeft: {
      placement: "lowerLeft",
      x: pointX - gap - tooltipWidth,
      y: pointY + gap,
    },
  };
  const fits = (candidate) =>
    candidate.x >= margin &&
    candidate.y >= margin &&
    candidate.x + tooltipWidth <= chartWidth - margin &&
    candidate.y + tooltipHeight <= chartHeight - margin;
  const stableCandidate = candidates[previousPlacement];
  const selected =
    (stableCandidate && fits(stableCandidate) ? stableCandidate : null) ||
    [
      candidates.upperRight,
      candidates.upperLeft,
      candidates.lowerRight,
      candidates.lowerLeft,
    ].find(fits);
  if (selected) return selected;

  const placeAbove = pointY >= chartHeight - pointY;
  const placeRight = pointX <= chartWidth - pointX;
  const x = placeRight ? pointX + gap : pointX - gap - tooltipWidth;
  const y = placeAbove ? pointY - gap - tooltipHeight : pointY + gap;
  return {
    placement: `${placeAbove ? "upper" : "lower"}${placeRight ? "Right" : "Left"}`,
    x: Math.min(
      Math.max(margin, x),
      Math.max(margin, chartWidth - margin - tooltipWidth)
    ),
    y: Math.min(
      Math.max(margin, y),
      Math.max(margin, chartHeight - margin - tooltipHeight)
    ),
  };
}
