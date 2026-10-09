import assert from "node:assert/strict";
import { test } from "node:test";

import { amountFor, HIDDEN_AMOUNT } from "@/lib/mask";
import { formatCurrency } from "@/lib/format";

/**
 * What a hidden balance looks like.
 *
 * The arithmetic here is trivial. What is worth pinning is that a masked amount
 * is *identical* for every value, because that is the whole property: there is
 * nothing left to measure. Every assertion below is really one claim - "no two
 * different amounts produce two different masks" - checked from several angles
 * because each one catches a way the mask could start leaking again.
 */

test("every masked amount is the same five characters", () => {
  assert.equal(HIDDEN_AMOUNT, "*****");
  assert.equal(HIDDEN_AMOUNT.length, 5);
  for (const value of [0, 9.99, 4600, 1234567.89, -250.5, -1234567.89]) {
    assert.equal(amountFor(formatCurrency(value), true), HIDDEN_AMOUNT);
  }
});

test("two different amounts cannot be told apart", () => {
  /*
   * The property, stated directly. The previous mask replaced only the digits, so
   * this held for `$4,600.00` and `$4,601.00` but *not* for `$460.00` and
   * `$46,000.00` - different comma counts, different widths, so a glance at the
   * column placed a balance within an order of magnitude.
   */
  const pairs: [number, number][] = [
    [4600, 4601],
    [460, 46000],
    [4.6, 4600000],
    [-250.5, 250.5],
    [0, 999999999],
  ];
  for (const [a, b] of pairs) {
    assert.equal(
      amountFor(formatCurrency(a), true),
      amountFor(formatCurrency(b), true),
      `${formatCurrency(a)} and ${formatCurrency(b)} must be indistinguishable`,
    );
  }
});

test("nothing about the amount survives, including sign and currency", () => {
  /*
   * Every character of a real amount is either a digit or punctuation that
   * describes one. So a mask that is not made of digits, currency symbols, signs,
   * separators or decimal points cannot have copied any of them.
   */
  for (const value of [-1234567.89, -0.01, 0, 9876543.21]) {
    const masked = amountFor(formatCurrency(value), true);
    assert.doesNotMatch(masked, /[\d$.,+-]/, `"${masked}" should carry no numeric structure`);
  }
});

test("compact and full amounts mask identically", () => {
  /*
   * A chart axis renders compact (`$1.2M`) and a total renders full
   * (`$1,234,567.89`). If the mask tracked which form it was, an axis label would
   * give the order of magnitude away - which is most of what the chart shows.
   */
  assert.equal(
    amountFor(formatCurrency(1234567.89, { compact: true }), true),
    amountFor(formatCurrency(1234567.89), true),
  );
});

test("a signed amount masks identically to an unsigned one", () => {
  /*
   * `formatCurrency({ showSign: true })` prefixes a `+` for a positive change. A
   * mask that kept it would say which figures rose and which fell.
   */
  assert.equal(
    amountFor(formatCurrency(120.55, { showSign: true }), true),
    amountFor(formatCurrency(-120.55), true),
  );
});

test("an unhidden figure is byte-identical to what was there before", () => {
  /*
   * The feature has to be invisible when it is off. `amountFor(x, false)` is used
   * at every call site, so a mistake in it would quietly change figures for
   * people who never asked to hide anything.
   */
  for (const value of [0, -99.99, 1234.5, 987654.32]) {
    assert.equal(amountFor(formatCurrency(value), false), formatCurrency(value));
    assert.equal(
      amountFor(formatCurrency(value, { compact: true }), false),
      formatCurrency(value, { compact: true }),
    );
  }
});

test("toggling changes every figure to the same width, not to a related one", () => {
  /*
   * The reflow is real and accepted: `*****` is narrower than most amounts, so a
   * column shifts when balances are hidden. This asserts the shift is uniform
   * rather than informative - every masked figure has identical width, so nothing
   * about the original can be read back out of the new layout.
   */
  const widths = new Set(
    [0, 9.99, 4600, 1234567.89].map(
      (value) => amountFor(formatCurrency(value), true).length,
    ),
  );
  assert.equal(widths.size, 1, "every masked figure should be the same width");
});