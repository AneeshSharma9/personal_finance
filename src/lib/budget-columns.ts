/**
 * The right-hand money column of the budgets tables.
 *
 * A bucket can show what it spent or what it has left, and the two are the same
 * information read from opposite ends — which is the point of being able to switch,
 * and also the reason the judgement about which rows are in trouble has to be
 * derived rather than written twice.
 *
 * Pure and React-free so it can be tested. The client component that uses it cannot
 * be: the test runner resolves React through the `react-server` condition and gets a
 * build with no `createContext`.
 */

/** What the money column shows. */
export type Column = "actual" | "remaining";

export type ColumnRow = {
  actual: number;
  /** Budgeted minus actual. Negative once the budget is exceeded. */
  remaining: number;
  budgeted: number;
  kind: "basic" | "category" | "earning";
};

/** Red for overspending, green for coming in under, empty for neither. */
export type Tone = "good" | "bad" | "";

export function columnValue(row: ColumnRow, column: Column): number {
  return column === "remaining" ? row.remaining : row.actual;
}

/**
 * Whether a row is flagged, in whichever column is showing.
 *
 * The comparison inverts between the two: in Remaining mode a negative *is* the
 * overage, where in Actual mode it is being under. Deriving one flag from the other
 * is what keeps the columns from disagreeing about which rows are in trouble — and
 * they have to agree, because a red figure under Remaining is exactly a red figure
 * under Actual, said the other way round.
 *
 * Earnings stay right-way-up in both: coming in over target is good news, whether
 * that reads as an Actual above the budget or a positive Remaining.
 *
 * `budgeted > 0` guards the whole thing, so a bucket with no limit set is never
 * flagged for being "over" a budget of zero — which would otherwise paint every
 * unbudgeted row red as soon as a transaction landed in it.
 */
export function columnTone(row: ColumnRow, column: Column): Tone {
  if (row.budgeted <= 0) return "";
  const over =
    column === "remaining" ? row.remaining < 0 : row.actual > row.budgeted;
  if (!over) return "";
  return row.kind === "earning" ? "good" : "bad";
}