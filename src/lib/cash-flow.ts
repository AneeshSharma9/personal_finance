/**
 * Cash flow, shaped into a Sankey graph.
 *
 * Kept pure and separate from the query because the interesting decisions are all
 * here, and none of them should need a database to test: what happens in a month
 * that overspends, whether a bucket with no activity earns a ribbon, and whether
 * the ribbons add up.
 *
 * The shape is the one Monarch uses: income on the left, what it was spent on on
 * the right, and whatever survived in the middle-bottom.
 */

export type FlowBucket = {
  /** Stable across renders, and unique across income/spending. */
  id: string;
  label: string;
  kind: "income" | "spending";
  /** The budget row this came from, for linking to it. Absent on synthetic rows. */
  budgetId?: number;
  /** Actual money in or out, always positive. */
  amount: number;
  /** Budgeted for the same window, for context only - never a flow. */
  budgeted?: number;
  /**
   * What the bucket contains, by category, largest first. Sums to `amount`.
   * Drives the click-to-expand drill-down; absent means there is nothing to show.
   */
  breakdown?: { category: string; amount: number }[];
};

export type SankeyNodeSpec = {
  id: string;
  label: string;
  kind: "income" | "deficit" | "spending" | "leftover";
  /** Carried through so the table can link a bucket to its transactions. */
  budgetId?: number;
  amount: number;
  /** Set on spending nodes, to show plan vs actual in the tooltip. */
  budgeted?: number;
  /** True when the node is "everything else" rather than a real bucket. */
  synthetic?: boolean;
  /** Per-category split, carried through untouched for the drill-down. */
  breakdown?: { category: string; amount: number }[];
};

export type SankeyLinkSpec = {
  source: string;
  target: string;
  value: number;
};

export type CashFlowGraph = {
  nodes: SankeyNodeSpec[];
  links: SankeyLinkSpec[];
  totals: {
    income: number;
    spending: number;
    /** Positive when income beat spending. Negative when it did not. */
    remaining: number;
    /** Spending with no bucket assigned to it. Part of `spending`. */
    unassigned: number;
  };
};

export type BuildInput = {
  income: FlowBucket[];
  spending: FlowBucket[];
  /** Spending whose transactions have no bucket. Counted, not hidden. */
  unassigned?: number;
};

/**
 * Bucket for spending that never got assigned. Given its own node rather than
 * folded into a category, because "Unassigned" is a to-do, not a category - and
 * the app already has a queue for it.
 */
export const UNASSIGNED_NODE_ID = "unassigned";
export const UNASSIGNED_LABEL = "Unassigned";
export const DEFICIT_NODE_ID = "deficit";
export const DEFICIT_LABEL = "From savings";
export const LEFTOVER_NODE_ID = "leftover";
export const LEFTOVER_LABEL = "Remaining";

/**
 * Build the graph.
 *
 * Two rules do most of the work:
 *
 * 1. **The diagram always balances.** A Sankey whose ribbons do not meet is
 *    either lying or unreadable, so when spending exceeds income the shortfall
 *    becomes an explicit "From savings" node on the income side. That keeps the
 *    flow honest - it shows the month was funded by money that was not earned -
 *    instead of silently rescaling ribbons that no longer match the totals.
 *
 * 2. **Zero is not a ribbon.** A bucket with no activity is dropped rather than
 *    given a zero-width node and a label, which would otherwise put a dozen empty
 *    rows down the side of a quiet month.
 */
