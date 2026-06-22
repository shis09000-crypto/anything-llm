import { useEffect, useRef } from "react";

export function isElementFullyOrPartiallyVisible(element, container) {
  if (!element || !container) return true;
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return (
    elementRect.bottom > containerRect.top &&
    elementRect.top < containerRect.bottom &&
    elementRect.right > containerRect.left &&
    elementRect.left < containerRect.right
  );
}

function nearestScrollableContainer(element) {
  let current = element?.parentElement || null;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY || style.overflow;
    if (/(auto|scroll|overlay)/.test(overflowY)) return current;
    current = current.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Hook that scrolls an element into view when it becomes active.
 * @param {Object} options - The options for the hook.
 * @param {boolean} options.isActive - Whether the element is currently active.
 * @param {"smooth" | "instant" | "auto"} options.behavior - The scroll behavior.
 * @param {"start" | "center" | "end" | "nearest"} options.block - The vertical alignment of the element within the scrollable container.
 * @returns {{ ref: React.RefObject<HTMLElement> }} An object containing the ref to attach to the target element.
 */
export default function useScrollActiveItemIntoView({
  isActive,
  behavior = "instant",
  block = "nearest",
}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!isActive || !ref.current) return;
    const container = nearestScrollableContainer(ref.current);
    if (isElementFullyOrPartiallyVisible(ref.current, container)) return;
    ref.current.scrollIntoView({ behavior, block: "nearest" });
  }, [behavior, block, isActive]);

  return {
    ref,
  };
}
