/**
 * Scroll geometry for the budgets page month strip.
 *
 * Pure and free of React on purpose. This started as CSS scroll-snap, failed, then
 * failed again as `scrollIntoView`, and the working version needs arithmetic that
 * can be tested - which a `"use client"` module cannot be, because the test runner
 * resolves React through the `react-server` condition and gets a build with no
 * `createContext`.
 *
 * Both failures were the same shape: a tile can only snap flush to its *start* edge,
 * so the last tiles' snap positions sit beyond `maxScroll` and are unreachable.
 * Twelve 72px tiles with an 8px gap is 952px of content, and at every container
 * width narrow enough to scroll at all, December's snap point is past the end.
 * Mandatory snapping then had no valid target and left the tile wherever the
 * programmatic scroll happened to leave it - half cut off.
 *
 * `tests/month-strip-scroll.test.mts` pins this across a spread of widths, because
 * it only misbehaves for the last few tiles at particular widths, which is the range
 * nobody checks by hand.
 */

/** Tile width plus the gap between tiles. */
export type StripGeometry = {
  /** A tile's left edge within the scroller's content, in pixels. */
  tileLeft: number;
  tileWidth: number;
  /** Where the strip is now. */
  currentScroll: number;
  /** The scroller's visible width. */
  viewWidth: number;
  /** Total scrollable content width. */
  contentWidth: number;
  stride: number;
};

/**
 * Where the strip should sit for a tile to be fully visible, flush to whichever
 * edge it is nearer.
 *
 * Assumes the scroller's content box starts at 0, which holds because the strip
 * has no inline padding - only `pb-1`.
 */
export function stripScrollTarget({
  tileLeft,
  tileWidth,
  currentScroll,
  viewWidth,
  contentWidth,
  stride,
}: StripGeometry): number {
  if (stride <= 0) return currentScroll;

  // A gap's width of breathing room, so a tile stopping at an edge is not jammed
  // against its neighbour.
  const gap = Math.max(stride - tileWidth, 0);
  const tileRight = tileLeft + tileWidth;
  const max = Math.max(contentWidth - viewWidth, 0);

  /*
   * The positions from which this tile is fully visible, as a band rather than a
   * point: anything at or past `tileRight + gap` leaves it whole at the right, and
   * anything at or before `tileLeft - gap` parks it flush at the left.
   *
   * Using a band is the whole fix. Rounding a single computed position to the
   * nearest boundary can round *away* from the scroll the tile needs and put it back
   * off screen - at a 700px container, September needs 20px of scroll, which rounds
   * to 0, which cuts its last 12px off again. That is this bug, third form.
   */
  /*
   * Two bands, widest first.
   *
   * `visible` is every scroll position that shows the tile whole. `roomy` is the
   * subset that also keeps a gap's breathing room at whichever edge the tile stops
   * against. Prefer `roomy`; fall back to `visible`; and never round out of
   * `visible`, because a position that shows the tile is worth more than a position
   * that lands on a tidy boundary.
   *
   * The fallback is not optional. With a 700px container, December needs the strip
   * at 252px to be fully visible, the gap would need 260px, and only 252px exists -
   * so rounding 260 down to the nearest boundary gave 240 and cut 12px off the tile
   * again. Rounding is only safe inside a band that is already known to be valid.
   */
  /*
   * Already where it should be: the tile is whole with room to spare at the current
   * position, so leave the strip alone.
   *
   * Without this the band search below is still free to answer "80" when the honest
   * answer is "stay put" - it picks the boundary nearest the current scroll, and
   * "nearest" to zero is not always zero once zero itself is excluded for lack of a
   * gap. Revealing a month the user can already see should be a no-op.
   */
  if (
    tileLeft - gap >= currentScroll &&
    tileRight + gap <= currentScroll + viewWidth
  ) {
    return currentScroll;
  }

  const visibleLo = Math.max(tileRight - viewWidth, 0);
  const visibleHi = Math.min(tileLeft, max);

  // The tile is wider than the view, or the scroll range cannot show it at all.
  // Nothing to choose between, so leave the strip alone rather than hide the tile.
  if (visibleLo > visibleHi) return Math.max(0, Math.min(currentScroll, max));

  const roomyLo = Math.max(visibleLo + gap, 0);
  const roomyHi = Math.min(visibleHi - gap, max);
  if (roomyLo <= roomyHi) {
    return nearestBoundaryInBand(currentScroll, roomyLo, roomyHi, stride);
  }

  return nearestBoundaryInBand(currentScroll, visibleLo, visibleHi, stride);
}

/**
 * The multiple of `stride` nearest to `want` that lies within `[lo, hi]`.
 *
 * When the band is narrower than the stride there may be no boundary inside it at
 * all, and forcing one would break visibility - so the position is simply clamped
 * into the band and left off-boundary. Landing between two tiles is a far smaller
 * problem than a cut-off month.
 */
function nearestBoundaryInBand(
  want: number,
  lo: number,
  hi: number,
  stride: number,
): number {
  const candidates: number[] = [];
  for (const at of [Math.floor(hi / stride) * stride, Math.ceil(lo / stride) * stride]) {
    if (at >= lo - 0.001 && at <= hi + 0.001 && !candidates.includes(at)) {
      candidates.push(at);
    }
  }
  if (candidates.length === 0) return Math.max(lo, Math.min(want, hi));
  return candidates.reduce((best, at) =>
    Math.abs(at - want) < Math.abs(best - want) ? at : best,
  );
}

/**
 * Where the strip should settle after the user stops dragging: the nearest tile
 * boundary, clamped to somewhere reachable.
 *
 * Deliberately knows nothing about which month is selected.
 *
 * An earlier version took the selected tile and refused to settle on a boundary
 * that clipped it. That was defensible on paper — "the selected month is always
 * fully visible" — and wrong in use: a free drag is supposed to be free, and
 * because the selected month is usually off-screen while you are browsing, the
 * settle spent its time hauling the strip back to it. It read as the strip fighting
 * you and springing back the moment you let go.
 *
 * Selection is the reveal's job, and the reveal runs on the month changing. A drag
 * moves the viewport; it does not re-select anything.
 */
export function stripSnapPosition({
  left,
  viewWidth,
  contentWidth,
  stride,
}: Omit<StripGeometry, "tileLeft" | "tileWidth" | "currentScroll"> & {
  left: number;
}): number {
  if (stride <= 0) return 0;
  const max = Math.max(contentWidth - viewWidth, 0);

  const boundary = Math.max(0, Math.min(Math.round(left / stride) * stride, max));

  /*
   * The end of the strip is a resting place too, not just a limit.
   *
   * `maxScroll` is rarely a whole number of strides from zero - 352px for a 600px
   * container - so rounding always stopped short of it and the last tile could never
   * sit flush right at rest. Dragging to the end and letting go left December clipped
   * by 32px with no way to scroll further, which is the same symptom as the reveal
   * bug arriving by a different route.
   *
   * Whichever of the two is nearer to where the drag ended wins, so the end is
   * reachable without turning the whole strip magnetic towards it.
   */
  return Math.abs(max - left) < Math.abs(boundary - left) ? max : boundary;
}

/** True when `[tileLeft, tileLeft + tileWidth]` sits entirely inside the view. */
export function stripTileIsVisible({
  tileLeft,
  tileWidth,
  scroll,
  viewWidth,
}: {
  tileLeft: number;
  tileWidth: number;
  scroll: number;
  viewWidth: number;
}): boolean {
  return (
    tileLeft >= scroll - 0.5 && tileLeft + tileWidth <= scroll + viewWidth + 0.5
  );
}