export function buildCashFlowGraph({
  income,
  spending,
  unassigned = 0,
}: BuildInput): CashFlowGraph {
  // Ascending by amount, then by label, so equal amounts order deterministically
  // instead of depending on the database's row order.
  const clean = (rows: FlowBucket[]): FlowBucket[] =>
    rows
      .filter((row) => Number.isFinite(row.amount) && row.amount > 0)
      .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));

  const incomeRows = clean(income);
  const spendingRows = clean(spending);

  const hasUnassigned = Number.isFinite(unassigned) && unassigned > 0;

  const incomeTotal = sum(incomeRows);
  const spendingTotal = sum(spendingRows) + (hasUnassigned ? unassigned : 0);
  const remaining = incomeTotal - spendingTotal;

  const nodes: SankeyNodeSpec[] = [];
  const links: SankeyLinkSpec[] = [];

  for (const row of incomeRows) {
    nodes.push({
      id: row.id,
      label: row.label,
      kind: "income",
      budgetId: row.budgetId,
      amount: row.amount,
    });
  }

  /*
   * The shortfall, if any. Added before the spending nodes so it sits with the
   * other inflows on the left.
   */
  if (remaining < 0) {
    nodes.push({
      id: DEFICIT_NODE_ID,
      label: DEFICIT_LABEL,
      kind: "deficit",
      amount: -remaining,
      synthetic: true,
    });
  }

  for (const row of spendingRows) {
    nodes.push({
      id: row.id,
      label: row.label,
      kind: "spending",
      budgetId: row.budgetId,
      amount: row.amount,
      budgeted: row.budgeted,
      breakdown: row.breakdown,
    });
  }

  if (hasUnassigned) {
    nodes.push({
      id: UNASSIGNED_NODE_ID,
      label: UNASSIGNED_LABEL,
      kind: "spending",
      amount: unassigned,
      synthetic: true,
    });
  }

  if (remaining > 0) {
    nodes.push({
      id: LEFTOVER_NODE_ID,
      label: LEFTOVER_LABEL,
      kind: "leftover",
      amount: remaining,
      synthetic: true,
    });
  }

  const targets = nodes.filter((node) => node.kind === "spending");
  const sources = nodes.filter(
    (node) => node.kind === "income" || node.kind === "deficit",
  );

  /*
   * Everything on the right is an "outflow slot": each spending bucket, plus
   * Remaining when there is one. Every source pays into all of them.
   *
   * Remaining has to be a slot like any other rather than a leftover remainder -
   * it is genuinely this month's unspent income, so it deserves a ribbon the same
   * width as the rest of the flow, and leaving it to absorb float drift made the
   * arithmetic depend on link order.
   */
  const outflow = [
    ...targets.map((node) => ({ id: node.id, amount: node.amount })),
    ...(remaining > 0 ? [{ id: LEFTOVER_NODE_ID, amount: remaining }] : []),
  ];
  const totalOut = sum(outflow);

  /*
   * Each source pays for every slot in proportion to the slot's size, which is
   * what makes the ribbon widths read as "this share of spending". One income
   * source is then a single unbroken ribbon; several of them braid.
   *
   * Sources and slots always total the same amount (see the comment above), so
   * handing the last slot the rounding remainder keeps every link summing exactly
   * instead of drifting a cent across a long fan.
   */
  if (totalOut > 0) {
    for (const source of sources) {
      let allocated = 0;

      outflow.forEach((slot, index) => {
        const isLast = index === outflow.length - 1;
        const value = isLast
          ? source.amount - allocated
          : (source.amount * slot.amount) / totalOut;
        allocated += value;

        if (value <= 0) return;
        links.push({ source: source.id, target: slot.id, value });
      });
    }
  }

  return {
    nodes,
    links,
    totals: {
      income: incomeTotal,
      spending: spendingTotal,
      remaining,
      unassigned: hasUnassigned ? unassigned : 0,
    },
  };
}

/** True when there is nothing worth drawing. */
export function isEmptyGraph(graph: CashFlowGraph): boolean {
  return graph.links.length === 0;
}

/**
 * The shape a laid-out Sankey has: nodes carrying pixel positions, links carrying
 * a pixel width. Structural rather than d3's own types so this can be reasoned
 * about - and tested - without importing the library.
 */
export type LaidOutNode = {
  x0: number;
  y0: number;
  y1: number;
  width?: number;
  /** Ribbons leaving this node, already ordered by d3-sankey. */
  sourceLinks?: LaidOutLink[];
  /** Ribbons arriving at this node, already ordered by d3-sankey. */
  targetLinks?: LaidOutLink[];
};

