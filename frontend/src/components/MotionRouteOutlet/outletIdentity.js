function outletChild(outlet) {
  if (!outlet || typeof outlet !== "object") return undefined;
  return outlet.props?.children;
}

/**
 * React Router's useOutlet() always returns an OutletContext.Provider wrapper.
 * Comparing only the wrapper type and key therefore treats two different route
 * trees as the same outlet. This is especially dangerous when a POP navigation
 * resolves its lazy route after the location has already changed: the old heavy
 * screen can remain mounted until a full reload.
 *
 * The provider's child is the stable route-tree identity. It stays referentially
 * equal during unrelated renders, but changes when React Router publishes the
 * resolved route for the current history entry.
 */
export function isSameRouteOutlet(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type || left.key !== right.key) return false;

  const leftChild = outletChild(left);
  const rightChild = outletChild(right);
  if (leftChild === undefined && rightChild === undefined) return true;
  return leftChild === rightChild;
}
