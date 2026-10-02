/**
 * Helpers for plotting a time series.
 *
 * Kept out of the chart components deliberately, and free of any chart library:
 * these are pure functions over plain data, so they can be tested directly.
 * Importing them from a component that pulls in visx would drag the whole
 * rendering stack into the test - which does not load under this project's
 * `react-server` test condition, because visx's tooltip imports react-dom.
 */

/**
 * A plotted point: a date and a value.
 *
 * Charts only ever need those two, so this is deliberately narrower than the
 * query rows they come from (`NetWorthPoint` carries assets and liabilities too).
 * Narrowing once here is what lets one chart component serve net worth, an
 * account balance and a loan balance instead of three near-identical components.
 */
export type SeriesPoint = {
  /** YYYY-MM-DD. */
  date: string;
  value: number;
};

/**
 * The recorded point closest to a target date.
 *
 * Snaps to a real reading rather than interpolating: the line between two days is
 * a drawing convenience, but a tooltip reading "$21,140" for a day that was never
 * measured would be inventing a figure the user might act on.
 *
 * Binary search on the ISO date, which is safe because `YYYY-MM-DD` sorts
 * lexicographically in the same order as chronologically. Takes only the dates,
 * so it works for any series shape.
 *
 * -1 when there are no points. Callers check it rather than being trusted to: an
 * out-of-range index here renders *something*, which is how a wrong figure gets
 * on screen without an error.
 */
export function nearestIndex(
  points: { date: string }[],
  target: Date,
): number {
  if (points.length === 0) return -1;
  if (points.length === 1) return 0;

  const iso = target.toISOString().slice(0, 10);

  // First index whose date is >= iso.
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle].date < iso) low = middle + 1;
    else high = middle;
  }

  // Before the first snapshot: the first one is the only candidate.
  if (low === 0) return 0;

  const before = low - 1;
  const after = Math.min(low, points.length - 1);
  const at = target.getTime();
  const gapBefore = Math.abs(at - Date.parse(`${points[before].date}T00:00:00Z`));
  const gapAfter = Math.abs(Date.parse(`${points[after].date}T00:00:00Z`) - at);

  // Ties go to the earlier day: arbitrary, but stable as the pointer moves.
  return gapBefore <= gapAfter ? before : after;
}