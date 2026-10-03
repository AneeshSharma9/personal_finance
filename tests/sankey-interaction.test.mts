import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Why the bars are resolved on `pointerup` rather than `onClick`.
 *
 * The drill-down shipped and did nothing: pressing a bar never opened it. The
 * data was fine - `d3-sankey` mutates nodes in place, so the per-bucket breakdown
 * survived the layout - and the handler was on the right element.
 *
 * The cause was the pan gesture. `onPointerDown` on the chart wrapper called
 * `setPointerCapture` immediately, and an element holding pointer capture also
 * receives the *compatibility mouse events* - `click` among them - regardless of
 * what is underneath the pointer. So every click on the diagram was retargeted to
 * the wrapper, the bars' own `onClick` never ran, and `toggleExpanded` was never
 * called from a mouse at all. Keyboard activation was unaffected, which is why it
 * looked like a rendering problem rather than an event one.
 *
 * There is no DOM test environment here, so this cannot be exercised by dispatching
 * events. These assertions pin the ordering that broke it, because the natural
 * refactor - "tidy up the drag handler" by capturing on pointerdown again - would
 * restore the bug with no test failing.
 */
const source = readFileSync("src/components/sankey-chart.tsx", "utf8");

/** The JSX handler body for `onPointerX={...}`, brace-matched from the brace. */
function handler(name: string): string {
  const at = source.indexOf(`on${name}=`);
  assert.notEqual(at, -1, `no on${name} handler`);
  let depth = 0;
  let seen = false;
  for (let i = source.indexOf("{", at); i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      seen = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced braces in on${name}`);
}

test("pointerdown does not capture, or clicks are retargeted away from the bars", () => {
  assert.doesNotMatch(
    handler("PointerDown"),
    /setPointerCapture/,
    "capturing on pointerdown steals the click from every bar - this is the bug",
  );
});

test("capture is taken on movement instead, once past a slop threshold", () => {
  const move = handler("PointerMove");
  assert.match(move, /setPointerCapture/);
  assert.match(
    move,
    /DRAG_SLOP_PX/,
    "capture must wait for real movement, or a click cannot be told from a drag",
  );
});

test("a clean press is resolved to a bar on pointerup", () => {
  const up = handler("PointerUp");
  assert.match(up, /draggedRef\.current/, "a drag must not also select");
  assert.match(
    up,
    /data-sankey-node/,
    "the bar under the pointer is found by attribute, since the wrapper is the " +
      "only element guaranteed to receive the event",
  );
  assert.match(up, /toggleExpanded/);
});

test("only the bar group carries the hit attribute, so links cannot select one", () => {
  const attr = source.match(/data-sankey-node=\{node\.id\}/g) ?? [];
  assert.equal(attr.length, 1, "exactly one element is marked as a selectable bar");
  assert.match(source, /const spec = node as SankeyNodeSpec/);
});

test("bars are given a wider invisible target than their visible width", () => {
  /*
   * The bars are `nodeWidth` across - about 12px - and the ones worth opening are
   * often the shortest, so the visible rectangle is a poor thing to ask someone to
   * press precisely.
   */
  assert.match(source, /pointerEvents="all"/);
  assert.match(source, /data-sankey-hit/);
});

test("the drill-down is reachable without a pointer", () => {
  const g = source.slice(source.indexOf("<g\n                    key={node.id}"));
  assert.match(g, /tabIndex=\{canExpand \? 0 : undefined\}/);
  assert.match(g, /role=\{canExpand \? "button" : undefined\}/);
  assert.match(g, /aria-expanded=\{canExpand \? isExpanded : undefined\}/);
  assert.match(
    g,
    /onKeyDown/,
    "keyboard activation must survive any pointer fix",
  );
});
