import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Every page that shows a balance must ask whether balances are hidden.
 *
 * A page can render a figure in a dozen places and a new one is easy to forget.
 * The failure is quiet and it is the bad kind: the page looks right, one number is
 * simply not masked, and the person who hid their balances is the one who cannot
 * see that anything is wrong.
 *
 * So this asserts a shape over the source rather than trusting review. A page is
 * named explicitly, and each has to do two things: read the preference, and use
 * the masking helper rather than `formatCurrency` bare wherever it paints a
 * balance.
 *
 * Not exhaustive by construction - nothing here can prove a page has no balances.
 * It catches the common regressions: a page added to the list, or a figure
 * switched from `Amount`/`amountFor` back to a bare `formatCurrency`.
 */

const read = (path: string): string => readFileSync(path, "utf8");

/** Remove block and line comments, preserving line numbering. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead: string) => lead);
}

/** Pages that show net worth, account balances, or loan balances. */
const BALANCE_PAGES = {
  "src/app/(app)/page.tsx": "dashboard",
  "src/app/(app)/net-worth/page.tsx": "net worth",
  "src/app/(app)/accounts/page.tsx": "accounts",
  "src/app/(app)/accounts/[id]/page.tsx": "one account",
  "src/app/(app)/loans/[id]/page.tsx": "one loan",
} as const;

test("the balance pages are all still here", () => {
  /*
   * Guards the list above rather than the feature: a page renamed or moved makes
   * every other test in this file pass vacuously, because `read` would throw on
   * a path that no longer exists - but only once someone edits this file to remove
   * it. This asserts the count and the names so that removal is deliberate.
   */
  assert.equal(Object.keys(BALANCE_PAGES).length, 5);
  for (const path of Object.keys(BALANCE_PAGES)) {
    assert.doesNotThrow(() => read(path), `${path} should exist`);
  }
});

test("every balance page reads the hide-balances preference", () => {
  for (const [path, name] of Object.entries(BALANCE_PAGES)) {
    const source = read(path);
    assert.match(
      source,
      /balancesHidden\(\)/,
      `the ${name} page should read the preference once, at the top`,
    );
  }
});

test("every balance page is actually wired to the mask", () => {
  /*
   * A page on the list above that renders its balances but never asks about the
   * preference shows every figure in plain text while claiming nothing is hidden.
   *
   * This checks the *balance* sites rather than banning `formatCurrency` outright,
   * because these pages also render spending and plan figures - the bar list, the
   * unfiled-spendings link - which are outside what the preference covers. See
   * the next test for why that boundary is where it is.
   */
  for (const [path, name] of Object.entries(BALANCE_PAGES)) {
    const source = read(path);
    const usesMask =
      /<Amount\b/.test(source) || /amountFor\(/.test(source) || /\bhidden=\{hidden\}/.test(source);
    assert.ok(usesMask, `the ${name} page should render balances through the mask`);
  }
});

test("spending figures are deliberately outside the preference", () => {
  /*
   * Stated rather than left implied, because it is the obvious next question and
   * the honest answer is that the feature covers *balances*: net worth, account
   * balances, loan balances. A bar chart of where the money went last month is
   * spending history, and so is the budget plan, and hiding those is a different
   * decision - one that would empty half the app.
   *
   * The two figures below are the ones that make it concrete: the spending bar
   * list on the dashboard and the unfiled-spendings link beside it.
   */
  const dashboard = read("src/app/(app)/page.tsx");
  assert.match(
    dashboard,
    /formatCurrency\(row\.budgeted\)/,
    "spending figures stay in plain text, deliberately",
  );
  assert.match(
    dashboard,
    /formatCurrency\(spendSummary\.unassignedTotal\)/,
    "as does the unfiled-spendings link",
  );
});

test("the preference is a cookie the server reads, not client state", () => {
  /*
   * The load-bearing structural claim. With the preference in `localStorage` the
   * server cannot know it, so it renders the real figures: they sit in the HTML
   * and in the RSC payload, and they are on screen until hydration. For a screen
   * share that is the whole window the feature exists to close, and it reopens on
   * every reload.
   *
   * Comments are stripped first, because this module argues that point at length
   * in prose and would otherwise fail on its own explanation.
   */
  const privacy = stripComments(read("src/lib/privacy.ts"));
  assert.match(privacy, /import "server-only"/, "reading it is a server concern");
  assert.match(privacy, /from "next\/headers"/, "it comes from a cookie");
  assert.doesNotMatch(
    privacy,
    /localStorage/,
    "localStorage would put the real figures in the server-rendered HTML",
  );
});

test("the toggling control is the net worth figure on both pages that show one", () => {
  for (const path of ["src/app/(app)/page.tsx", "src/app/(app)/net-worth/page.tsx"]) {
    const source = read(path);
    assert.match(
      source,
      /<BalanceVisibilityToggle[\s\S]{0,900}?<Amount value=\{netWorth\.netWorth\} hidden=\{hidden\} \/>/,
      `${path} should toggle on its net worth figure`,
    );
  }
});

test("the toggle masks its own label", () => {
  /*
   * Found while building it: the control wraps the figure it operates on, so
   * leaving that figure raw made the toggle the one unmasked number on a page
   * claiming the rest were hidden. Asserted against both call sites because the
   * regex above cannot tell a masked child from an unmasked one.
   */
  for (const path of ["src/app/(app)/page.tsx", "src/app/(app)/net-worth/page.tsx"]) {
    const source = read(path);
    const open = source.indexOf("<BalanceVisibilityToggle");
    assert.ok(open > 0, `${path} should render the toggle`);
    const close = source.indexOf("</BalanceVisibilityToggle>", open);
    const inner = source.slice(open, close);
    assert.doesNotMatch(
      inner,
      /\{formatCurrency\(/,
      `${path}: the toggle's own label must be masked`,
    );
  }
});

test("charts take the flag, and say so", () => {
  for (const path of ["src/components/trend-chart.tsx", "src/components/donut.tsx"]) {
    const source = read(path);
    assert.match(source, /hidden\?: boolean/, `${path} should accept the preference`);
    assert.match(
      source,
      /not hide the \*shape\*|arcs keep their proportions/,
      `${path} should record what masking does not cover`,
    );
  }
});

test("masking is applied where the numbers are, not just in the headline", () => {
  /*
   * The change breakdown was the one place most likely to be missed: its figures
   * are in the row *and* in a hover tooltip, and the tooltip is invisible until
   * you point at it - which is exactly the figure you would hand over by
   * accident.
   */
  const list = read("src/components/account-change-list.tsx");
  assert.match(list, /rowTitle\(row, hidden\)/, "the row tooltip must be masked");
  assert.match(list, /changeLabel\(row, hidden\)/, "the change label must be masked");
  assert.match(
    list,
    /const amount = \(value: number\) => amountFor\(formatCurrency\(value\), hidden\)/,
    "the tooltip's own formatter has to apply the flag",
  );
});