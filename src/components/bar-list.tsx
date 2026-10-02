import Link from "next/link";

import { formatCurrency } from "@/lib/format";

/**
 * A ranked bar list: one measure across a handful of named things.
 *
 * Deliberately HTML rather than SVG. Every bar is a div whose width is a
 * percentage, so the rows reflow, the labels wrap, and each value is selectable
 * text — none of which an inline `<svg>` gives you without reimplementing text
 * layout. A chart library would only be adding an axis nobody asked for here.
 *
 * Bars, not a pie. This view answers "which is biggest and by how much", and
 * comparing magnitudes across ten rows is exactly what position along a common
 * baseline is for. Angles and areas are read far less precisely.
 *
 * One colour for every bar, with red reserved for "over budget". Colouring each
 * row differently would imply the buckets belong to different kinds, which they
 * do not — they are all the same measure.
 *
 * Rows are ranked by value here, so callers just pass what they have.
 */
export function BarList({
  rows,
  emptyMessage = "Nothing here yet.",
}: {
  rows: {
    key: string | number;
    label: string;
    value: number;
    /** Rendered in red when true: over budget, or over the limit set. */
    over?: boolean;
    href?: string;
    /** Shown under the label, e.g. "of $250 budgeted". */
    detail?: string;
  }[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500">{emptyMessage}</p>
    );
  }

  /*
   * Sorted here rather than left to the caller, because this is a *ranked* list
   * and a caller that forgets produces a chart in arbitrary order that still looks
   * deliberate. Ranking is the whole point of the view.
   */
  const ranked = [...rows].sort((a, b) => b.value - a.value);

  // Bars are scaled to the largest row, not to the total: the question is "how
  // does this compare with the biggest one", and scaling to the total would make
  // the top row always look like a fixed fraction no matter the spread.
  const max = Math.max(...ranked.map((row) => row.value), 1);
  const total = ranked.reduce((sum, row) => sum + row.value, 0);

  return (
    <ul className="space-y-2">
      {ranked.map((row) => {
        const share = row.value / max;
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm">{row.label}</span>
              <span
                className={`shrink-0 text-sm tabular-nums ${
                  row.over
                    ? "font-medium text-red-700 dark:text-red-400"
                    : "text-neutral-600 dark:text-neutral-400"
                }`}
              >
                {formatCurrency(row.value)}
              </span>
            </div>
            {/*
              Tracked over a parent bar so the fill is a clean percentage, and
              `aria-hidden` because the numbers above already say it.
            */}
            <div
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800"
              aria-hidden
            >
              <div
                className={`h-full rounded-full ${
                  row.over ? "bg-red-400" : "bg-indigo-400"
                }`}
                style={{ width: `${Math.max(share * 100, 1)}%` }}
              />
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-neutral-500">
              <span className="min-w-0 truncate">{row.detail}</span>
              {total > 0 ? (
                <span className="shrink-0 tabular-nums">
                  {((row.value / total) * 100).toFixed(0)}%
                </span>
              ) : null}
            </div>
          </>
        );

        return (
          <li key={row.key}>
            {row.href ? (
              <Link
                href={row.href}
                className="block rounded px-1 py-0.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                {body}
              </Link>
            ) : (
              <div className="px-1 py-0.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}