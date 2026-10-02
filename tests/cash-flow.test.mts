import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMinimumThickness,
  buildCashFlowGraph,
  type LaidOutNode,
  cashFlowWindow,
  DEFICIT_NODE_ID,
  isEmptyGraph,
  LEFTOVER_NODE_ID,
  UNASSIGNED_NODE_ID,
  type FlowBucket,
} from "@/lib/cash-flow";

/**
 * A Sankey is a claim about money: the ribbons are supposed to add up to the
 * totals printed beside them. These tests defend that claim, plus the two cases
 * that make a naive implementation quietly wrong - a month that overspends, and a
 * month where nothing happened.
 */

const income = (amount: number, label = "Salary"): FlowBucket => ({
  id: `income:${label}`,
  label,
  kind: "income",
  amount,
});

const spend = (amount: number, label = "Rent"): FlowBucket => ({
  id: `spend:${label}`,
  label,
  kind: "spending",
  amount,
  budgeted: amount,
});

/** Every ribbon out of a node, summed. */
const outOf = (graph: ReturnType<typeof buildCashFlowGraph>, id: string) =>
  graph.links.filter((l) => l.source === id).reduce((n, l) => n + l.value, 0);

/** Every ribbon into a node, summed. */
const into = (graph: ReturnType<typeof buildCashFlowGraph>, id: string) =>
  graph.links.filter((l) => l.target === id).reduce((n, l) => n + l.value, 0);

test("a month that saved money ends in a Remaining node", () => {
  const graph = buildCashFlowGraph({
    income: [income(3000)],
    spending: [spend(2000, "Rent"), spend(500, "Groceries")],
  });

  assert.equal(graph.totals.income, 3000);
  assert.equal(graph.totals.spending, 2500);
  assert.equal(graph.totals.remaining, 500);

  const leftover = graph.nodes.find((n) => n.id === LEFTOVER_NODE_ID);
  assert.ok(leftover, "Remaining must exist when income beat spending");
  assert.equal(leftover?.kind, "leftover");
  assert.equal(leftover?.amount, 500);
});

test("ribbons out of every source equal that source exactly", () => {
  // 1/3 splits are where naive proportional maths accumulates visible error.
  const graph = buildCashFlowGraph({
    income: [income(1000, "A"), income(2000, "B")],
    spending: [spend(333, "One"), spend(667, "Two"), spend(1000, "Three")],
  });

  for (const node of graph.nodes.filter((n) => n.kind === "income")) {
    assert.equal(
      outOf(graph, node.id),
      node.amount,
      `${node.label} must distribute its whole amount`,
    );
  }
});

test("ribbons into every target total that target", () => {
  const graph = buildCashFlowGraph({
    income: [income(999.99, "A"), income(1234.56, "B")],
    spending: [spend(17.31, "Coffee"), spend(450, "Rent")],
  });

  /*
   * Tolerance, not equality, and deliberately so. A proportional split pins the
   * source side exactly (the last slot absorbs the remainder) but cannot pin both
   * sides at once in binary floating point - summing `source * share` across
   * sources drifts by ~1e-14. That is a ten-thousandth of a cent, far below the
   * 4-decimal precision money is stored at, so it is not worth a matrix-scaling
   * pass to eliminate. What matters is that it stays negligible.
   */
  for (const node of graph.nodes.filter((n) => n.kind === "spending")) {
    const received = into(graph, node.id);
    assert.ok(
      Math.abs(received - node.amount) < 1e-9,
      `${node.label} received ${received}, expected ${node.amount}`,
    );
  }
});

test("an overspending month gets an explicit From savings node", () => {
  const graph = buildCashFlowGraph({
    income: [income(1000)],
    spending: [spend(1400, "Rent")],
  });

  assert.equal(graph.totals.remaining, -400);

  const deficit = graph.nodes.find((n) => n.id === DEFICIT_NODE_ID);
  assert.ok(deficit, "the shortfall must be a node, not a rescaled ribbon");
  assert.equal(deficit?.kind, "deficit");
  assert.equal(deficit?.amount, 400);

  /*
   * The important part: the diagram still balances. Income + shortfall == spending.
   */
  const totalIn = graph.nodes
    .filter((n) => n.kind === "income" || n.kind === "deficit")
    .reduce((n, node) => n + node.amount, 0);
  assert.equal(totalIn, graph.totals.spending);
  assert.equal(into(graph, "spend:Rent"), 1400);
});

