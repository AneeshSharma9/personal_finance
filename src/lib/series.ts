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
 * What a change is measured against.
 *
 * Two bases, because they answer different questions and conflating them is how
 * a dashboard ends up claiming net worth fell $4,000 "today" on the strength of a
 * year-old opening balance:
 *
 * - `day`: the reading before the latest one. "What moved since yesterday" - the
 *   daily headline, and the only basis that means anything on the morning after
 *   a single night of spending.
 * - `period`: the oldest reading on record. "What moved over everything we have".
 *
 * Both are *recorded readings*, never calendar arithmetic, so a gap in the
 * snapshots (a failed cron, a deploy) makes the change span the gap - which is
 * what actually happened to the money - rather than silently reporting $0.
 */
export type ChangeBasis = "day" | "period";

/** A measured movement, with the two readings it was measured between. */
export type SeriesChange = {
  /** The reading the change is measured from. */
  from: SeriesPoint;
  /** The reading it is measured to. */
  to: SeriesPoint;
  change: number;
};

/**
 * The change ending at `index`, on the given basis.
 *
 * Null when there is nothing to measure: a single point, or - on the `day` basis -
 * the first point, which has no reading before it. Null rather than 0, because
 * $0.00 claims the number was measured twice and did not move, which is a
 * different and much stronger claim than "there is no comparison yet".
 *
 * Index rather than a date, because the whole point of {@link nearestIndex} is
 * that these are real readings and not interpolated ones: the comparison is
 * always another point in the series.
 */
export function seriesChangeAt(
  points: SeriesPoint[],
  index: number,
  basis: ChangeBasis = "period",
): SeriesChange | null {
  if (index < 0 || index >= points.length) return null;

  const base = basis === "day" ? index - 1 : 0;
  if (base < 0 || base === index) return null;

  const from = points[base];
  const to = points[index];
  return { from, to, change: to.value - from.value };
}

/** {@link seriesChangeAt} at the newest reading. */
export function seriesChange(
  points: SeriesPoint[],
  basis: ChangeBasis = "period",
): SeriesChange | null {
  return seriesChangeAt(points, points.length - 1, basis);
}

/**
 * Whether a movement is good news.
 *
 * Null for no movement at all: a balance that did not change is neither good nor
 * bad, and answering either way is how a flat net worth ends up painted the
 * colour of bad news.
 *
 * False for `credit` and `loan`: those balances count *up* as money owed, so a
 * rise is a loss - the same rule `TrendChart`'s `risingIsGood` prop carries. The
 * type is a plain string so this stays out of the chart's import graph.
 */
export function changeIsGood(
  change: number,
  accountType: string,
): boolean | null {
  if (change === 0) return null;
  const liability = accountType === "credit" || accountType === "loan";
  return change > 0 !== liability;
}

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