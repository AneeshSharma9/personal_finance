/**
 * The visible window onto a chart, and how it moves.
 *
 * Pure and separate from the component because the interesting part is not the
 * mouse handling - it is that a zoom has to keep the point you aimed at under the
 * pointer, and that neither control is allowed to fling the chart into the void
 * where you cannot find it again. Both are easy to get subtly wrong and neither
 * can be checked by looking at a screenshot.
 */

export type ViewBox = {
  x: number;
  y: number;
  /** Width of the window in drawing units. */
  w: number;
  h: number;
};

export type Size = { w: number; h: number };

/** How far in or out a single control press moves. */
const ZOOM_STEP = 1.25;
/** A wheel notch is smaller than a button press; trackpads emit many. */
const WHEEL_ZOOM_STEP = 1.12;
/** Below this the text is unreadable, so stop. */
const MIN_SCALE = 0.5;
/** Above this there is nothing left to magnify. */
const MAX_SCALE = 6;

/**
 * Keep a window inside the drawing.
 *
 * Two cases, and the second is the one that is easy to miss: once the window is
 * wider than the drawing it cannot be "inside" anything, so it is centred rather
 * than pinned to an edge. Pinning would leave a sliver of chart on one side and
 * empty space on the other.
 */
export function clampView(view: ViewBox, limit: Size): ViewBox {
  const clampAxis = (position: number, size: number, total: number): number => {
    if (size >= total) return (total - size) / 2;
    return Math.min(Math.max(position, 0), total - size);
  };

  return {
    ...view,
    x: clampAxis(view.x, view.w, limit.w),
    y: clampAxis(view.y, view.h, limit.h),
  };
}

/**
 * Zoom about a point, so the thing under the cursor stays under the cursor.
 *
 * Zooming about the centre instead is the classic bug: the point you aimed at
 * slides out from under the pointer exactly when you are trying to line a small
 * bar up with its label.
 *
 * Aspect ratio is preserved, because the chart's height is derived from its
 * width and a mismatched window would letterbox it.
 */
export function zoomView(
  view: ViewBox,
  factor: number,
  focus: { x: number; y: number },
  limit: Size,
): ViewBox {
  if (!Number.isFinite(factor) || factor <= 0) return view;

  const currentScale = limit.w / view.w;
  const nextScale = Math.min(Math.max(currentScale * factor, MIN_SCALE), MAX_SCALE);
  const ratio = nextScale / currentScale;
  if (ratio === 1) return view;

  const nextW = limit.w / nextScale;
  const nextH = limit.h / nextScale;

  // Where the focus point sits inside the current window, as a fraction.
  const fx = (focus.x - view.x) / view.w;
  const fy = (focus.y - view.y) / view.h;

  return clampView(
    {
      x: focus.x - fx * nextW,
      y: focus.y - fy * nextH,
      w: nextW,
      h: nextH,
    },
    limit,
  );
}

/** Move the window by a delta in drawing units. */
export function panView(view: ViewBox, dx: number, dy: number, limit: Size): ViewBox {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, limit);
}

/** The whole drawing, which is what "fit" means. */
export function fitView(limit: Size): ViewBox {
  return { x: 0, y: 0, ...limit };
}

export { ZOOM_STEP, WHEEL_ZOOM_STEP, MIN_SCALE, MAX_SCALE };