test("no Remaining node in an overspending month", () => {
  const graph = buildCashFlowGraph({
    income: [income(100)],
    spending: [spend(250)],
  });

  assert.equal(
    graph.nodes.find((n) => n.id === LEFTOVER_NODE_ID),
    undefined,
    "a negative leftover is a deficit, not a Remaining node",
  );
});

test("spending with no income at all still draws", () => {
  // Guard against dividing by a zero income total.
  const graph = buildCashFlowGraph({ income: [], spending: [spend(500)] });

  assert.equal(graph.totals.remaining, -500);
  assert.equal(outOf(graph, DEFICIT_NODE_ID), 500);
  assert.equal(into(graph, "spend:Rent"), 500);
  assert.ok(!isEmptyGraph(graph));
});

test("income with no spending flows entirely to Remaining", () => {
  const graph = buildCashFlowGraph({ income: [income(750)], spending: [] });

  assert.equal(graph.totals.remaining, 750);
  assert.equal(outOf(graph, "income:Salary"), 750);
  assert.equal(into(graph, LEFTOVER_NODE_ID), 750);
});

test("an empty month produces nothing to draw", () => {
  const graph = buildCashFlowGraph({ income: [], spending: [] });

  assert.equal(graph.links.length, 0);
  assert.ok(isEmptyGraph(graph));
  assert.equal(graph.totals.income, 0);
});

test("zero and negative buckets are dropped, not drawn as empty ribbons", () => {
  const graph = buildCashFlowGraph({
    income: [income(1000), income(0, "Zero income"), income(-50, "Refund")],
    spending: [
      spend(400, "Rent"),
      spend(0, "Nothing spent"),
      { ...spend(10, "Reversal"), amount: -10 },
    ],
  });

  const labels = graph.nodes.map((n) => n.label);
  assert.ok(!labels.includes("Zero income"));
  assert.ok(!labels.includes("Nothing spent"));
  assert.ok(!labels.includes("Reversal"));
  assert.equal(graph.totals.spending, 400);
});

test("unassigned spending is counted and shown, not dropped", () => {
  const graph = buildCashFlowGraph({
    income: [income(1000)],
    spending: [spend(600, "Rent")],
    unassigned: 150,
  });

  assert.equal(graph.totals.unassigned, 150);
  // Spending includes it, so Remaining is not overstated.
  assert.equal(graph.totals.spending, 750);
  assert.equal(graph.totals.remaining, 250);

  const node = graph.nodes.find((n) => n.id === UNASSIGNED_NODE_ID);
  assert.ok(node, "Unassigned must appear");
  assert.equal(node?.synthetic, true);
  assert.equal(into(graph, UNASSIGNED_NODE_ID), 150);
});

test("a zero unassigned total adds no node", () => {
  const graph = buildCashFlowGraph({
    income: [income(1000)],
    spending: [spend(600)],
    unassigned: 0,
  });

  assert.equal(graph.totals.unassigned, 0);
  assert.equal(
    graph.nodes.find((n) => n.id === UNASSIGNED_NODE_ID),
    undefined,
  );
});

test("buckets come back largest first, ties broken by label", () => {
  const graph = buildCashFlowGraph({
    income: [income(100, "Small"), income(900, "Big")],
    spending: [spend(50, "B"), spend(900, "A"), spend(50, "A")],
  });

  assert.deepEqual(
    graph.nodes.filter((n) => n.kind === "spending").map((n) => n.label),
    ["A", "A", "B"],
  );
  assert.deepEqual(
    graph.nodes.filter((n) => n.kind === "income").map((n) => n.label),
    ["Big", "Small"],
  );
});

test("budgeted is carried through for the tooltip but is never a flow", () => {
  const graph = buildCashFlowGraph({
    income: [income(1000)],
    spending: [{ ...spend(300, "Groceries"), budgeted: 400 }],
  });

  const node = graph.nodes.find((n) => n.label === "Groceries");
  assert.equal(node?.budgeted, 400);
  assert.equal(node?.amount, 300, "the flow is the actual, not the budget");

  const budgetTotal = graph.nodes.reduce((n, node) => n + (node.budgeted ?? 0), 0);
  assert.ok(
    !graph.links.some((l) => l.value === 400),
    "a budgeted figure must never become a ribbon",
  );
  assert.equal(budgetTotal, 400);
});

