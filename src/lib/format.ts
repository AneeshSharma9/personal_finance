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

/** Turn "FOO_BAR" or "foo bar" into "Foo Bar" for display. */
export function humanizeCategory(category: string): string {
  return category
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}