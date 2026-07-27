export const MOBILE_COMPOSER_FALLBACK_INSET = 116;
export const MOBILE_COMPOSER_MIN_INSET = 72;

export function normalizeMobileComposerInset(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return MOBILE_COMPOSER_FALLBACK_INSET;
  }

  return Math.max(MOBILE_COMPOSER_MIN_INSET, Math.ceil(numericValue));
}

export function mobileChatPanePaddingBottom(value) {
  const inset = normalizeMobileComposerInset(value);
  return `calc(${inset}px + var(--mobile-keyboard-inset, 0px) + 12px)`;
}

export function mobileNewMessageButtonBottom(value) {
  const inset = normalizeMobileComposerInset(value);
  return `calc(${inset}px + var(--mobile-keyboard-inset, 0px) + 8px)`;
}