test("many sources and targets still balance to the cent", () => {
  const graph = buildCashFlowGraph({
    income: [income(3333.33, "A"), income(1234.57, "B"), income(0.1, "C")],
    spending: Array.from({ length: 17 }, (_, i) => spend(i * 37.19 + 11, `Cat ${i}`)),
  });

  // This one overspends, so "sources" includes the deficit node.
  const sources = graph.nodes.filter(
    (n) => n.kind === "income" || n.kind === "deficit",
  );
  const totalOut = sources.reduce((n, node) => n + outOf(graph, node.id), 0);
  const expected = graph.totals.spending + Math.max(graph.totals.remaining, 0);

  assert.ok(
    Math.abs(totalOut - expected) < 1e-9,
    `ribbons out (${totalOut}) must equal spending + remaining (${expected})`,
  );
});

test("the same holds in a month that saved", () => {
  const graph = buildCashFlowGraph({
    income: [income(5000, "Pay")],
    spending: Array.from({ length: 9 }, (_, i) => spend(120.5 + i, `Cat ${i}`)),
  });

  const sources = graph.nodes.filter(
    (n) => n.kind === "income" || n.kind === "deficit",
  );
  const totalOut = sources.reduce((n, node) => n + outOf(graph, node.id), 0);
  const expected = graph.totals.spending + graph.totals.remaining;

  assert.ok(Math.abs(totalOut - expected) < 1e-9);
  assert.ok(graph.totals.remaining > 0, "Remaining must be a real ribbon");
});
/**
 * The window behind `?scope=&year=&month=`.
 *
 * Two things here are load-bearing and easy to get wrong: a month view has to end
 * on the right number of days (a hardcoded 30 would silently drop the last day of
 * a 31-day month, and every transaction dated on it), and year-to-date has to
 * count only the months that have happened.
 */

const now = { currentYear: 2026, currentMonth: 10 };

test("a month window covers exactly that month", () => {
  assert.deepEqual(
    cashFlowWindow({ scope: "month", year: 2026, month: 10, ...now }),
    { from: "2026-10-01", to: "2026-10-31", months: 1, label: "October 2026" },
  );
});

test("month ends respect leap years", () => {
  assert.equal(
    cashFlowWindow({ scope: "month", year: 2024, month: 2, ...now }).to,
    "2024-02-29",
  );
  assert.equal(
    cashFlowWindow({ scope: "month", year: 2026, month: 2, ...now }).to,
    "2026-02-28",
  );
});

test("every month ends on a real last day", () => {
  const expected = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  expected.forEach((days, index) => {
    const window = cashFlowWindow({
      scope: "month", year: 2026, month: index + 1, ...now,
    });
    assert.equal(Number(window.to.slice(8)), days, `month ${index + 1}`);
  });
});

test("an out-of-range month is clamped, not allowed to overflow", () => {
  // A hand-edited ?month=13 must not roll into the next year.
  assert.equal(
    cashFlowWindow({ scope: "month", year: 2026, month: 13, ...now }).label,
    "December 2026",
  );
  assert.equal(
    cashFlowWindow({ scope: "month", year: 2026, month: 0, ...now }).label,
    "January 2026",
  );
  assert.equal(
    cashFlowWindow({ scope: "month", year: 2026, month: Number.NaN, ...now }).label,
    "January 2026",
  );
});

test("year to date spans the calendar year", () => {
  const window = cashFlowWindow({ scope: "ytd", year: 2024, month: 1, ...now });
  assert.equal(window.from, "2024-01-01");
  assert.equal(window.to, "2024-12-31");
  assert.equal(window.label, "2024 to date");
});

test("year to date counts only the months that have happened", () => {
  // A finished year: all twelve budgets were in play.
  assert.equal(
    cashFlowWindow({ scope: "ytd", year: 2025, month: 1, ...now }).months,
    12,
  );
  // This year, in October: ten months, not twelve.
  assert.equal(
    cashFlowWindow({ scope: "ytd", year: 2026, month: 1, ...now }).months,
    10,
  );
});

test("year to date never divides by zero months", () => {
  const future = cashFlowWindow({ scope: "ytd", year: 2030, month: 1, ...now });
  assert.ok(future.months >= 1, "scaling a budget by zero would blank it out");
});

/**
 * The visible-thickness floor.
 *
 * d3-sankey scales one linear px-per-dollar across the whole diagram, so a month
 * with one dominant category renders everything else sub-pixel. These defend the
 * two properties that make flooring safe rather than merely visible: bars already
 * legible are left exactly alone, and the reported totals are never touched.
 */


/** A laid-out two-column diagram: one source, a stack of targets. */
function layout(pairs: [string, number][], total: number, ky: number, pad = 10) {
  const source: LaidOutNode = { x0: 0, y0: 0, y1: total * ky };
  const targets: LaidOutNode[] = [];
  const links: L[] = [];
  let y = 0;
  for (const [label, value] of pairs) {
    const width = Math.max(1, value * ky);
    const node: LaidOutNode = { x0: 100, y0: y, y1: y + width };
    targets.push(node);
    links.push({ width, source, target: node });
    y += width + pad;
    void label;
  }
  return { nodes: [source, ...targets], links };
}

