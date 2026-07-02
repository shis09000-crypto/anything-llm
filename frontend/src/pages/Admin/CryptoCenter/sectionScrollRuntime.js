export function cryptoSectionScrollEnabled({
  desktopWidthMatches = false,
  tabletWidthMatches = false,
  finePointer = false,
  tabletDesktop = false,
  reducedMotion = false,
} = {}) {
  if (reducedMotion) return false;
  if (finePointer && desktopWidthMatches) return true;
  return tabletDesktop && tabletWidthMatches;
}
