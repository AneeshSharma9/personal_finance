import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The manual loan rows must keep the same shape as the account rows above them.
 *
 * They were separate bordered cards with `flex-wrap`, and on a phone the two
 * columns stopped fitting: the balance dropped onto its own line and jumped to the
 * left edge, so one long name and one short loan rendered as a ragged two-row
 * block. Fixed by copying the account row's layout rather than inventing one.
 *
 * Asserted against the source because `ManualLoans` calls `useRouter()` and cannot
 * be rendered outside an app router, and because the thing being guarded is a
 * *relationship* between two files rather than a snapshot of either.
 */

const ACCOUNTS_PAGE = "src/app/(app)/accounts/page.tsx";
const MANUAL_LOANS = "src/components/manual-loans.tsx";

const read = (path: string): string => readFileSync(path, "utf8");

/** The layout classes on the link that wraps a whole account row. */
function accountRowClasses(): string {
  const source = read(ACCOUNTS_PAGE);
  const match = source.match(
    /href=\{`\/accounts\/\$\{account\.id\}`\}\s+className="([^"]*)"/,
  );
  assert.ok(match, "the account row link should be findable on the accounts page");
  return match![1]!;
}

function loanRowClasses(): string {
  const source = read(MANUAL_LOANS);
  const match = source.match(/href=\{`\/loans\/\$\{loan\.id\}`\}\s+className="([^"]*)"/);
  assert.ok(match, "the loan row link should be findable");
  return match![1]!;
}

/** Tokens that define the row's behaviour, ignoring colours and hover states. */
const LAYOUT_TOKENS = [
  "flex",
  "items-center",
  "justify-between",
  "gap-3",
  "px-4",
  "py-3",
];

test("a loan row uses the same layout as an account row", () => {
  const account = accountRowClasses();
  const loan = loanRowClasses();
  for (const token of LAYOUT_TOKENS) {
    assert.ok(account.includes(token), `the account row should use ${token}`);
    assert.ok(loan.includes(token), `the loan row should use ${token} too`);
  }
});

test("a loan row cannot collapse into two ragged lines on a phone", () => {
  const loan = loanRowClasses();
  /*
   * `flex-wrap` is the specific cause: when the columns stop fitting, the second
   * child moves to a new line and, with `justify-between` on a single item, lands
   * at the start. One loan then renders as a tall left-aligned block.
   */
  assert.ok(!loan.includes("flex-wrap"), "the row must not wrap");
  /*
   * `items-baseline` aligns the two blocks' first baselines, which drifts as the
   * two sides wrap differently. The rows are two lines each; centring them is what
   * the account rows do.
   */
  assert.ok(!loan.includes("items-baseline"), "the row must not baseline-align");
});

test("the amount cannot be squeezed mid-number", () => {
  const source = read(MANUAL_LOANS);
  assert.ok(
    /shrink-0[^"]*text-right|text-right[^"]*shrink-0/.test(source),
    "the balance block needs shrink-0 so it never compresses",
  );
  assert.ok(source.includes("truncate text-xs"), "the detail line truncates instead of pushing");
});

test("the loans are one bordered list, not separate floating cards", () => {
  const source = read(MANUAL_LOANS);
  assert.ok(
    source.includes("divide-y"),
    "the list should use dividers between rows",
  );
  assert.ok(
    source.includes("overflow-hidden rounded-lg border"),
    "and a single container border, like every other section",
  );
  assert.ok(
    !/<li className="rounded-lg border/.test(source),
    "no per-item border, which is what made these read as a different kind of thing",
  );
  assert.ok(!source.includes("space-y-3"), "and no gaps between the rows");
});