test("a sub-pixel bar is raised to the floor", () => {
  const { nodes, links } = layout([["Rent", 1527], ["Insurance", 9]], 1600, 0.1);
  const before = nodes[2]!.y1 - nodes[2]!.y0;

  applyMinimumThickness(nodes, links, 3);

  // d3-sankey already clamps to 1px, which is why this looked like a rendering
  // bug rather than a missing feature: 1px is a line, not a bar.
  assert.ok(before < 3, `precondition: the bar starts below the floor (${before})`);
  assert.equal(nodes[2]!.y1 - nodes[2]!.y0, 3);
});

test("a bar that was already legible keeps its exact height", () => {
  const { nodes, links } = layout([["Rent", 1527], ["Groceries", 133]], 1600, 0.1);
  const before = nodes[2]!.y1 - nodes[2]!.y0;

  applyMinimumThickness(nodes, links, 3);

  assert.ok(before >= 3, "precondition");
  assert.equal(nodes[2]!.y1 - nodes[2]!.y0, before);
});

test("an entirely comfortable diagram is left byte-identical", () => {
  const { nodes, links } = layout(
    [["Rent", 1500], ["Food", 900], ["Fuel", 400]],
    2800,
    0.1,
  );
  const before = JSON.stringify({ nodes, links });

  applyMinimumThickness(nodes, links, 3);

  // Positions included: re-stacking must not shuffle bars that needed no room.
  assert.equal(JSON.stringify({ nodes, links }), before);
});

test("the gaps between bars survive re-stacking", () => {
  const { nodes, links } = layout([["Rent", 400], ["Tiny", 2], ["Food", 400]], 900, 0.1, 10);
  const gapBefore = nodes[2]!.y0 - nodes[1]!.y1;

  applyMinimumThickness(nodes, links, 3);

  const target = nodes.find((n) => n.x0 === 100 && n.y0 > nodes[1]!.y1)!;
  assert.equal(target.y0 - nodes[1]!.y1, gapBefore, "padding must be preserved");
});

test("a bar is tall enough for the ribbons that meet it", () => {
  // Two thin ribbons into one bar: the bar must hold both, not just the floor.
  const source: LaidOutNode = { x0: 0, y0: 0, y1: 4 };
  const target: LaidOutNode = { x0: 100, y0: 0, y1: 0.5 };
  const links: L[] = [
    { width: 0.4, source, target },
    { width: 0.4, source, target },
  ];

  applyMinimumThickness([source, target], links, 3);

  assert.ok(target.y1 - target.y0 >= 6, "two 3px ribbons need 6px");
  assert.ok(links.every((l) => l.width >= 3), "each ribbon floored");
});

test("flooring reports how much taller the diagram got", () => {
  const { nodes, links } = layout([["Rent", 1527], ["Insurance", 9]], 1600, 0.1);
  const { grew } = applyMinimumThickness(nodes, links, 3);

  assert.ok(grew > 0, "the floor must make room for itself");
  assert.ok(grew < 10, `and only as much as it needs (${grew})`);
});

test("flooring never invents or removes a node", () => {
  const graph = buildCashFlowGraph({
    income: [income(1000)],
    spending: [spend(998, "Rent"), spend(2, "Coffee")],
  });
  const before = graph.nodes.map((n) => `${n.id}:${n.kind}`).sort();
  const beforeTotals = { ...graph.totals };

  const { nodes, links } = layout(
    [["Rent", 999], ["Coffee", 2]],
    1001,
    0.1,
  );
  applyMinimumThickness(nodes, links, 3);

  // The graph the caller keeps reporting from is untouched; only pixels moved.
  assert.deepEqual(graph.nodes.map((n) => `${n.id}:${n.kind}`).sort(), before);
  assert.deepEqual(graph.totals, beforeTotals);
  assert.equal(graph.totals.remaining, 0);
});

/**
 * Ribbon endpoints, which are the one thing flooring can silently break.
 *
 * d3-sankey bakes each ribbon's two ends into the link as absolute pixels and the
 * path generator reads them verbatim. Move a node or widen a ribbon without
 * rebuilding them and the geometry stops describing the bars it is drawn between:
 * the small bars, which are exactly the ones that get floored and moved, end up
 * with ribbons pointing at thin air beside their own labels.
 */
