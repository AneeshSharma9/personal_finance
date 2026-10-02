import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatCurrencyInput,
  humanizeCategory,
  parseCurrencyInput,
} from "@/lib/format";

/**
 * The money field. Both halves matter: the formatter runs on every keystroke and
 * has to be idempotent, and the parser has to tell "the box is empty" apart from
 * "the user typed zero" - conflating those two wipes a real budget.
 */

// ---------------------------------------------------------------------------
// Formatting while typing
// ---------------------------------------------------------------------------

test("digits get a dollar sign and thousands separators", () => {
  assert.equal(formatCurrencyInput("1550"), "$1,550");
  assert.equal(formatCurrencyInput("1234567"), "$1,234,567");
});

test("typing digits one at a time gives the same answer as typing the whole number", () => {
  /*
   * The caret problem. If formatting were not idempotent, "1" -> "$1" -> "$1" and
   * the next keystroke would land in the wrong place, or the field would fight
   * the user. Feeding the output back in must be a fixed point.
   */
  let text = "";
  for (const digit of "1234567") {
    text = formatCurrencyInput(text + digit);
  }
  assert.equal(text, "$1,234,567");
});

test("a trailing decimal point survives so decimals stay typable", () => {
  assert.equal(formatCurrencyInput("1550."), "$1,550.");
  assert.equal(formatCurrencyInput("$1,550."), "$1,550.");
  assert.equal(formatCurrencyInput("1550.5"), "$1,550.5");
  assert.equal(formatCurrencyInput("1550.55"), "$1,550.55");
});

test("fractional digits are not padded while typing", () => {
  // Padding to "1,550.50" would move the caret out from under the user.
  assert.equal(formatCurrencyInput("1550.5"), "$1,550.5");
});

test("an empty field stays empty rather than becoming $0", () => {
  assert.equal(formatCurrencyInput(""), "");
  assert.equal(formatCurrencyInput("$"), "");
  assert.equal(formatCurrencyInput("."), "$0.");
});

test("characters that are not part of a number are dropped", () => {
  // Pasted currency settles rather than being rejected, and keeps its cents
  // rather than being rounded away.
  assert.equal(formatCurrencyInput("$1,550.00"), "$1,550.00");
  assert.equal(formatCurrencyInput("abc"), "");
  assert.equal(formatCurrencyInput("1 5 5 0"), "$1,550");
});

test("a second decimal point is dropped rather than nested", () => {
  assert.equal(formatCurrencyInput("1.2.3"), "$1.23");
  assert.equal(formatCurrencyInput("1.."), "$1.");
});

test("leading zeros do not accumulate", () => {
  assert.equal(formatCurrencyInput("0"), "$0");
  assert.equal(formatCurrencyInput("05"), "$5");
  assert.equal(formatCurrencyInput("007"), "$7");
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

test("a formatted field reads back as the number it shows", () => {
  for (const raw of ["$0", "$1,550", "$1,234,567.89", "$1,550."]) {
    const parsed = parseCurrencyInput(raw);
    assert.ok(parsed !== null, `${raw} parses`);
  }
  assert.equal(parseCurrencyInput("$1,550"), 1550);
  assert.equal(parseCurrencyInput("$1,234,567.89"), 1234567.89);
  assert.equal(parseCurrencyInput("$1,550."), 1550);
});

test("an empty field reads as nothing rather than zero", () => {
  // The distinction that stops a cleared box from wiping a budget.
  assert.equal(parseCurrencyInput(""), null);
  assert.equal(parseCurrencyInput("$"), null);
  assert.equal(parseCurrencyInput("."), null);
  assert.equal(parseCurrencyInput("abc"), null);
});

test("zero is a value, not an absence", () => {
  assert.equal(parseCurrencyInput("$0"), 0);
  assert.equal(parseCurrencyInput("0.00"), 0);
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("every figure formatCurrency renders survives a round trip", () => {
  for (const amount of [0, 5, 99.99, 100, 1550, 4255.5, 123456.78]) {
    const shown = formatCurrencyInput(String(amount));
    assert.equal(
      parseCurrencyInput(shown),
      amount,
      `${shown} reads back as ${amount}`,
    );
  }
});

test("humanizeCategory turns PFC values into labels", () => {
  assert.equal(humanizeCategory("FOOD_AND_DRINK"), "Food And Drink");
  assert.equal(humanizeCategory("GENERAL_MERCHANDISE"), "General Merchandise");
});