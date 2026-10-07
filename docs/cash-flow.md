# Cash flow

`/budgets/cash-flow` — where the money came from and where it went, as a Sankey.
Reached from a **Cash flow** button on the budgets page, which carries the month
across so the two views describe the same period.

Switchable between a single **month** and **year to date**, with a year row and a
month row above the chart. All of it is query parameters
(`?scope=month|ytd&year=&month=`), so every view is linkable and works with
JavaScript off.

## The diagram always balances

The interesting part is what happens when spending exceeds income. A Sankey whose
ribbons do not meet is either lying or unreadable, so the shortfall becomes an
explicit **From savings** node on the income side. The month is then honestly
shown as funded by money that was not earned, instead of ribbons being silently
rescaled away from the totals printed beside them.

`buildCashFlowGraph` (`src/lib/cash-flow.ts`) is pure and unit-tested for exactly
this: that every ribbon out of a source sums to that source, that the ribbons
into each target sum to it, and that neither holds by more than float noise. The
source side is pinned exactly by giving the last slot the rounding remainder; the
target side drifts by ~1e-14, which is four orders of magnitude below the
four-decimal precision money is stored at, so it is not worth a matrix-scaling
pass to eliminate.

**Zero is not a ribbon.** Buckets with no activity in the window are dropped
rather than given a zero-width node and a label, which would otherwise put a dozen
empty rows down the side of a quiet month.

## Income means the same thing here as everywhere else

Read from **earnings buckets**, exactly as the summary card and
`getMonthlySeries` do. Counting every negative amount would sweep in transfers
between the user's own accounts, so the Sankey would claim income the rest of the
app does not and its totals would not tie to the budgets page. The buckets decide
the shape of the diagram, so the diagram and the rule that fills the buckets have
to agree. The page says so on screen, because anyone comparing it to a bank's
"total inflows" line will otherwise think it is broken.

Unassigned spending gets its own node rather than being folded into a category —
it is a to-do, not a category, and there is already a queue for it. It is counted
because excluding it would let the diagram report a healthy *Remaining* while
real money went somewhere unlabelled.

## Year to date scales the budgeted column

A bucket's limit is monthly, so a twelve-month window compared against one
month's limit makes every bucket look overspent. `cashFlowWindow` counts only the
months that have actually happened: twelve for a finished year, up to the current
month for this one.

## Every bar is at least three pixels

d3-sankey draws height as `value * ky` — one linear px-per-dollar scale for the
whole diagram — so a single dominant category squeezes everything else out of
existence. Your September 2026 figures, at 0.065 px per dollar:

| bucket | amount | px, before |
| --- | --- | --- |
| Rent And Utilities | $1,527.21 | 93.31 |
| Savings/Debt | $1,053.91 | 64.39 |
| Groceries | $133.61 | 8.16 |
| Dining & Drinks | $36.04 | 2.20 |
| Insurance | $9.41 | **0.57** |

Half a pixel is an anti-aliasing artefact, not a bar, and it reads as a broken
chart rather than a small number. Extra height does not fix it either: doubling
the canvas doubles half a pixel to one. So `applyMinimumThickness` floors every
bar and ribbon at 3px in *pixel* space after the layout has chosen proportions.

The distortion is deliberately bounded and one-directional:

- Only bars already too thin to see are touched. A bar that was legible keeps its
  exact height — and an entirely comfortable month comes through byte-identical,
  which is a test.
- **Totals never move.** No node is added or removed, so a month that genuinely
  saved still shows *Remaining* and one that genuinely overspent still shows
  *From savings*. Only bar thickness is approximate.
- Nodes are re-stacked preserving their original padding, and a bar is grown to
  fit the ribbons meeting it, so nothing overflows or collides.
- The exact figure is never in the geometry. It is in the label, the tooltip and
  the table underneath, which is why all three are always present.

**Flooring invalidates the ribbon endpoints, and they have to be rebuilt.**
d3-sankey bakes each ribbon's two ends into the link as absolute pixels — `y0`
where it leaves the source, `y1` where it meets the target — and
`sankeyLinkHorizontal` reads them verbatim. Move a node or widen a ribbon without
recomputing both and the geometry stops describing the bars it is drawn between:
the small bars, which are exactly the ones that get floored and moved, end up with
ribbons ending in the gap beside their own labels. `applyMinimumThickness`
re-stacks them the way d3-sankey does, accumulating each node's links down its
height in the existing order, centred so a bar taller than its ribbons splits the
slack evenly.

This is worth writing down because it is invisible to every check that is not
geometric: the paths exist, the bars are the right height, the totals tie out, and
the only symptom is a ribbon that stops short. Measured against the 2026
year-to-date figures, 4 of 12 ribbons landed outside the bar they belonged to
before the rebuild and 0 of 12 after.

The floor also has to buy the labels room. A floored bar is 3px tall with its
neighbour 16px away, and two stacked lines of text there collide, so `nodePadding`
is 16 rather than d3-sankey's default 8 and a bar under 28px gets its amount as
an inline `<tspan>` beside its name instead of on a line below.

## Pan and zoom

The diagram is laid out **once**, in its own coordinates, and the `viewBox` is a
window onto it — so panning and zooming never re-run the Sankey layout, which is
the expensive part and the part that could shuffle bars you were looking at.

It also gives the drawing a **floor width** of 620px regardless of the container.
Below that the 132px label margins on each side leave almost nothing for the
ribbons, so a phone gets a squashed complete view it can zoom into, rather than a
legible one it has to pan sideways to read.

Five ways to move it, because no single gesture works everywhere:

| | |
| --- | --- |
| drag | pan, mouse or one finger |
| pinch | zoom, two fingers |
| wheel / trackpad | zoom about the pointer; `ctrl`+wheel from a trackpad pinch |
| buttons | zoom in, zoom out, and Fit |
| keyboard | arrows pan and step through items, `+`/`-` zoom, `0` fits |

Up/down arrows step through the items and left/right pan, rather than both being
item navigation — it is a vertical list of bars, so vertical is the natural
direction to read, and horizontal is left free for moving the canvas.

The window maths lives in `src/lib/zoom-view.ts`, pure and tested, because the
bugs that matter are invisible in a screenshot:

- **A zoom keeps the point you aimed at under the cursor.** Zooming about the
  centre instead slides the bar you were aiming at out from under the pointer
  exactly when you are lining it up with its label. One exception: when the new
  window would hang off the drawing, clamping wins, because a cursor-anchored
  window running past the edge shows blank space where the chart should be.
- **Neither control can lose the chart.** Zoom is bounded to 0.5×–6×, and panning
  stops at the edges. A window larger than the drawing is *centred*, not pinned
  to one side, which would leave a sliver of chart on the left and empty space on
  the right.
- The wheel listener is **native and non-passive**, because React registers
  `wheel` passively and a passive handler cannot `preventDefault` — the page would
  scroll out from under the chart instead of zooming it.
- `touch-action: none` on the SVG, or a finger on a chart always scrolls the page.

Resizing drops any zoom, since the diagram is re-laid-out and a window chosen for
the old size would be showing nothing.

## One colour per role, not per bucket

Income and what remains are green, spending is the single accent colour, an
overspend is amber. Giving twelve buckets twelve colours would imply they are
twelve different kinds of thing, which is the same reason the bar list is one
colour per bar. Hovering or arrowing through a node dims everything it is not
connected to, so a fan of overlapping ribbons stays readable.
