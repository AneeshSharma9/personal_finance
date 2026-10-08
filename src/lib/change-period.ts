/**
 * Which period an account's change is measured over, and where that choice lives.
 *
 * The selection is a URL parameter rather than client state, for the same reason
 * `CashFlowPeriod` and `MonthStrip` are: the server can answer the question, the
 * view stays shareable, and it works with JavaScript off. See
 * `src/components/cash-flow-period.tsx`.
 *
 * The periods are a fixed list rather than a free date range on purpose. Balances
 * are recorded once a day by the nightly job, so every window is really "the last
 * N recorded days" and a hand-typed start date cannot ask for anything the data
 * does not have - it can only ask for a day with no reading in it.
 */

import { changeIsGood, type ChangeBasis } from "@/lib/series";

/**
 * "All time" has no lower bound, so it is given the earliest date Postgres will
 * compare rather than a NULL branch in the query.
 *
 * Not `'-infinity'`: that is a real timestamp, and this column is a `date`, so it
 * would be a cast that happens to work today rather than a value that means what
 * it says.
 */
export const BEGINNING_OF_TIME = "0001-01-01";

export type ChangePeriod = {
  /** URL value for `?change=`. */
  id: string;
  /** Button text. */
  label: string;
  /**
   * Which recorded reading the change is measured from.
   *
   * `previous` rather than a window for the one-day case: the cron's last run may
   * have missed, so "yesterday" is a guess about the calendar while "the reading
   * before the newest one" is a fact about the data. The caption still prints that
   * date, so a three-day gap says so instead of hiding behind "yesterday".
   */
  basis: ChangeBasis;
  /**
   * How many days back the window reaches, or null for the whole record.
   *
   * Null on the one-day entry is *not* "the whole record" - `changePeriodWindow`
   * reads `basis` first and widens the day option to a two-day floor. Read this
   * through {@link changePeriodWindow}, never on its own.
   */
  days: number | null;
};

/**
 * Ordered shortest first, with "All time" last.
 *
 * "Previous day" leads because it is the question the dashboard asks on every
 * visit; the rest are there for when a single night is not what you want to know
 * about.
 */
export const CHANGE_PERIODS: ChangePeriod[] = [
  { id: "1d", label: "Previous day", basis: "day", days: null },
  { id: "1w", label: "7 days", basis: "period", days: 7 },
  { id: "1m", label: "30 days", basis: "period", days: 30 },
  { id: "3m", label: "90 days", basis: "period", days: 90 },
  { id: "1y", label: "1 year", basis: "period", days: 365 },
  { id: "all", label: "All time", basis: "period", days: null },
];

/**
 * "Previous day", for the same reason it leads the list.
 *
 * It used to be the whole record, on the argument that "All time" is the one
 * answer that can never be wrong about which window it is describing. True, and
 * not what anyone opening these pages is asking - the picker is right there, so
 * the widest window is never more than one click away, while defaulting to it
 * means the common case has to be corrected every visit.
 *
 * The default is the shortest period rather than a named one so that reordering
 * `CHANGE_PERIODS` cannot silently change what a bare URL means.
 */
export const DEFAULT_CHANGE_PERIOD = CHANGE_PERIODS[0]!;

/**
 * The periods a chart page offers.
 *
 * All of them, including "Previous day". An earlier version dropped that one,
 * on the reasoning that a one-day window is a single reading - which was wrong.
 * The window's floor is *inclusive*, so yesterday and today both fall inside a
 * one-day window and daily data yields exactly the two readings the day-over-day
 * change needs. The option only produces a single point when the cron actually
 * missed a day, and `TrendChart` says so in that case.
 *
 * So there is one list, used by every page, rather than two that have to be kept
 * in step.
 */
export const CHANGE_PERIODS_WITH_WINDOW = CHANGE_PERIODS;

/**
 * Resolve `?change=` to a known period.
 *
 * Falls back to the default for a missing or unrecognised value rather than
 * throwing or rendering nothing - a hand-edited URL should not be able to ask
 * the accounts page for a window that does not exist.
 */
export function parseChangePeriod(raw: unknown): ChangePeriod {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return DEFAULT_CHANGE_PERIOD;
  return CHANGE_PERIODS.find((period) => period.id === value) ?? DEFAULT_CHANGE_PERIOD;
}

/**
 * `parseChangePeriod`, named for the chart pages.
 *
 * An alias, and that is deliberate. It used to reject the day basis, on the
 * reasoning that a one-day window is a single reading - which was wrong, because
 * the window's floor is inclusive (see {@link changePeriodWindow}). Every period
 * can now be charted, so this resolves exactly like {@link parseChangePeriod}; it
 * stays as a separate name so the call sites still say what they are asking for,
 * and so changing that would be a deliberate act rather than an edit to the parser
 * every page shares.
 */
export function parseChartPeriod(raw: unknown): ChangePeriod {
  return parseChangePeriod(raw);
}

