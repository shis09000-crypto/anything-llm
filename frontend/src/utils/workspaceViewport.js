function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Resolve the browser's currently visible frame. visualViewport is the only
 * reliable source while a tablet software keyboard is open; innerHeight is
 * retained as the layout-frame baseline for the keyboard inset.
 */
export function resolveWorkspaceViewportFrame(targetWindow) {
  const viewport = targetWindow?.visualViewport;
  const layoutHeight = positiveNumber(
    targetWindow?.innerHeight,
    positiveNumber(targetWindow?.document?.documentElement?.clientHeight, 1)
  );
  const height = positiveNumber(viewport?.height, layoutHeight);
  const offsetTop = Math.max(0, Number(viewport?.offsetTop) || 0);
  const keyboardInset = Math.max(
    0,
    layoutHeight - Math.min(layoutHeight, height + offsetTop)
  );

  return {
    height: Math.max(1, Math.round(height)),
    offsetTop: Math.round(offsetTop),
    keyboardInset: Math.round(keyboardInset),
  };
}