type L = {
  width: number;
  y0?: number;
  y1?: number;
  source: LaidOutNode;
  target: LaidOutNode;
};

/** Attach the ribbon lists d3-sankey maintains, so flooring can find them. */
function wire(
  nodes: LaidOutNode[],
  links: L[],
  outgoing: Record<number, number[]>,
  incoming: Record<number, number[]>,
): LaidOutNode[] {
  for (const [from, targets] of Object.entries(outgoing)) {
    nodes[Number(from)]!.sourceLinks = targets.map((t) => links[t]!);
  }
  for (const [to, sources] of Object.entries(incoming)) {
    nodes[Number(to)]!.targetLinks = sources.map((s) => links[s]!);
  }
  return nodes;
}

const within = (value: number, node: LaidOutNode) =>
  value >= node.y0 - 1e-6 && value <= node.y1 + 1e-6;

test("every ribbon ends on the bar it belongs to, after flooring", () => {
  const source: LaidOutNode = { x0: 0, y0: 0, y1: 400 };
  // Three bars, two of them floored from 0.2px, with real gaps between them.
  const bars: LaidOutNode[] = [
    { x0: 200, y0: 0, y1: 300 },
    { x0: 200, y0: 316, y1: 316.2 },
    { x0: 200, y0: 334, y1: 334.2 },
  ];
  const links: L[] = bars.map((bar) => ({ width: 0.2, source, target: bar }));
  const nodes = wire([source, ...bars], links, { 0: [0, 1, 2] }, { 1: [0], 2: [1], 3: [2] });

  assert.ok(bars[1]!.y1 - bars[1]!.y0 < 3, "precondition: two bars start floored");

  applyMinimumThickness(nodes, links, 3);

  for (const link of links) {
    assert.ok(within(link.y0!, link.source), "leaves the source inside it");
    assert.ok(within(link.y1!, link.target), "meets the target inside it");
    assert.ok(link.width! >= 3, "and at the floor width");
  }
});

test("ribbon endpoints are rebuilt when a node moves", () => {
  const source: LaidOutNode = { x0: 0, y0: 0, y1: 10 };
  const bar: LaidOutNode = { x0: 200, y0: 100, y1: 100.2 };
  const links: L[] = [{ width: 0.2, source, target: bar }];
  const nodes = wire([source, bar], links, { 0: [0] }, { 1: [0] });

  const staleEnd = links[0]!.y1;

  applyMinimumThickness(nodes, links, 3);

  assert.equal(bar.y1 - bar.y0, 3, "the bar grew to the floor");
  assert.notEqual(links[0]!.y1, staleEnd, "so the ribbon moved with it");
  assert.ok(within(links[0]!.y1!, bar), "and still lands on it");
});

test("an untouched diagram keeps d3-sankey's own endpoints", () => {
  // Widths already add up to each node's height, which is d3-sankey's own
  // invariant, so rebuilding must reproduce its arithmetic rather than shift it.
  const source: LaidOutNode = { x0: 0, y0: 0, y1: 100 };
  const a: LaidOutNode = { x0: 200, y0: 0, y1: 60 };
  const b: LaidOutNode = { x0: 200, y0: 70, y1: 110 };
  const links: L[] = [
    { width: 60, y0: 30, y1: 30, source, target: a },
    { width: 40, y0: 80, y1: 90, source, target: b },
  ];
  const nodes = wire([source, a, b], links, { 0: [0, 1] }, { 1: [0], 2: [1] });

  applyMinimumThickness(nodes, links, 3);

  // Source: 60px ribbon centred at 30, then 40px centred at 80.
  assert.equal(links[0]!.y0, 30);
  assert.equal(links[1]!.y0, 80);
  // Targets: a spans 0-60 so its ribbon centres at 30; b spans 70-110 at 90.
  assert.equal(links[0]!.y1, 30);
  assert.equal(links[1]!.y1, 90);
});

test("ribbons are centred in a bar taller than they need", () => {
  const source: LaidOutNode = { x0: 0, y0: 0, y1: 8 };
  const bar: LaidOutNode = { x0: 200, y0: 100, y1: 120 };
  const links: L[] = [{ width: 8, source, target: bar }];
  const nodes = wire([source, bar], links, { 0: [0] }, { 1: [0] });

  applyMinimumThickness(nodes, links, 3);

  // 8px of ribbon in a 20px bar: 6px of slack, 3px each side, so the ribbon
  // centre lands at 110 rather than hanging off the top.
  assert.equal(links[0]!.y1, 110);
});
