function normalizeDecimal(value) {
  const raw = String(value ?? "0").trim();
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [integerPart = "0", fractionPart = ""] = unsigned.split(".");
  const integer = integerPart.replace(/\D/g, "") || "0";
  const fraction = fractionPart.replace(/\D/g, "");

  return {
    negative,
    integer,
    fraction,
  };
}

function toScaledInt(value, scale = 8) {
  const { negative, integer, fraction } = normalizeDecimal(value);
  const paddedFraction = `${fraction}${"0".repeat(scale)}`.slice(0, scale);
  const number = BigInt(`${integer}${paddedFraction}` || "0");
  return negative ? -number : number;
}

function formatScaledInt(value, scale = 8, decimals = scale) {
  const negative = value < 0n;
  const raw = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const integer = raw / divisor;
  const fraction = String(raw % divisor).padStart(scale, "0");
  const normalizedDecimals = Math.max(0, Math.min(decimals, scale));
  const visibleFraction = fraction.slice(0, normalizedDecimals);
  const suffix = normalizedDecimals ? `.${visibleFraction}` : "";
  return `${negative ? "-" : ""}${integer}${suffix}`;
}

function trimDecimal(value) {
  if (!String(value).includes(".")) return String(value);
  return String(value)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function divideRounded(numerator, denominator) {
  if (denominator === 0n) return 0n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const shouldRound = absRemainder * 2n >= absDenominator;
  if (!shouldRound) return quotient;

  const sameSign =
    (numerator >= 0n && denominator >= 0n) ||
    (numerator < 0n && denominator < 0n);
  return quotient + (sameSign ? 1n : -1n);
}

function addDecimalStrings(values = [], { scale = 12, decimals = 8 } = {}) {
  const total = values.reduce(
    (sum, value) => sum + toScaledInt(value, scale),
    0n
  );
  return trimDecimal(formatScaledInt(total, scale, decimals));
}

function multiplyDecimalStrings(
  left,
  right,
  { leftScale = 12, rightScale = 8, decimals = 2 } = {}
) {
  const product = toScaledInt(left, leftScale) * toScaledInt(right, rightScale);
  const sourceScale = leftScale + rightScale;
  const targetScale = decimals;
  const divisor = 10n ** BigInt(sourceScale - targetScale);
  const rounded = divideRounded(product, divisor);
  return formatScaledInt(rounded, targetScale, decimals);
}

function weightedAverageDecimalStrings(
  rows = [],
  { amountScale = 12, priceScale = 8, decimals = 2 } = {}
) {
  let weightedPriceSum = 0n;
  let amountSum = 0n;

  for (const row of rows) {
    const amount = toScaledInt(row.amount, amountScale);
    const price = toScaledInt(row.price, priceScale);
    if (amount <= 0n || price <= 0n) continue;
    amountSum += amount;
    weightedPriceSum += amount * price;
  }

  if (amountSum <= 0n) return null;

  const averagePriceScaled = divideRounded(weightedPriceSum, amountSum);
  const output =
    priceScale > decimals
      ? divideRounded(averagePriceScaled, 10n ** BigInt(priceScale - decimals))
      : averagePriceScaled * 10n ** BigInt(decimals - priceScale);
  return formatScaledInt(output, decimals, decimals);
}

module.exports = {
  addDecimalStrings,
  divideRounded,
  formatScaledInt,
  multiplyDecimalStrings,
  toScaledInt,
  trimDecimal,
  weightedAverageDecimalStrings,
};
