"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import type { MonthPoint } from "@/lib/queries";

/**
 * Month picker: a rolling window of six months ending at the current month, with
 * arrows to page backwards and forwards.
 *
 * Three deliberate choices:
 *
 *  - **No future months.** The window's anchor is clamped to the current month,
 *    so paging forward stops at today rather than showing empty future tiles that
 *    could never have data.
 *  - **The window is URL-driven, not local state.** The selected month lives in
 *    `?year=&month=`, so a reload or a shared link lands on the same view. Local
 *    state would desync the arrows from the figures further down the page.
 *  - **The year dropdown jumps to the last month of that year** that isn't in the
 *    future, so choosing 2024 lands on December 2024 rather than a month the
 *    user then has to page forward from.
 */

/** How many months are visible at once. */
const WINDOW = 6;

export function MonthStrip({
  months,
  selected,
  years,
  currentYear,
  currentMonth,
  anchorYear,
  anchorMonth,
}: {
  months: MonthPoint[];
  selected: { year: number; month: number };
  /** Years that have data, ascending. */
  years: number[];
  currentYear: number;
  /** 1-12. */
  currentMonth: number;
  /** Last month of the window; 1-12. Defaults to now. */
  anchorYear: number;
  anchorMonth: number;
}) {
  const router = useRouter();

  // Months are compared as a single index so paging is plain arithmetic with no
  // December-to-January special case. All months here are 1-based.
  const currentIndex = currentYear * 12 + (currentMonth - 1);

  // The window anchor comes from the URL (or now, by default) and is already
  // clamped server-side, but clamp again so a hand-edited URL cannot show future
  // months.
  const anchor = Math.min(anchorYear * 12 + (anchorMonth - 1), currentIndex);

  const previousIndex = anchor - WINDOW;
  const nextIndex = anchor + WINDOW;
  const canGoNext = nextIndex <= currentIndex;

  /**
   * Paging moves BOTH the window anchor and the selected month.
   *
   * The anchor alone would leave the figures below pointing at a month that is no
   * longer on screen, which reads as the arrows being broken.
   */
  const href = (index: number) => {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `/budgets?year=${year}&month=${month}&wYear=${year}&wMonth=${month}`;
  };

  return (
    <div className="space-y-2">
      {/*
        `justify-center` plus a nav that is NOT `flex-1`: letting the nav grow
        pushes the arrows to the container edges instead of leaving them next to
        the tiles. `mx-auto` on the inner list keeps the strip centred when it is
        narrower than the row.
      */}
      <div className="flex items-center justify-center gap-2">
        <Arrow
          href={href(previousIndex)}
          direction="left"
          label="Earlier six months"
        />

        <nav aria-label="Budget month" className="min-w-0 overflow-x-auto">
          <ul className="mx-auto flex min-w-max gap-2">
            {months.map((point) => {
              const isSelected =
                point.year === selected.year &&
                point.month === selected.month;
              const isCurrent =
                point.year === currentYear && point.month === currentMonth;
              const empty = point.spent === 0 && point.income === 0;

              return (
                <li key={`${point.year}-${point.month}`}>
                  <Link
                    href={`/budgets?year=${point.year}&month=${point.month}`}
                    aria-current={isSelected ? "page" : undefined}
                    title={`${monthLabel(point)}${
                      point.spent > 0
                        ? ` · spent ${Math.round(point.spent)}`
                        : ""
                    }${
                      point.income > 0
                        ? ` · income ${Math.round(point.income)}`
                        : ""
                    }`}
                    className={`flex w-[4.5rem] flex-col items-center gap-1 rounded-lg border-2 px-2 py-2.5 transition ${
                      isSelected
                        ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-800"
                        : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
                    }`}
                  >
                    <span className="flex h-12 items-end justify-center gap-1.5">
                      {empty ? (
                        <span
                          aria-hidden
                          className="h-px w-3 bg-neutral-300 dark:bg-neutral-700"
                        />
                      ) : (
                        <>
                          {/* Spending: solid. */}
                          <span
                            aria-hidden
                            className="w-2.5 rounded-t-full bg-neutral-800 dark:bg-white"
                            style={{
                              height: `${barHeight(point.spent, maxValue(months))}%`,
                            }}
                          />
                          {/* Income: outlined, so the pair reads as a unit. */}
                          <span
                            aria-hidden
                            className="w-2.5 rounded-t-full border-2 border-dashed border-neutral-400 dark:border-neutral-600"
                            style={{
                              height: `${barHeight(point.income, maxValue(months))}%`,
                            }}
                          />
                        </>
                      )}
                    </span>
                    <span className="text-xs font-medium">
                      {monthLabel(point)}
                    </span>
                    {/* Mark today so the "current month on the right" end of the
                        window is identifiable at a glance. */}
                    {isCurrent && !isSelected ? (
                      <span
                        aria-label="Current month"
                        className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-600"
                      />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {canGoNext ? (
          <Arrow
            href={href(nextIndex)}
            direction="right"
            label="Later six months"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-700"
          >
            {"\u203A"}
          </span>
        )}
      </div>

      <label className="flex items-center gap-2 text-xs text-neutral-500">
        Year
        <select
          value={selected.year}
          // A native select so it also works as a plain form control; the jump
          // needs client state, hence the onChange handler.
          onChange={(event) => {
            const year = Number(event.target.value);
            // Jump to the last month of that year, except for the current year
            // where the last month would be in the future.
            const month = year === currentYear ? currentMonth : 12;
            // Re-anchor the window to the same month so the strip follows the
            // year jump instead of snapping back to today.
            router.push(
              `/budgets?year=${year}&month=${month}&wYear=${year}&wMonth=${month}`,
            );
          }}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Arrow({
  href,
  direction,
  label,
}: {
  href: string;
  direction: "left" | "right";
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-600 dark:hover:bg-neutral-900"
    >
      {/* Literal characters, not entities: these sit in a JS string literal, where
          HTML entities are not decoded. */}
      {direction === "left" ? "\u2039" : "\u203A"}
    </Link>
  );
}

/**
 * Bar height as a percentage of the container.
 *
 * Floored at 6% so a month with small spending against a large one still shows
 * a visible bar; without that a real month looks like an empty one.
 */
function barHeight(value: number, max: number): number {
  if (value <= 0) return 0;
  return Math.max(6, Math.min(100, (value / max) * 100));
}

/** Short month name for a point, e.g. "Sep". */
function monthLabel(point: { year: number; month: number }): string {
  return new Date(Date.UTC(point.year, point.month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

/** One scale across the window, so months are comparable. */
function maxValue(months: MonthPoint[]): number {
  return Math.max(1, ...months.flatMap((m) => [m.spent, m.income]));
}