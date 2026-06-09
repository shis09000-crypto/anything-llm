export interface AssetAllocationItem {
  symbol: string;
  name?: string;
  nameCn?: string;
  color: string;
  valueUsd: string;
  percentage: string;
  amount?: string;
  priceUsd?: string;
  change24hPct?: string | null;
}

export interface AssetAllocationDonutCardProps {
  title?: string;
  totalValueUsd: string;
  items: AssetAllocationItem[];
  maxVisibleItems?: number;
  selectedAsset?: string | null;
  onSelectAsset?: (symbol: string | null) => void;
  showFooterNote?: boolean;
  cardWidth?: number;
  cardHeight?: number;
  borderRadius?: number;
  donutSize?: number;
  donutThickness?: number;
  glowIntensity?: number;
  dimInactiveOnFocus?: boolean;
  compactMode?: boolean;
}
