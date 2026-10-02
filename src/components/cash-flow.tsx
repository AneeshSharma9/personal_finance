import { formatCurrency } from "@/lib/format";

/**
 * Money in against money out, month by month.
 *
 * Bars again rather than a line: the question is "did I outspend my income", and
 * that is a comparison between two values within each month. A single line would
 * have to interpolate between them and could not show the gap directly.
 *
 * Counts *all* transactions, not just the ones in a budget bucket, so this is the
 * honest picture of cash flow. It will not tie to the Spending Budget total on
 * /budgets, which counts only bucketed spending - different questions, so it is
 * labelled differently rather than quietly reconciled.
 *
 * Plain HTML: fixed-height bars inside a flex row, so it reflows on a phone and
 * needs no measurement.
 */
export function CashFlow({
  months,
}: {
  months: { label: string; income: number; spent: number }[];
}) {
  const peak = Math.max(
    ...months.flatMap((month) => [month.income, month.spent]),
    1,
  );

  return (
    <div>
      <div className="flex items-end gap-2 sm:gap-4">
        {months.map((month) => {
          const out = (month.spent / peak) * 100;
          const inHeight = (month.income / peak) * 100;
          // Over the month means spent > earned, which is the only verdict here.
          const over = month.spent > month.income && month.spent > 0;

          return (
            <div key={month.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex h-28 w-full items-end justify-center gap-1">
                {/*
                  Income first, then spending, so the pair reads left to right in
                  the order they happen. The bar carries its own title, because a
                  div has no accessible text of its own.
                */}
                <div
                  className="w-1/3 max-w-6 rounded-t bg-green-400"
                  style={{ height: `${Math.max(inHeight, month.income > 0 ? 2 : 0)}%` }}
                  title={`${month.label}: ${formatCurrency(month.income)} in`}
                />
                <div
                  className={`w-1/3 max-w-6 rounded-t ${
                    over ? "bg-red-400" : "bg-indigo-400"
                  }`}
                  style={{ height: `${Math.max(out, month.spent > 0 ? 2 : 0)}%` }}
                  title={`${month.label}: ${formatCurrency(month.spent)} out`}
                />
              </div>
              <span className="truncate text-[10px] text-neutral-500">
                {month.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm bg-green-400" />
          Money in
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm bg-indigo-400" />
          Money out
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-sm bg-red-400" />
          Out &gt; in
        </span>
      </div>
    </div>
  );
}