import { formatCurrency } from "@/lib/format";
import type { BudgetSummaryTotals } from "@/lib/queries";

/**
 * Summary card: a ring showing how much of the month's budget is gone, plus the
 * three figures underneath.
 *
 * "Leftover" is Spending Budget minus Spending. The ring fills clockwise with
 * the spent fraction and turns red once the budget is exceeded, so the state is
 * readable without reading any of the numbers.
 */
export function BudgetSummary({ totals }: { totals: BudgetSummaryTotals }) {
  const { budgeted, spent, income, remaining } = totals;
  const overspent = remaining < 0;

  // Clamp the arc at a full ring; an over-budget month can't draw past 100%.
  const fraction = budgeted > 0 ? Math.min(spent / budgeted, 1) : 0;
  const hasBudget = budgeted > 0;

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-neutral-500">Summary</h2>

      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="flex flex-col items-center gap-3 p-5 sm:flex-row sm:items-center sm:gap-6">
          <Ring fraction={fraction} hasBudget={hasBudget} overspent={overspent} />

          <div className="text-center sm:text-left">
            <p className="text-xs text-neutral-500">
              {overspent ? "Over budget" : "Leftover"}
            </p>
            <p className="text-3xl font-semibold tabular-nums">
              {formatCurrency(Math.abs(remaining))}
            </p>
            {hasBudget ? (
              <p className="text-sm text-neutral-500">
                of {formatCurrency(budgeted)}
              </p>
            ) : (
              <p className="text-sm text-neutral-500">
                No spending budget set for this month
              </p>
            )}
          </div>
        </div>

        <dl className="divide-y divide-neutral-100 border-t border-neutral-200 dark:divide-neutral-800">
          <Row
            label="Spending Budget"
            value={budgeted}
            icon="plus"
            hint="Total budgeted across Budget Basics and Budget Categories."
          />
          <Row
            label="Spending"
            value={spent}
            icon="minus"
            hint="Money spent this month in your budget buckets."
          />
          <Row
            label="Remaining"
            value={remaining}
            icon="equals"
            tone={overspent ? "bad" : "good"}
            hint="Budget minus spending. Negative means over budget."
          />
          <Row
            label="Income"
            value={income}
            icon="income"
            hint="Money received this month, tracked separately from spending."
          />
        </dl>
      </div>
    </section>
  );
}

/**
 * Progress ring.
 *
 * Drawn with stroke-dasharray on a circle so the arc needs no path maths, and
 * drawn twice - once as a full grey track, once as the coloured progress - which
 * also makes the 0% and 100% cases fall out naturally.
 */
function Ring({
  fraction,
  hasBudget,
  overspent,
}: {
  fraction: number;
  hasBudget: boolean;
  overspent: boolean;
}) {
  const size = 132;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const color = !hasBudget
    ? "#d4d4d4"
    : overspent
      ? "#ef4444"
      : fraction > 0.9
        ? "#f59e0b"
        : "#6b7bf7";

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="h-32 w-32 shrink-0"
      role="img"
      aria-label={
        hasBudget
          ? `${Math.round(fraction * 100)}% of the budget spent`
          : "No budget set"
      }
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#e5e5e5"
        strokeWidth={stroke}
        className="dark:stroke-neutral-800"
      />
      {hasBudget && fraction > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          // Start the arc at 12 o'clock rather than 3.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
    </svg>
  );
}

function Row({
  label,
  value,
  icon,
  tone,
  hint,
}: {
  label: string;
  value: number;
  icon: "plus" | "minus" | "equals" | "income";
  tone?: "good" | "bad";
  hint: string;
}) {
  const glyph = { plus: "+", minus: "−", equals: "=", income: "+" }[icon];

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-3"
      title={hint}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-neutral-400 text-xs leading-none text-neutral-500"
        >
          {glyph}
        </span>
        <span className="truncate">{label}</span>
      </span>
      <span
        className={`shrink-0 tabular-nums ${
          tone === "good"
            ? "text-green-700 dark:text-green-400"
            : tone === "bad"
              ? "text-red-700 dark:text-red-400"
              : ""
        }`}
      >
        {formatCurrency(value)}
      </span>
    </div>
  );
}