/**
 * Hiding a figure, so that nothing about it can be inferred.
 *
 * Every masked amount is the same five characters. That is a change of direction
 * from the first version of this, which replaced only the digits and kept the
 * currency symbol, the grouping commas and the decimal point - `$4,600.00` came
 * out as `$*,***.**`. The reasoning then was to preserve width, so a table of
 * balances did not reflow and the mask did not say anything about magnitude.
 *
 * But that mask was still an encoding of the number: the sign, the currency, the
 * comma count and the decimal point all survived, and someone reading a screen
 * over your shoulder could count the commas to place a balance within an order of
 * magnitude. Preserving layout is worth less than not leaking, especially since
 * the only way to tell a balance from a total was in the digits anyway.
 *
 * So: one constant, five characters, for every amount on the page. Nothing to
 * count, nothing to measure, nothing that varies with the value. The cost is
 * that a column of figures reflows when you toggle, because `*****` is narrower
 * than most real amounts - which is visible, deliberate, and a far better leak
 * than the one it replaces.
 *
 * No `server-only` here even though the hiding itself is server-side: the chart
 * readouts and the axis labels want the same function.
 */

/**
 * What a hidden amount renders as.
 *
 * Five of `U+2731 EIGHT POINTED BLACK STAR`, not five asterisks. The asterisk is
 * the obvious choice and it is the wrong glyph: it is drawn near the cap height,
 * so a row of them floats above the line it belongs to and the whole page appears
 * to drift upward when balances are hidden. Fixing that needed a `translate-y`
 * nudge, whose right value was a matter of guessing and which then had to be
 * carried as a wrapper element.
 *
 * `✱` needs none of that. Measured against the alphabetic baseline at the three
 * sizes this app renders figures at, the ink centre of `✱` lands within about
 * 0.2px of where `$` sits - it is a glyph drawn to sit on the baseline, like the
 * figures it replaces. The asterisk at the same size is 4.9px too high.
 *
 * So the mask is plain text again: no wrapper, no nudge, no arbitrary constant to
 * keep in step with a font. Chosen on measurement rather than on how it looks,
 * because "looks centred" and "is centred" diverge exactly where it matters.
 *
 * Exported so a test can assert against the same constant rather than re-deriving
 * it.
 */
export const HIDDEN_AMOUNT = "✱✱✱✱✱";

/**
 * The formatted amount, or the mask.
 *
 * A separate function rather than an inline ternary so every call site reads the
 * same way, and so `false` cannot be reached by a truthiness accident - `hidden`
 * is a boolean and `hidden ? ... : ...` in thirty places is thirty chances to
 * drop it.
 *
 * The formatted string is ignored when hiding. It is still passed rather than
 * dropped, so the call site reads as "this figure, possibly hidden" and so the
 * unmasked path cannot be broken by someone tidying the argument away.
 */
export function amountFor(formatted: string, hidden: boolean): string {
  return hidden ? HIDDEN_AMOUNT : formatted;
}