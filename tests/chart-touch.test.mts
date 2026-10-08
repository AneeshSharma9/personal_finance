import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Dragging a finger across a chart has to move the tooltip, and that has three
 * separate conditions on it — any one of which can fail silently.
 *
 * There is no DOM harness in this suite (see `tests/card-layout.test.mts` for why
 * several tests read the source), and the behaviour here is about which events are
 * wired and in what order rather than arithmetic — the arithmetic is pinned in
 * `tests/series.test.mts`. What matters is that these conditions stay present,
 * because every one of them failing produces a chart that looks fine on a desktop
 * and does nothing on a phone.
 */

const source = readFileSync("src/components/trend-chart.tsx", "utf8");

test("the chart reads pointer events, not mouse events", () => {
  /*
   * `onMouseMove` does fire for a dragged finger on most browsers, but only once
   * the browser has decided the drag is not a scroll — and on a chart in a
   * vertically scrolling page it usually is. Swapping to pointer events is what
   * makes the gesture reach the handler at all.
   */
  assert.match(source, /onPointerDown=/, "a press must be handled");
  assert.match(source, /onPointerMove=/, "the drag must be handled");
  assert.doesNotMatch(source, /onMouseMove=/, "mouse events are the old path");
});

test("vertical scrolling is still left to the browser", () => {
  /*
   * `touch-action: none` would make the drag work perfectly and break scrolling
   * the page by starting the gesture on a chart — which is most of a phone screen
   * here. `pan-y` claims only the horizontal axis for the chart and hands
   * vertical back, which is the whole reason a scrub is possible without trapping
   * the reader.
   */
  assert.match(
    source,
    /touch-pan-y/,
    "the chart must claim horizontal movement only",
  );
  assert.doesNotMatch(
    source,
    /touch-none/,
    "touch-action:none would trap the page's vertical scroll",
  );
});

test("a press captures the pointer, so a drag off the chart keeps tracking", () => {
  /*
   * Without capture the selection freezes at whatever point the finger crossed the
   * edge. On a narrow phone that is most of the chart's width from where the user
   * is actually touching, which is worse than not dragging at all.
   */
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /hasPointerCapture\(event\.pointerId\)/);
});

test("releasing does not clear a touch selection", () => {
  /*
   * The finger is covering the tooltip at exactly the moment you want to read it,
   * and lifting is how you say "I have read that". Clearing on release makes
   * scrubbing to a point and reading it impossible.
   */
  const up = source.slice(
    source.indexOf("onPointerUp="),
    source.indexOf("onPointerCancel="),
  );
  assert.notEqual(up.length, 0, "onPointerUp should be present");
  assert.doesNotMatch(
    up,
    /setActiveIndex\(null\)/,
    "a touch release must leave the selection in place",
  );
});

test("something else on the page does clear a touch selection", () => {
  /*
   * The other half of the rule above. If the selection outlives the gesture, then
   * `pointerleave` is the obvious way to clear it — and for touch the browser fires
   * `pointerleave` the instant the finger lifts, because the touch pointer ceases to
   * exist. So the obvious implementation undoes the rule above exactly. A
   * document-level press listener is what actually dismisses it, popover-style.
   */
  assert.match(
    source,
    /document\.addEventListener\("pointerdown"/,
    "a press outside the chart must dismiss the selection",
  );
  assert.match(
    source,
    /removeEventListener\("pointerdown"/,
    "and must be removed on unmount",
  );
  assert.match(
    source,
    /chartRef\.current\?\.contains/,
    "a press inside the chart must not dismiss the selection",
  );
});

test("only a mouse inspects on hover", () => {
  /*
   * A finger resting on the page after a scroll would otherwise park a tooltip on
   * the chart with no gesture behind it. So anything that is not a mouse moves the
   * selection only while it is pressed.
   */
  assert.match(
    source,
    /if \(event\.pointerType === "mouse" \|\| dragging\.current\) inspect\(event\);/,
    "touch must require a press",
  );
});

test("a scroll that takes over is not a drag", () => {
  // The browser claiming the gesture for a pan fires pointercancel, and the
  // selection must not survive it.
  const cancel = source.slice(
    source.indexOf("onPointerCancel="),
    source.indexOf("onPointerLeave="),
  );
  assert.match(cancel, /setActiveIndex\(null\)/);
});

test("the width observer still gets its node", () => {
  /*
   * `useMeasuredWidth` owns a ref and needs the real element attached — it is what
   * keeps the drawing and the HTML tooltip agreeing at every width. The touch
   * handler needs an element handle too, for the `contains` check above, so the
   * two refs are merged rather than one replacing the other.
   */
  assert.match(
    source,
    /mergeRefs\(ref, chartRef\)/,
    "both refs must be attached to the same element",
  );
  assert.match(source, /function mergeRefs</, "and the merge helper must exist");
});