import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * "Spending that still needs a bucket" has to mean one thing.
 *
 * This is a source-level test, which is normally the wrong kind. It is here
 * because there is no database harness in this suite, and the bug it guards was
 * invisible to every other kind of test.
 *
 * What happened: thirteen `DISCOVER DES:E-PAYMENT` card payments sat in the
 * unassigned queue with an Assign control that did nothing. Three separate places
 * answered "what is unassigned?" and each filtered differently -
 *
 *   getUnassignedTransactions   amount > 0                 -> showed all 13
 *   applyBudgetRules            excluded = false           -> could touch none
 *   countUnassigned             neither                    -> reported 16
 *
 * The rows were `excluded = true`, which is correct: paying a card is not
 * spending. So the queue was listing rows the engine had deliberately ignored, and
 * pressing assign could never have worked no matter how many times. Every test in
 * the suite passed, because each assertion was about one function's arithmetic and
 * none of them were about the three agreeing.
 *
 * So the invariant under test is the agreement itself: all four call sites must go
 * through the one shared predicate. Re-inlining a filter into any of them fails
 * here rather than shipping.
 */
const read = (path: string): string => readFileSync(path, "utf8");

const engine = read("src/lib/budget-engine.ts");
const queries = read("src/lib/queries.ts");

/**
 * The body of `function name(...) { ... }`.
 *
 * Starts at the brace after the closing paren of the parameter list, not the
 * first `{` in sight - a parameter typed `{ id: number }` would otherwise be
 * mistaken for the body and the assertions would run against a type.
 */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `could not find ${signature}`);

  let parens = 0;
  let afterParams = -1;
  for (let i = source.indexOf("(", start); i < source.length; i += 1) {
    if (source[i] === "(") parens += 1;
    else if (source[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        afterParams = i;
        break;
      }
    }
  }
  assert.notEqual(afterParams, -1, `unbalanced parentheses after ${signature}`);

  let depth = 0;
  let seen = false;
  for (let i = source.indexOf("{", afterParams); i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      seen = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

const SHARED = [
  {
    label: "the queue page",
    source: queries,
    signature: "export async function getUnassignedTransactions(",
  },
  {
    label: "the badge on the budgets page",
    source: queries,
    signature: "export async function getSpendSummary(",
  },
  {
    label: "the count after Assign unassigned",
    source: engine,
    signature: "export async function countUnassigned(",
  },
  {
    label: "the cash flow diagram's unassigned figure",
    source: queries,
    signature: "export async function getCashFlow(",
  },
];

for (const { label, source, signature } of SHARED) {
  test(`${label} goes through the shared unassigned predicate`, () => {
    const fn = body(source, signature);
    assert.match(
      fn,
      /unassignedSpend\(/,
      `${label} must call unassignedSpend(...) rather than spelling out its own filters`,
    );
  });
}

test("the engine never strands a row the queue is showing", () => {
  /*
   * applyBudgetRules cannot use the shared predicate, and the reason is worth
   * keeping: it scans a deliberate superset, including money coming in and
   * negative amounts on card accounts, because routing income and marking a card
   * payment excluded are both its job. Filtering to `amount > 0` would blind it to
   * exactly the rows it exists to handle.
   *
   * So the invariant is one-directional: everything the queue shows must be
   * reachable by the engine. It already skips `excluded = true`, which now matches
   * the queue. If someone adds a filter here that the queue does not share, a row
   * can be listed with no way to file it - which is precisely the thirteen
   * Discover payments.
   */
  const fn = body(engine, "export async function applyBudgetRules(");
  assert.match(
    fn,
    /excluded/,
    "the engine skips ignored rows, exactly as the queue does",
  );
  assert.doesNotMatch(
    fn,
    /amount\s*>\s*["'`]?0/,
    "a positive-amount filter here would hide income and card payments from the " +
      "engine while the queue still listed other rows",
  );
});

test("the shared predicate excludes ignored rows, which is the whole fix", () => {
  const fn = body(engine, "export function unassignedSpend(");
  assert.match(
    fn,
    /excluded/,
    "a row the user ignored is neither income nor spending, so it must not " +
      "reappear as an open question",
  );
  assert.match(fn, /budgetId/);
  assert.match(fn, /pending/);
});

test("the predicate really is defined once", () => {
  const definitions = [...engine.matchAll(/export function unassignedSpend\(/g)];
  assert.equal(
    definitions.length,
    1,
    "a second definition would mean the four call sites could disagree again",
  );
  assert.equal(
    [...queries.matchAll(/function unassignedSpend\(/g)].length,
    0,
    "queries.ts must import it, not restate it",
  );
});

test("the unassigned preview runs the engine's own matcher", () => {
  /*
   * A preview that reimplemented the precedence would drift from the engine, and
   * drift here is worse than no preview: it would confidently name a bucket that
   * "Assign unassigned" then refuses to use.
   */
  const fn = body(engine, "export async function suggestBucketAssignments(");
  assert.match(fn, /loadRuleSet\(userId\)/, "the same rule set");
  assert.match(fn, /resolveBucket\(/, "the same matcher");
  assert.doesNotMatch(
    fn,
    /\.update\(/,
    "the preview must only ever read",
  );
  assert.doesNotMatch(fn, /\.insert\(/);
  assert.doesNotMatch(fn, /\.delete\(/);
});
