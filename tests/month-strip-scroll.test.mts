import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The month strip's scroll geometry.
 *
 * This exists as a test because the same visual bug shipped twice by two different
 * mechanisms, and neither was caught by looking at the code.
 *
 * 1. `scroll-snap-type: x mandatory` with `snap-align: start`. A tile can only snap
 *    flush to its start edge, so the last tiles' snap positions sit beyond
 *    `maxScroll` and are unreachable. Twelve 72px tiles with an 8px gap is 952px of
 *    content, and at every width narrow enough to scroll at all, December's snap
 *    point is past the end. Mandatory snapping had no valid target and left the tile
 *    wherever the programmatic scroll put it.
 * 2. `scrollIntoView({ inline: "nearest" })`. This scrolls the minimum distance to
 *    make a tile visible, which lands a few pixels off a tile boundary; the browser
 *    then reconciled it with the snap rule and pulled the tile back, half off screen.
 *
 * Both only misbehave for the last few tiles at particular widths, which is the
 * range nobody checks by hand. So the arithmetic is pinned here across a spread of
 * container widths instead.
 */
const { stripScrollTarget, stripSnapPosition, stripTileIsVisible } = await import(
  "@/lib/month-strip",
);

const TILE = 72;
const GAP = 8;
const STRIDE = TILE + GAP;
const MONTHS = 12;
const CONTENT = MONTHS * STRIDE - GAP;

/** Every month in the year, at this container width, from a fresh load. */
function revealAllFromStart(view: number): { scroll: number; tileLeft: number }[] {

  return Array.from({ length: MONTHS }, (_, i) => {
    const tileLeft = i * STRIDE;
    return {
      scroll: stripScrollTarget({
        tileLeft,
        tileWidth: TILE,
        currentScroll: 0,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      }),
      tileLeft,
    };
  });
}

const WIDTHS = [420, 520, 600, 700, 760, 880, 940];

for (const view of WIDTHS) {
  test(`every month of the year is fully visible at ${view}px`, () => {
    for (const { scroll, tileLeft } of revealAllFromStart(view)) {
      assert.ok(
        tileLeft >= scroll - 0.5 && tileLeft + TILE <= scroll + view + 0.5,
        `month at ${tileLeft} is cut off: scroll ${scroll}, view ends ${scroll + view}`,
      );
    }
  });
}

test("the last month lands flush against the right edge", () => {
  const { scroll, tileLeft } = revealAllFromStart(600).at(-1)!;
  assert.equal(scroll + 600, tileLeft + TILE, "December sits against the end");
});

test("the first month lands flush against the left edge", () => {
  const { scroll } = revealAllFromStart(600)[0]!;
  assert.equal(scroll, 0);
});

test("a month already in view does not move the strip", () => {
  // October sits well inside a 600px window at rest, so nothing should move.
  const next = stripScrollTarget({
    tileLeft: 5 * STRIDE,
    tileWidth: TILE,
    currentScroll: 0,
    viewWidth: 600,
    contentWidth: CONTENT,
    stride: STRIDE,
  });
  assert.equal(next, 0, "no scroll for a tile that is already fully visible");
});

test("the target is always a position the strip can reach", () => {
  for (const view of WIDTHS) {
    const max = Math.max(CONTENT - view, 0);
    for (const { scroll } of revealAllFromStart(view)) {
      assert.ok(
        scroll >= 0 && scroll <= max,
        `scroll ${scroll} outside [0, ${max}] at ${view}px`,
      );
    }
  }
});

test("the target is on a tile boundary, or it is because no boundary fits", () => {
  /*
   * Off-boundary positions are now deliberate: when the only scroll positions that
   * show a tile whole are narrower than the stride, there is no boundary to land on
   * and rounding to one would cut the tile off. So the invariant is not "always on a
   * boundary" but "on a boundary, or still fully visible".
   */
  for (const view of WIDTHS) {
    const max = Math.max(CONTENT - view, 0);
    for (const { scroll, tileLeft } of revealAllFromStart(view)) {
      const onBoundary = scroll % STRIDE === 0 || scroll === max;
      const whole = stripTileIsVisible({
        tileLeft,
        tileWidth: TILE,
        scroll,
        viewWidth: view,
      });
      assert.ok(
        onBoundary || whole,
        `scroll ${scroll} is neither a boundary nor safe (max ${max}, tile ${tileLeft})`,
      );
    }
  }
});

test("a degenerate stride is refused rather than dividing by zero", () => {
  assert.equal(
    stripScrollTarget({
      tileLeft: 500,
      tileWidth: TILE,
      currentScroll: 120,
      viewWidth: 600,
      contentWidth: CONTENT,
      stride: 0,
    }),
    120,
    "leaves the strip where it was",
  );
});
/*
 * The settle-after-a-drag path, which has no particular tile in mind - only a
 * position that should not be left resting between two tiles.
 */
