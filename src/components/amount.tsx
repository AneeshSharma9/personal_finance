import { amountFor } from "@/lib/mask";
import { formatCurrency } from "@/lib/format";

/**
 * A currency figure that respects the hide-balances preference.
 *
 * Returns a **string**, not an element. That is deliberate: several call sites
 * compose around it - a leading minus for a liability, a `+` from
 * `formatCurrency({ showSign: true })`, a row whose value sits beside a label -
 * and an element would force a wrapper `<span>` into every one of them, changing
 * the markup of tables that other tests assert against. A string drops in where
 * `formatCurrency(...)` used to be and reads the same at the call site.
 *
 * A server component, not a client one that subscribes to a store. That is the
 * whole reason the preference is a cookie: the server knows it, so the masked
 * text is in the first paint and there is no flash of the real figures and
 * nothing real in the HTML for a screen share to pick up.
 *
 * `hidden` is passed in rather than read here so a page reads its cookie once at
 * the top instead of every figure re-reading it.
 *
 * Returns the mask itself when hidden, which is five characters wide whatever the
 * amount was — so a column of these shifts as you toggle. That is the accepted
 * cost of not encoding the value in its own shape; see lib/mask.ts.
 */
export function Amount({
  value,
  hidden,
  compact = false,
  showSign = false,
}: {
  value: number;
  hidden: boolean;
  compact?: boolean;
  showSign?: boolean;
}) {
  return amountFor(formatCurrency(value, { compact, showSign }), hidden);
}