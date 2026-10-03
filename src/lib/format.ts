const formatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Format a currency amount. Defaults to 2dp; use `compact` for chart axes.
 *
 * Negative amounts get an explicit minus sign rather than parentheses, which
 * reads better next to a merchant name on mobile.
 */
export function formatCurrency(
  amount: number,
  options: { compact?: boolean; showSign?: boolean } = {},
): string {
  const { compact = false, showSign = false } = options;

  if (compact) {
    const formatted = compactFormatter.format(amount);
    return showSign && amount > 0 ? `+${formatted}` : formatted;
  }

  const formatted = formatter.format(amount);
  return showSign && amount > 0 ? `+${formatted}` : formatted;
}

/** Format a percentage from a stored APR (e.g. 18.99 -> "18.99%"). */
export function formatPercent(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format what someone is typing into a money field.
 *
 * The budgeted column is an `<input>`, not a text label, so it has to be
 * re-renderable on every keystroke - which rules out the usual "format on blur,
 * strip on focus" dance that loses the caret. So this runs on each change and
 * has to be idempotent, or typing "1" then "5" would fight the cursor.
 *
 * Two details make it feel right rather than merely correct:
 *
 *  - A trailing "." survives, so "1550." stays "1550." and the decimal point can
 *    be followed by digits. Dropping it makes decimals untypable.
 *  - Fractional digits are neither padded nor truncated while typing: "1550.5"
 *    stays "1,550.5" instead of jumping to "1,550.50", which would move the caret
 *    out from under the user.
 *
 * Rejects anything that is not a digit or a dot, so a pasted "$1,2,3.00" settles
 * rather than being rejected.
 */
export function formatCurrencyInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (cleaned === "") return "";

  const firstDot = cleaned.indexOf(".");
  const hasDot = firstDot !== -1;
  const whole = hasDot ? cleaned.slice(0, firstDot) : cleaned;
  const rest = hasDot ? cleaned.slice(firstDot + 1) : "";
  // Extra dots are dropped rather than nested, so "1.2.3" reads as "1.23".
  const fraction = rest.replace(/\./g, "");

  // Leading zeros go away here too, so "0" then "5" cannot leave "05".
  const groupedWhole =
    whole === "" ? "0" : Number(whole).toLocaleString("en-US");

  /*
   * "There is a dot but nothing after it" and "there is no dot" look identical
   * from `fraction` alone, and collapsing them drops the point the user just
   * typed - which makes decimals untypable, because the "." vanishes before any
   * digit can follow it.
   */
  const body =
    fraction !== ""
      ? `${groupedWhole}.${fraction}`
      : hasDot
        ? `${groupedWhole}.`
        : groupedWhole;

  return `$${body}`;
}

/**
 * Read a money field back to a number, or null when there is nothing there.
 *
 * Null rather than 0 for an empty field: "cleared the box" and "set it to zero"
 * are different intentions, and saving 0 for the first would wipe a real budget.
 */
export function parseCurrencyInput(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.-]/g, "");
  if (cleaned === "" || /^[-.]+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Format a transaction date. Transactions are date-only in Plaid (no time), so
 * "Jan 5" is enough; the year is shown only when it differs from today.
 */
export function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Human-readable "3 hours ago" for sync timestamps. */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** First and last day of a month, as YYYY-MM-DD. */
export function monthRange(
  year: number,
  month: number,
): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 0));
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

const MONTH_NAMES_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** A resolved from/to window, with the month count needed to scale a budget. */
export type DateRange = {
  from: string;
  to: string;
  /**
   * How many calendar months the window touches.
   *
   * Not derivable from the day span, and not the same thing: January 1 to
   * September 30 is 273 days but ten monthly budgets were in play, and a budget
   * compared against the wrong multiple is worse than no comparison at all.
   */
  months: number;
  label: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `?from=&to=` window.
 *
 * Returns null for anything malformed rather than throwing or silently falling
 * back, because the caller has a sensible single-month default to use and a
 * hand-edited URL should not be able to ask for the year 10000.
 *
 * Both ends are real calendar dates - "2026-02-31" is rejected, since Postgres
 * would treat it as March 3rd and quietly show the wrong rows.
 */
export function parseDateRange(
  rawFrom: unknown,
  rawTo: unknown,
): DateRange | null {
  if (typeof rawFrom !== "string" || typeof rawTo !== "string") return null;
  if (!ISO_DATE.test(rawFrom) || !ISO_DATE.test(rawTo)) return null;

  const from = new Date(`${rawFrom}T00:00:00Z`);
  const to = new Date(`${rawTo}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  // Round-trips through the formatter, so an impossible date is caught here
  // rather than becoming a different day in the query.
  if (from.toISOString().slice(0, 10) !== rawFrom) return null;
  if (to.toISOString().slice(0, 10) !== rawTo) return null;
  if (from.getTime() > to.getTime()) return null;

  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth()) +
    1;

  return {
    from: rawFrom,
    to: rawTo,
    months,
    label: rangeLabel(from, to),
  };
}

/** "March 2026", or "January - September 2026" when the window spans months. */
function rangeLabel(from: Date, to: Date): string {
  const sameMonth =
    from.getUTCFullYear() === to.getUTCFullYear() &&
    from.getUTCMonth() === to.getUTCMonth();
  if (sameMonth) {
    return `${MONTH_NAMES_LONG[from.getUTCMonth()]} ${from.getUTCFullYear()}`;
  }

  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  const fromPart = `${MONTH_NAMES_LONG[from.getUTCMonth()]}${
    sameYear ? "" : ` ${from.getUTCFullYear()}`
  }`;
  return `${fromPart} \u2013 ${MONTH_NAMES_LONG[to.getUTCMonth()]} ${to.getUTCFullYear()}`;
}

/** Turn "FOO_BAR" or "foo bar" into "Foo Bar" for display. */
export function humanizeCategory(category: string): string {
  return category
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}