test("a dragged position settles onto a tile boundary", () => {
  for (const view of WIDTHS) {
    const max = Math.max(CONTENT - view, 0);
    for (const drag of [0, 37, 79, 80, 81, 160, max - 11, max]) {
      const snapped = stripSnapPosition({
        left: drag,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      });
      const onBoundary = snapped % STRIDE === 0;
      assert.ok(
        onBoundary || snapped === max,
        `drag ${drag} settled to ${snapped}, which is neither a boundary nor ${max}`,
      );
      assert.ok(snapped >= 0 && snapped <= max);
      /*
       * Never moves further than it must: one rounding step, except at the ends of
       * the scroll range where clamping is unavoidable.
       */
      const moved = Math.abs(snapped - drag);
      assert.ok(
        moved <= STRIDE / 2 || snapped === 0 || snapped === max,
        `drag ${drag} moved ${moved}px to ${snapped}`,
      );
    }
  }
});

test("stripTileIsVisible is the assertion the width tests are really making", () => {
  for (const view of WIDTHS) {
    for (const { scroll, tileLeft } of revealAllFromStart(view)) {
      assert.ok(
        stripTileIsVisible({
          tileLeft,
          tileWidth: TILE,
          scroll,
          viewWidth: view,
        }),
        `month at ${tileLeft} cut off at ${view}px (scroll ${scroll})`,
      );
    }
  }
});

/*
 * A free drag is free.
 *
 * An earlier version made the settle selection-aware: it refused to settle on a
 * boundary that clipped the *selected* month, so any drag long enough to push that
 * month towards an edge got hauled back on release. It was introduced to stop the
 * settle undoing the reveal, and it fixed December while making the strip feel like
 * it was fighting you - which is worse than the bug it replaced.
 *
 * Selection belongs to the reveal, and the reveal runs when the month changes. The
 * settle only has to leave the strip on a boundary.
 */

test("a free drag snaps to the nearest boundary and ignores the selection", () => {
  for (const view of WIDTHS) {
    const max = Math.max(CONTENT - view, 0);
    for (const drag of [0, 37, 79, 80, 81, 137, 260, max - 11, max]) {
      if (drag < 0 || drag > max) continue;
      const settled = stripSnapPosition({
        left: drag,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      });
      assert.ok(
        settled % STRIDE === 0 || settled === max,
        `drag ${drag} settled to ${settled}, neither a boundary nor the end`,
      );
      assert.ok(settled >= 0 && settled <= max);
      /*
       * At most one rounding step, so the strip never jumps further than the
       * gesture did - except at the ends of the range, where clamping is
       * unavoidable and the position is the end either way.
       */
      const moved = Math.abs(settled - drag);
      assert.ok(
        moved <= STRIDE / 2 || settled === 0 || settled === max,
        `drag ${drag} moved ${moved}px to ${settled}`,
      );
    }
  }
});

test("the strip is free to end a drag far from the selected month", () => {
  /*
   * The regression, stated as an invariant. Whatever month is selected, a drag can
   * settle anywhere along the strip: pulling it back toward the selection is the
   * behaviour that had to be removed.
   */
  const view = 600;
  const max = Math.max(CONTENT - view, 0);
  for (const drag of [0, 80, 160, 240, 320]) {
    assert.equal(
      stripSnapPosition({
        left: drag,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      }),
      drag,
      `a drag that already lands on a boundary must be left exactly where it is`,
    );
  }
  // The end of the strip is reachable at rest, so the last tile is not left clipped.
  assert.equal(
    stripSnapPosition({
      left: max,
      viewWidth: view,
      contentWidth: CONTENT,
      stride: STRIDE,
    }),
    max,
  );
});

/*
 * The settle must not undo the reveal - the original December bug.
 *
 * December is the only tile that can need the strip at `maxScroll`, and `maxScroll`
 * is rarely a whole number of strides from zero, so its reveal target is off-boundary.
 * The settle firing off the reveal's own scroll event used to round that back and cut
 * December off again by up to 32px. It is prevented by not settling programmatic
 * scrolls at all, which cannot be asserted here - but the arithmetic that made it
 * bite can: a reveal position must survive a settle unchanged.
 */
test("a revealed month survives a settle on its own position", () => {
  for (const view of WIDTHS) {
    for (let i = 0; i < MONTHS; i++) {
      const tileLeft = i * STRIDE;
      const revealed = stripScrollTarget({
        tileLeft,
        tileWidth: TILE,
        currentScroll: 0,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      });
      const settled = stripSnapPosition({
        left: revealed,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      });
      assert.ok(
        stripTileIsVisible({
          tileLeft,
          tileWidth: TILE,
          scroll: settled,
          viewWidth: view,
        }),
        `month ${i + 1} hidden at ${view}px (revealed ${revealed}, settled ${settled})`,
      );
    }
  }
});

test("the end of the strip is a resting place, not just a limit", () => {
  for (const view of WIDTHS) {
    const max = Math.max(CONTENT - view, 0);
    if (max === 0) continue;
    assert.equal(
      stripSnapPosition({
        left: max,
        viewWidth: view,
        contentWidth: CONTENT,
        stride: STRIDE,
      }),
      max,
      `a drag to the very end must be able to stay there at ${view}px`,
    );
    // And the last month is therefore whole after dragging to the end.
    assert.ok(
      stripTileIsVisible({
        tileLeft: (MONTHS - 1) * STRIDE,
        tileWidth: TILE,
        scroll: max,
        viewWidth: view,
      }),
      `last month clipped after a drag to the end at ${view}px`,
    );
  }
});
