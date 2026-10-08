import Link from "next/link";

import { CHANGE_PERIODS, type ChangePeriod } from "@/lib/change-period";

/**
 * Which period the account breakdown is measuring change over.
 *
 * Plain links, no client state, for the same reason `CashFlowPeriod` and
 * `MonthStrip` are: the selection is one query parameter, so the server already
 * knows the answer, and links keep every view shareable and working with
 * JavaScript off. It also means the period survives a reload and can be pasted
 * to someone else - which matters more here than on a month strip, because
 * "did you mean 30 days or all time" is a real disagreement.
 *
 * `periods` narrows the options for a page that cannot honour all of them -
 * `/net-worth` leaves out "Previous day", since a one-day chart is a single point
 * and the change that option shows is measured against a day outside the window.
 */
export function ChangePeriodPicker({
  current,
  periods = CHANGE_PERIODS,
  /** Query parameters to carry through, so other state on the page survives. */
  searchParams = {},
}: {
  current: ChangePeriod;
  periods?: ChangePeriod[];
  searchParams?: Record<string, string>;
}) {
  return (
    <div
      role="group"
      aria-label="Period to measure change over"
      className="flex flex-wrap gap-1"
    >
      {periods.map((period) => {
        const selected = period.id === current.id;
        const params = new URLSearchParams(searchParams);
        params.set("change", period.id);
        return (
          <Link
            key={period.id}
            href={`?${params.toString()}`}
            aria-current={selected ? "true" : undefined}
            className={`rounded px-2 py-1 text-xs ${
              selected
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            {period.label}
          </Link>
        );
      })}
    </div>
  );
}