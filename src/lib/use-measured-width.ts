"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Measure an element's width with a ResizeObserver.
 *
 * Charts need real pixels to place an HTML tooltip correctly: a fixed `viewBox`
 * scales the drawing to fit, but an HTML overlay does not scale with it, so the
 * two drift apart at any width other than the one they were designed for.
 *
 * `fallback` is what the server renders with, and it matters. A hook that
 * started at 0 would server-render an empty chart and then fill in on mount,
 * which reads as a broken page for a frame; seeding with a realistic width means
 * the markup that arrives is already a chart and the measurement only corrects
 * it. `MAX_WIDTH` is the page container this currently lives in.
 */
export function useMeasuredWidth(fallback: number, max = 900) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(Math.min(fallback, max));

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      const next = element.clientWidth;
      // 0 on a hidden or not-yet-laid-out element; keeping the last good value
      // stops the chart collapsing to nothing.
      if (next > 0) setWidth(Math.min(next, max));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [max]);

  return { ref, width };
}