/** `n` days before `today`, as YYYY-MM-DD. */
export function daysAgo(n: number, today: Date = new Date()): string {
  return new Date(today.getTime() - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * How much history a page shows when nobody has chosen a period.
 *
 * A year, matching what `/net-worth` used to plot unconditionally. Expressed as
 * days rather than a row count so it means the same thing as every other window
 * here.
 */
export const DEFAULT_HISTORY_DAYS = 365;

/**
 * The earliest date a period's window includes, as YYYY-MM-DD.
 *
 * Counts backwards from `today` rather than from the newest snapshot, because a
 * window that is anchored to a stale reading quietly narrows itself: with the last
 * snapshot three days old, a "30 days" window anchored to it covers 27.
 */
export function changePeriodFrom(
  period: ChangePeriod,
  today: Date = new Date(),
): string {
  if (period.days === null) return BEGINNING_OF_TIME;
  return daysAgo(period.days, today);
}

/**
 * The earliest snapshot a period's chart should plot, or `undefined` for all of
 * them.
 *
 * This is a **date**, not a count of readings, and that distinction is the whole
 * point. Counting readings looks equivalent on a chart where the cron ran every
 * day - and quietly isn't the moment it missed one: "30 days" expressed as thirty
 * rows then covers five weeks, while the same window expressed as a date still
 * covers thirty days and simply shows fewer points. A period selector has to mean
 * what its label says, and a label in days can only be honoured by a date.
 *
 * Undefined for "All time": an unbounded query says "no bound" honestly, where
 * `BEGINNING_OF_TIME` would say it with a magic date.
 *
 * **The one-day basis uses a two-day floor, and that is deliberate.** The floor is
 * inclusive, so a floor of *yesterday* would put yesterday and today in the window
 * - exactly the pair the day-over-day change is measured between, and the honest
 * reading of the label. It was that, until the two facts below turned out to
 * combine badly:
 *
 *   - the day rolls over at **UTC** midnight, which is 8pm in New York; and
 *   - the nightly cron writes at **12:34 UTC** (`0 12 * * *`, and on Vercel Hobby
 *     that can be any minute in the hour), which is 8:34am in New York.
 *
 * So for the twelve and a half hours between those two, "yesterday" held exactly
 * one reading - the day's own, written the previous lunchtime - and the chart said
 * "No graph data available" on the option most likely to be opened. Two days of
 * floor puts two readings in the window at every hour of the day.
 *
 * The cost, stated plainly: between UTC midnight and the cron, the newest reading
 * in the window is yesterday's, so the graph draws yesterday against the day
 * before rather than against today. The alternative was an empty chart for half of
 * every day, which is the failure that actually stops someone reading the figure.
 */
export function changePeriodWindow(
  period: ChangePeriod,
  today: Date = new Date(),
): string | undefined {
  if (period.basis === "day") return daysAgo(2, today);
  return period.days === null ? undefined : daysAgo(period.days, today);
}

/** One recorded balance, or null for an account with nothing recorded yet. */
export type BalanceReading = {
  /** YYYY-MM-DD. */
  date: string;
  value: number;
};

/**
 * One account's part of the breakdown: its latest recorded balance, and the two
 * readings a change could be measured against.
 *
 * Both baselines come back from the query rather than being picked here, because
 * choosing between them is a display decision (the period selector) while finding
 * them is a query.
 */
export type AccountChangeRow = {
  accountId: number;
  /** What to show: the user's name for the account if they set one. */
  name: string;
  /** Plaid's name for it, so a renamed account can still reveal what it is. */
  plaidName: string;
  institutionName: string | null;
  mask: string | null;
  /** `tables.AccountType`. A plain string so this stays out of the db graph. */
  type: string;
  /** Newest recorded reading. Null until the cron has run for this account. */
  latest: BalanceReading | null;
  /** The recorded reading immediately before `latest`. */
  previous: BalanceReading | null;
  /** Oldest recorded reading inside the period's window. */
  windowStart: BalanceReading | null;
};

/** A row with the change resolved, ready to render. */
export type ResolvedAccountChange = AccountChangeRow & {
  /** Null when the account has nothing recorded, or nothing to compare against. */
  change: number | null;
  /** The reading the change is measured from; null alongside a null change. */
  from: BalanceReading | null;
  /** Whether the movement is good news. Null when there is no movement. */
  good: boolean | null;
};

/**
 * Pick the baseline for a period and measure the change.
 *
 * The one-day basis deliberately ignores the window and uses `previous`, and the
 * period basis ignores `previous`. Both are recorded days; a window that happened
 * to contain a single reading would otherwise report a flat $0.00, which reads
 * as "nothing moved" rather than "we only know one figure".
 */
export function resolveAccountChange(
  row: AccountChangeRow,
  period: ChangePeriod,
): ResolvedAccountChange {
  const latest = row.latest;

  /*
   * In preference order, and the first reading on a genuinely earlier day wins.
   *
   * The same-day test is the awkward part and it matters: a window narrow enough
   * to hold one reading would otherwise make the change a flat $0.00, which reads
   * as "nothing moved" rather than "we only know one figure". Falling through to
   * `previous` gives the nearest real comparison instead, and says its date.
   */
  const candidates =
    period.basis === "day"
      ? [row.previous, row.windowStart]
      : [row.windowStart, row.previous];
  const from =
    latest === null
      ? null
      : (candidates.find(
          (candidate) => candidate !== null && candidate.date !== latest.date,
        ) ?? null);

  const change =
    latest === null || from === null ? null : latest.value - from.value;

  return {
    ...row,
    from,
    change,
    good: change === null ? null : changeIsGood(change, row.type),
  };
}

function isLiability(type: string): boolean {
  return type === "credit" || type === "loan";
}

/**
 * Split rows into the two groups the breakdown renders separately.
 *
 * Exported because the sign of a change only means something inside a group: a
 * card's balance rising is debt growing, while savings rising is money growing,
 * and interleaving them reads as a contradiction.
 */
export function splitByLiability<T extends { type: string }>(
  rows: T[],
): { assets: T[]; liabilities: T[] } {
  return {
    assets: rows.filter((row) => !isLiability(row.type)),
    liabilities: rows.filter((row) => isLiability(row.type)),
  };
}