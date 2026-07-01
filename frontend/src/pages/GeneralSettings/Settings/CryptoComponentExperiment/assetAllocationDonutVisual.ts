export const assetAllocationDonutDefaultVisual = {
  maxVisibleItems: 6,
  cardWidth: 560,
  cardHeight: 310,
  donutSize: 190,
  donutThickness: 44,
  borderRadius: 22,
  glowIntensity: 0.45,
  showFooterNote: true,
  dimInactiveOnFocus: true,
  compactMode: true,
};

export type AssetAllocationDonutVisualParams =
  typeof assetAllocationDonutDefaultVisual;

export const assetAllocationDonutVisualBounds = {
  maxVisibleItems: [2, 8],
  cardWidth: [420, 1120],
  cardHeight: [260, 760],
  donutSize: [150, 440],
  donutThickness: [30, 110],
  borderRadius: [16, 42],
  glowIntensity: [0, 1],
} satisfies Record<
  keyof Omit<
    AssetAllocationDonutVisualParams,
    "showFooterNote" | "dimInactiveOnFocus" | "compactMode"
  >,
  [number, number]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberValue(
  value: unknown,
  fallback: number,
  [min, max]: [number, number]
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function sanitizeAssetAllocationDonutVisual(
  value: unknown
): AssetAllocationDonutVisualParams {
  const source = isRecord(value) ? value : {};
  return {
    maxVisibleItems: numberValue(
      source.maxVisibleItems,
      assetAllocationDonutDefaultVisual.maxVisibleItems,
      assetAllocationDonutVisualBounds.maxVisibleItems
    ),
    cardWidth: numberValue(
      source.cardWidth,
      assetAllocationDonutDefaultVisual.cardWidth,
      assetAllocationDonutVisualBounds.cardWidth
    ),
    cardHeight: numberValue(
      source.cardHeight,
      assetAllocationDonutDefaultVisual.cardHeight,
      assetAllocationDonutVisualBounds.cardHeight
    ),
    donutSize: numberValue(
      source.donutSize,
      assetAllocationDonutDefaultVisual.donutSize,
      assetAllocationDonutVisualBounds.donutSize
    ),
    donutThickness: numberValue(
      source.donutThickness,
      assetAllocationDonutDefaultVisual.donutThickness,
      assetAllocationDonutVisualBounds.donutThickness
    ),
    borderRadius: numberValue(
      source.borderRadius,
      assetAllocationDonutDefaultVisual.borderRadius,
      assetAllocationDonutVisualBounds.borderRadius
    ),
    glowIntensity: numberValue(
      source.glowIntensity,
      assetAllocationDonutDefaultVisual.glowIntensity,
      assetAllocationDonutVisualBounds.glowIntensity
    ),
    showFooterNote: booleanValue(
      source.showFooterNote,
      assetAllocationDonutDefaultVisual.showFooterNote
    ),
    dimInactiveOnFocus: booleanValue(
      source.dimInactiveOnFocus,
      assetAllocationDonutDefaultVisual.dimInactiveOnFocus
    ),
    compactMode: booleanValue(
      source.compactMode,
      assetAllocationDonutDefaultVisual.compactMode
    ),
  };
}