export type LaidOutLink = {
  width?: number;
  /** Centre of this ribbon where it leaves the source node. */
  y0?: number;
  /** Centre of this ribbon where it meets the target node. */
  y1?: number;
  source: LaidOutNode;
  target: LaidOutNode;
};

/**
 * Raise sub-pixel bars to a visible minimum, in pixel space, after layout.
 *
 * d3-sankey draws height as `value * ky`, one linear scale for the whole diagram,
 * so a single dominant category squeezes everything else out of existence. A $9
 * insurance bill inside a $4,255 month comes out at half a pixel: not a bar, an
 * anti-aliasing artefact, and it reads as a broken chart rather than a small
 * number. Extra height does not fix it either - doubling the canvas doubles half
 * a pixel to one.
 *
 * So the floor is applied here, to pixels, after the layout has decided
 * proportions. The distortion is deliberately bounded and one-directional:
 *
 *  - Only bars already too thin to see are touched. A bar that was legible keeps
 *    its exact height.
 *  - **Totals are not changed.** No node is added or removed, so a month that
 *    genuinely saved still shows *Remaining* and a month that genuinely overspent
 *    still shows *From savings*. Only the bar's thickness is approximate.
 *  - Exact figures are never in the geometry: they are in the label, the tooltip
 *    and the table underneath, which is why all three are always present.
 *
 * Nodes are then re-stacked so the ribbons that arrive at a bar still fit inside
 * it - a link is at least `minPx` wide, so a bar holding two of them must be.
 */
export function applyMinimumThickness(
  nodes: LaidOutNode[],
  links: LaidOutLink[],
  minPx: number,
): { grew: number } {
  for (const link of links) {
    link.width = Math.max(link.width ?? 0, minPx);
  }

  /*
   * A bar has to be tall enough for the ribbons meeting it, but not for the sum
   * of both ends - a middle node carries ribbons arriving *and* leaving, and
   * those share the same height rather than stacking.
   */
  const incoming = new Map<LaidOutNode, number>();
  const outgoing = new Map<LaidOutNode, number>();
  for (const link of links) {
    const width = link.width ?? 0;
    incoming.set(link.target, (incoming.get(link.target) ?? 0) + width);
    outgoing.set(link.source, (outgoing.get(link.source) ?? 0) + width);
  }

  // Nodes are laid out in columns; x0 is the column identity.
  const columns = new Map<number, LaidOutNode[]>();
  for (const node of nodes) {
    const column = columns.get(node.x0);
    if (column) column.push(node);
    else columns.set(node.x0, [node]);
  }

  let grew = 0;

  for (const column of columns.values()) {
    column.sort((a, b) => a.y0 - b.y0);

    const originalBottom = Math.max(...column.map((node) => node.y1));

    /*
     * The gaps between bars are the layout's node padding, and re-stacking has to
     * reproduce them - stacking each node flush against the one above it would
     * quietly close every gap in the diagram.
     */
    const gaps = column.map((node, index) =>
      index === 0 ? 0 : node.y0 - column[index - 1]!.y1,
    );

    let cursor = column[0]?.y0 ?? 0;

    for (const [index, node] of column.entries()) {
      const original = Math.max(node.y1 - node.y0, 0);
      const height = Math.max(
        original,
        incoming.get(node) ?? 0,
        outgoing.get(node) ?? 0,
        minPx,
      );
      cursor += gaps[index]!;
      node.y0 = cursor;
      node.y1 = cursor + height;
      cursor = node.y1;
    }

    grew = Math.max(grew, cursor - originalBottom);
  }

  /*
   * The part that is easy to miss, and the reason a floored bar can end up with
   * ribbons pointing at thin air.
   *
   * d3-sankey bakes each ribbon's two endpoints into the link as absolute pixels
   * - `y0` where it leaves the source, `y1` where it meets the target - and
   * `sankeyLinkHorizontal` reads them verbatim. Moving a node or widening a
   * ribbon invalidates both, so they have to be rebuilt here or the geometry no
   * longer describes the bars it is drawn between.
   *
   * Rebuilt the way d3-sankey builds them: accumulate each node's links down its
   * height in its existing order. Centred rather than top-aligned, because after
   * flooring a bar can be taller than the ribbons in it, and that slack is
   * better split evenly than dumped at the bottom.
   */
  for (const node of nodes) {
    placeLinks(node, node.sourceLinks, "y0");
    placeLinks(node, node.targetLinks, "y1");
  }

  return { grew };
}

