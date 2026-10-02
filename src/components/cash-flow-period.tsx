import Link from "next/link";

import type { CashFlowScope } from "@/lib/cash-flow";

/**
 * Which period the cash flow view is showing.
 *
 * Plain links, no client state, on purpose. The whole selection is three query
 * parameters, so the server already knows the answer, and links keep every view
 * shareable and working with JavaScript off - the same reason MonthStrip is
 * URL-driven.
 */
export function CashFlowPeriod({
  scope,
  year,
  /** 1-12. Ignored in the year-to-date scope. */
  month,
  years,
}: {
  scope: CashFlowScope;
  year: number;
  month: number;
  years: number[];
}) {
  const href = (next: {
    scope?: CashFlowScope;
    year?: number;
    month?: number;
  }): string => {
    const params = new URLSearchParams();
    params.set("scope", next.scope ?? scope);
    params.set("year", String(next.year ?? year));
    // Only meaningful for a single month; carrying a stale one into the
    // year-to-date view would resurrect it the moment the user switched back.
    if ((next.scope ?? scope) === "month") {
      params.set("month", String(next.month ?? month));
    }
    return `/budgets/cash-flow?${params.toString()}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segment
          options={[
            { label: "Month", value: "month", href: href({ scope: "month" }) },
            {
              label: "Year to date",
              value: "ytd",
              href: href({ scope: "ytd" }),
            },
          ]}
          current={scope}
        />

        <div className="flex flex-wrap items-center gap-1 text-xs">
          {years.map((option) => (
            <Link
              key={option}
              href={href({ year: option })}
              aria-current={option === year ? "true" : undefined}
              className={`rounded px-2 py-1 ${
                option === year
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
            >
              {option}
            </Link>
          ))}
        </div>
      </div>

      {/*
        The month row is hidden in the year-to-date scope rather than disabled:
        it would have no effect there, and a greyed-out row of twelve options is
        just noise. The year is capped at the current year upstream, so no future
        month is ever offered.
      */}
      {scope === "month" ? (
        <div className="flex flex-wrap gap-1 text-xs">
          {MONTHS.map((label, index) => {
            const value = index + 1;
            const selected = value === month;
            return (
              <Link
                key={label}
                href={href({ month: value })}
                aria-current={selected ? "true" : undefined}
                className={`rounded px-2 py-1 ${
                  selected
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Two-option switch, rendered as links so it works without JavaScript. */
function Segment({
  options,
  current,
}: {
  options: { label: string; value: string; href: string }[];
  current: string;
}) {
  return (
    <div
      role="group"
      aria-label="Period"
      className="flex rounded-md border border-neutral-200 p-0.5 dark:border-neutral-700"
    >
      {options.map((option) => {
        const selected = option.value === current;
        return (
          <Link
            key={option.value}
            href={option.href}
            aria-current={selected ? "true" : undefined}
            className={`rounded px-3 py-1 text-xs ${
              selected
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}