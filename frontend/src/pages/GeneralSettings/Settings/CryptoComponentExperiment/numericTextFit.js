export function computeAutoFitFontSize({
  availableWidth,
  contentWidth,
  defaultFontSize,
  minimumFontSize = 6,
}) {
  const available = Number(availableWidth);
  const content = Number(contentWidth);
  const preferred = Number(defaultFontSize);
  const minimum = Math.max(1, Number(minimumFontSize) || 6);

  if (
    !Number.isFinite(available) ||
    !Number.isFinite(content) ||
    !Number.isFinite(preferred) ||
    available <= 0 ||
    content <= 0 ||
    preferred <= 0
  ) {
    return Math.max(minimum, preferred || minimum);
  }

  if (content <= available) return preferred;

  return Math.max(minimum, preferred * (available / content));
}
