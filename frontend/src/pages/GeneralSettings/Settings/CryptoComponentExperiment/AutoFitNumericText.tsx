import React, { useLayoutEffect, useRef } from "react";
import { computeAutoFitFontSize } from "./numericTextFit";

type AutoFitNumericTextProps = {
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  minimumFontSize?: number;
  style?: React.CSSProperties;
  title?: string;
};

function inlineFontSize(value: React.CSSProperties["fontSize"]) {
  if (typeof value === "number") return `${value}px`;
  return value || "";
}

export default function AutoFitNumericText({
  children,
  className = "",
  containerClassName = "",
  minimumFontSize = 6,
  style,
  title,
}: AutoFitNumericTextProps) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return undefined;

    let frame = 0;
    const preferredInlineSize = inlineFontSize(style?.fontSize);

    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        content.style.fontSize = preferredInlineSize;
        const preferred = Number.parseFloat(
          window.getComputedStyle(content).fontSize
        );
        const available = container.clientWidth;
        const naturalWidth = content.scrollWidth;
        const fitted = computeAutoFitFontSize({
          availableWidth: available,
          contentWidth: naturalWidth,
          defaultFontSize: preferred,
          minimumFontSize,
        });

        content.style.fontSize =
          fitted < preferred - 0.1 ? `${fitted}px` : preferredInlineSize;
      });
    };

    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(container);

    if (document.fonts?.ready)
      document.fonts.ready.then(measure).catch(() => {});

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [children, minimumFontSize, style?.fontSize]);

  const fallbackTitle =
    typeof children === "string" || typeof children === "number"
      ? String(children)
      : undefined;

  return (
    <span
      ref={containerRef}
      className={`block min-w-0 max-w-full ${containerClassName}`}
      title={title ?? fallbackTitle}
    >
      <span
        ref={contentRef}
        className={`inline-block max-w-none whitespace-nowrap ${className}`}
        style={style}
      >
        {children}
      </span>
    </span>
  );
}
