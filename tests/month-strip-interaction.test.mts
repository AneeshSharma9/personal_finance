import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The reveal and the settle must not fight each other.
 *
 * The strip scrolls itself in two places: `revealMonth` brings the selected month
 * into view when the selection changes, and `settleStrip` snaps the strip to a tile
 * boundary when the user stops dragging. Both assign `scrollLeft`, which fires a
 * scroll event, which is what schedules the settle.
 *
 * That coupling caused a bug that took three attempts to kill:
 *
 * 1. Selecting December revealed it flush right at `maxScroll`, the settle fired off
 *    that scroll event 140ms later, rounded the position back to a tile boundary,
 *    and cut December off again. December is the only tile that can need the strip
 *    at `maxScroll`, and `maxScroll` is never a multiple of the stride, so it was
 *    also the only tile that revealed off-boundary - and therefore the only one
 *    visibly wrong.
 * 2. The fix was to make the settle refuse any boundary that clipped the selected
 *    month. December was fixed and dragging broke: because the selected month is
 *    usually off-screen while you browse, the strip sprang back to it on every
 *    release. It read as the strip fighting you.
 * 3. The actual fix is here: a scroll the component caused does not schedule a
 *    settle.
 *
 * So this is a source-level test. There is no DOM harness in this suite, and the
 * behaviour is entirely about event ordering rather than arithmetic - the arithmetic
 * is pinned in `month-strip-scroll.test.mts`. What matters is that the guard is
 * still present, because removing it re-breaks December with nothing else failing.
 */
const source = readFileSync("src/components/month-strip.tsx", "utf8");

test("the reveal marks its own scroll so the settle leaves it alone", () => {
  assert.match(
    source,
    /programmatic\.current = true;\s*\n\s*revealMonth\(\);/,
    "the flag must be set immediately before revealMonth, or the scroll event the " +
      "reveal causes is treated as the user's and schedules a settle",
  );
});

test("the scroll handler skips scheduling a settle for a programmatic scroll", () => {
  assert.match(
    source,
    /if \(programmatic\.current\) \{\s*\n\s*programmatic\.current = false;\s*\n\s*return;/,
    "the guard must clear the flag and return before scheduleSettle()",
  );
});

test("the settle does not consider which month is selected", () => {
  /*
   * The regression that fixed December while breaking dragging. `settleStrip` reads
   * `scrollLeft` and the geometry and nothing else; if it ever reaches for
   * `selectedRef` or a `selected` argument again, the strip will spring back to the
   * selected month on release.
   */
  const start = source.indexOf("const settleStrip = useCallback(");
  assert.notEqual(start, -1, "no settleStrip");
  const body = source.slice(start, source.indexOf("[stride],", start));

  assert.doesNotMatch(body, /selectedRef/);
  assert.doesNotMatch(body, /selected/);
  assert.doesNotMatch(body, /stripTileIsVisible/);
});

test("revealing still uses the visibility-aware target, not a plain boundary snap", () => {
  const start = source.indexOf("const revealMonth = useCallback(");
  assert.notEqual(start, -1, "no revealMonth");
  const body = source.slice(start, source.indexOf("[stride]);", start));

  assert.match(body, /stripScrollTarget\(/);
  assert.match(body, /getBoundingClientRect/, "measured from rects, not offsetLeft");
});