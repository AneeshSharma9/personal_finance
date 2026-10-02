import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampView,
  fitView,
  MAX_SCALE,
  MIN_SCALE,
  panView,
  zoomView,
  type Size,
  type ViewBox,
} from "@/lib/zoom-view";

/**
 * Pan and zoom, where the bugs are invisible in a screenshot.
 *
 * Two failure modes matter and neither shows up in a still image: a zoom that
 * moves the point you aimed at out from under the cursor, and a control that
 * flings the chart somewhere you cannot pan back from.
 */

const LIMIT: Size = { w: 1000, h: 400 };
const near = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

test("fit shows the whole drawing", () => {
  assert.deepEqual(fitView(LIMIT), { x: 0, y: 0, w: 1000, h: 400 });
});

test("zooming in keeps the point under the cursor under the cursor", () => {
  const view = fitView(LIMIT);
  // A spot off-centre, as if aiming at one small bar among several. It has to
  // stay inside the drawing after zooming, or clamping would move it instead.
  const focus = { x: 700, y: 300 };

  const zoomed = zoomView(view, 1.25, focus, LIMIT);

  // The focus must map to the same relative position inside the new window.
  const beforeX = (focus.x - view.x) / view.w;
  const afterX = (focus.x - zoomed.x) / zoomed.w;
  near(afterX, beforeX, "horizontal position preserved");

  const beforeY = (focus.y - view.y) / view.h;
  const afterY = (focus.y - zoomed.y) / zoomed.h;
  near(afterY, beforeY, "vertical position preserved");
});

test("zoom preserves the aspect ratio", () => {
  const zoomed = zoomView(fitView(LIMIT), 1.25, { x: 500, y: 200 }, LIMIT);
  near(zoomed.w / zoomed.h, LIMIT.w / LIMIT.h, "aspect unchanged");
});

test("a factor above one zooms in and below one zooms out", () => {
  const fit = fitView(LIMIT);
  const focus = { x: 500, y: 200 };

  assert.ok(zoomView(fit, 1.25, focus, LIMIT).w < fit.w, "1.25 magnifies");
  assert.ok(zoomView(fit, 0.8, focus, LIMIT).w > fit.w, "0.8 shrinks");
});

test("zooming in then out returns to where it started", () => {
  const once = zoomView(fitView(LIMIT), 1.25, { x: 500, y: 200 }, LIMIT);
  const twice = zoomView(once, 1 / 1.25, { x: 500, y: 200 }, LIMIT);
  near(twice.w, LIMIT.w, "width back to full");
  near(twice.x, 0, "and back to the left edge");
});

test("clamping wins over the cursor when the zoom would leave the drawing", () => {
  // Aiming hard at the top-right corner: the new window would hang off the
  // drawing, so it is pinned to the edge instead of the cursor staying put.
  // Showing a focus-anchored window that runs off the edge would expose blank
  // space where the chart should be.
  const zoomed = zoomView(fitView(LIMIT), 1.25, { x: 1000, y: 0 }, LIMIT);
  assert.ok(zoomed.x + zoomed.w <= LIMIT.w + 1e-9, "no blank space on the right");
  assert.ok(zoomed.y >= -1e-9, "no blank space above");
});

test("zoom is bounded at both ends", () => {
  const zoomedIn = zoomView(fitView(LIMIT), 100000, { x: 500, y: 200 }, LIMIT);
  assert.ok(zoomedIn.w >= LIMIT.w / MAX_SCALE, `stopped zooming in at ${zoomedIn.w}`);

  const zoomedOut = zoomView(fitView(LIMIT), 10000, { x: 500, y: 200 }, LIMIT);
  assert.ok(
    zoomedOut.w <= LIMIT.w / MIN_SCALE,
    `stopped zooming out at ${zoomedOut.w}`,
  );
});

test("a nonsense factor leaves the view alone rather than breaking it", () => {
  const view = fitView(LIMIT);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(zoomView(view, bad, { x: 0, y: 0 }, LIMIT), view, `factor ${bad}`);
  }
});

test("the window cannot be panned off the drawing", () => {
  const view: ViewBox = { x: 0, y: 0, w: 500, h: 200 };

  const right = panView(view, 99999, 0, LIMIT);
  near(right.x, LIMIT.w - right.w, "stopped at the right edge");

  const left = panView(view, -99999, 0, LIMIT);
  near(left.x, 0, "stopped at the left edge");

  const up = panView(view, 0, -99999, LIMIT);
  near(up.y, 0, "stopped at the top");

  const down = panView(view, 0, 99999, LIMIT);
  near(down.y, LIMIT.h - down.h, "stopped at the bottom");
});

test("zooming out past the drawing centres instead of pinning to an edge", () => {
  // A window wider than the limit has no valid position, so it must be centred.
  const view = clampView({ x: 0, y: 0, w: 2000, h: 900 }, LIMIT);
  near(view.x, (LIMIT.w - 2000) / 2, "centred horizontally");
  near(view.y, (LIMIT.h - 900) / 2, "centred vertically");
});

test("panning and zooming compose without escaping", () => {
  let view = fitView(LIMIT);
  for (let step = 0; step < 40; step += 1) {
    view = zoomView(view, 1.25, { x: 500, y: 200 }, LIMIT);
    view = panView(view, 40, 25, LIMIT);
    view = zoomView(view, 1 / 1.25, { x: 120, y: 90 }, LIMIT);
  }
  assert.ok(view.w >= LIMIT.w / MAX_SCALE - 1e-9);
  assert.ok(view.w <= LIMIT.w / MIN_SCALE + 1e-9);
  assert.ok(view.x >= -1e-9 && view.y >= -1e-9, "never negative");
  assert.ok(view.x + view.w <= LIMIT.w + 1e-9, "never past the right edge");
  assert.ok(view.y + view.h <= LIMIT.h + 1e-9, "never past the bottom");
});