/** Stack one node's ribbons down its height, centred. */
function placeLinks(
  node: LaidOutNode,
  links: LaidOutLink[] | undefined,
  key: "y0" | "y1",
): void {
  if (!links || links.length === 0) return;

  const total = links.reduce((sum, link) => sum + (link.width ?? 0), 0);
  let y = node.y0 + (node.y1 - node.y0 - total) / 2;

  for (const link of links) {
    const width = link.width ?? 0;
    link[key] = y + width / 2;
    y += width;
  }
}

export type CashFlowScope = "month" | "ytd";

export type CashFlowWindow = {
  from: string;
  to: string;
  /**
   * How many months the window covers. A budgeted figure is a monthly limit, so
   * year-to-date has to scale it or the tooltip compares twelve months of
   * spending against one month's allowance.
   */
  months: number;
  /** Human name for the window, used in headings and the accessible name. */
  label: string;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Resolve `?scope=&year=&month=` into a date range.
 *
 * Months are 1-based here to match the URL, unlike {@link monthRange}, which takes
 * a 0-based month because it is handed one straight from `Date`.
 *
 * Year-to-date runs the whole calendar year and counts the months that have
 * actually happened: twelve for a year in the past, but only up to the current
 * month for this one, so comparing a half-finished 2026 against twelve months of
 * budget does not make every bucket look overspent.
 */
export function cashFlowWindow({
  scope,
  year,
  month,
  currentYear,
  currentMonth,
}: {
  scope: CashFlowScope;
  year: number;
  /** 1-12. */
  month: number;
  currentYear: number;
  /** 1-12. */
  currentMonth: number;
}): CashFlowWindow {
  if (scope === "month") {
    const safeMonth = Math.min(Math.max(Math.trunc(month) || 1, 1), 12);
    const lastDay = new Date(Date.UTC(year, safeMonth, 0)).getUTCDate();
    return {
      from: `${year}-${String(safeMonth).padStart(2, "0")}-01`,
      to: `${year}-${String(safeMonth).padStart(2, "0")}-${lastDay}`,
      months: 1,
      label: `${MONTH_NAMES[safeMonth - 1]} ${year}`,
    };
  }

  const elapsed =
    year < currentYear ? 12 : year === currentYear ? currentMonth : 0;
  const months = Math.max(Math.min(elapsed, 12), 1);

  /*
   * `to` ends at the last day of the elapsed month, not December 31.
   *
   * Those disagree mid-year, and the disagreement was harmless while this page
   * was the only consumer - no transaction is dated in the future, so a wider `to`
   * returned the same rows. It stopped being harmless when the bucket page started
   * accepting this window and scaling its own budget by the months the range
   * touches: Jan 1 - Dec 31 spans twelve monthly budgets while `months` says ten,
   * so the same bucket would show "ten months budgeted" here and "twelve" there.
   *
   * Ending the window where the month count ends makes the two agree by
   * construction. A finished year is unaffected - twelve months, December 31.
   */
  const lastDay = new Date(Date.UTC(year, months, 0)).getUTCDate();

  return {
    from: `${year}-01-01`,
    to: `${year}-${String(months).padStart(2, "0")}-${lastDay}`,
    months,
    label: `${year} to date`,
  };
}

function sum(rows: { amount: number }[]): number {
  return rows.reduce((total, row) => total + row.amount, 0);
}