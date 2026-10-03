"use client";

import {
  Sankey,
  sankeyJustify,
  type SankeyExtraProperties,
  type SankeyGraph,
  type SankeyLink,
  type SankeyNode,
} from "@visx/sankey";
import { TooltipWithBounds } from "@visx/tooltip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyMinimumThickness,
  type CashFlowGraph,
  type SankeyNodeSpec,
} from "@/lib/cash-flow";
import { humanizeCategory } from "@/lib/categories";
import { formatCurrency } from "@/lib/format";
import { useMeasuredWidth } from "@/lib/use-measured-width";
import {
  fitView,
  MAX_SCALE,
  MIN_SCALE,
  panView,
  WHEEL_ZOOM_STEP,
  ZOOM_STEP,
  zoomView,
  type ViewBox,
} from "@/lib/zoom-view";

/**
 * Where the money came from and where it went, as a Sankey.
 *
 * Income on the left, what it was spent on on the right, and whatever survived
 * underneath. Built on @visx/sankey, which is a port of d3-sankey, so the layout
 * maths (relaxation iterations, link routing) is not something to reimplement.
 *
 * Colours follow the app's existing rule rather than giving every bucket its own
 * hue: income and what remains are green, spending is the one accent colour, and
 * an overspend is amber. Giving twelve buckets twelve colours would imply they
 * are twelve different kinds of thing, which is the same reason the bar list is
 * one colour per bar.
 *
 * Hover and keyboard drive the same `activeId`, so every ribbon and label is
 * reachable without a mouse.
 *
 * **Pannable and zoomable**, because a diagram that quietly clips its own
 * content is worse than one that admits it is showing a window onto something
 * bigger. Long bucket names overflow the label margin, and a month with many
 * buckets compresses them; drag, wheel, buttons and the keyboard all move the
 * window, and Fit always brings it back.
 */

type NodeDatum = SankeyNodeSpec & SankeyExtraProperties;
type LinkDatum = SankeyExtraProperties;
type Layout = SankeyGraph<NodeDatum, LinkDatum>;

const INCOME_FILL = "#4ade80";
const DEFICIT_FILL = "#fbbf24";
const SPENDING_FILL = "#818cf8";
const LEFTOVER_FILL = "#4ade80";

const MARGIN = { top: 12, right: 132, bottom: 12, left: 132 };
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 620;
/** Vertical room per row. Sets the height when there are few buckets. */
const ROW_HEIGHT = 32;
/**
 * Thinnest bar or ribbon worth drawing.
 *
 * d3-sankey scales one linear px-per-dollar across the whole diagram, so a month
 * with one dominant category renders everything else sub-pixel - $9 of insurance
 * in a $4,255 month is half a pixel. Floored here instead; see
 * `applyMinimumThickness` for what that does and does not distort.
 */
const MIN_BAR_PX = 3;
/**
 * Gap between stacked bars.
 *
 * Larger than d3-sankey's 8 because the two-line label under each name needs
 * about 26px of clearance, and the floor guarantees bars too short to earn that
 * clearance of their own. At 10 the small ones' labels sat on top of each other.
 */
const NODE_PADDING = 16;
/** Below this, a bar is too short for a name stacked over its amount. */
const TWO_LINE_LABEL_PX = 28;
/**
 * Narrowest the diagram is ever drawn at, regardless of container width.
 *
 * Below this the 132px label margins on each side leave almost nothing for the
 * ribbons, so a phone gets a squashed full view it can zoom into, rather than a
 * legible one it has to pan sideways to read.
 */
const MIN_DRAW_WIDTH = 620;

/**
 * How far a press may travel before it counts as a drag rather than a click.
 *
 * Small enough that a slightly shaky press on a phone still opens a bar, large
 * enough that a deliberate pan does not. It is also why pointer capture is taken
 * late rather than on pointerdown - see onPointerDown.
 */
const DRAG_SLOP_PX = 5;

export function SankeyChart({
  graph,
  periodLabel,
}: {
  graph: CashFlowGraph;
  /** What the figures cover, for the accessible name and the empty state. */
  periodLabel: string;
}) {
  const { ref, width } = useMeasuredWidth(760, 980);
  const [activeId, setActiveId] = useState<string | null>(null);

  /**
   * The bucket whose categories are shown below the diagram.
   *
   * A panel rather than a re-laid-out graph. Splitting one bar into several
   * inside the Sankey would change every ribbon's width, because the ribbons are
   * drawn in proportion to the node sizes - so expanding "Everything Else" into
   * six categories would silently resize Rent, Groceries and everything else.
   * Answering "what is in this bucket" must not move the other bars.
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /*
   * A drag that happens to start on a bar ends with a pointerup, and a
   * pointerup is also a click. Without this, panning the chart by grabbing a bar
   * would open that bar's breakdown as a side effect.
   */
  const draggedRef = useRef(false);

  /**
   * The window onto the drawing. Null means "fitted", which is also the state it
   * returns to whenever the drawing is resized - holding a stale zoom across a
   * layout change would leave the chart showing nothing at all.
   */
  const [view, setViewState] = useState<ViewBox | null>(null);

  const { nodes, links } = graph;

  /*
   * Room for one floor's worth of extra height per bar, up front. The floor can
   * only ever make the diagram taller, and by at most this much, so reserving it
   * here means the thickened layout still fits without a second layout pass.
   */
  const rowCount = Math.max(nodes.length, 2);
  const height =
    Math.min(Math.max(rowCount * ROW_HEIGHT, MIN_HEIGHT), MAX_HEIGHT) +
    rowCount * MIN_BAR_PX;

  /*
   * The diagram is laid out once in its own coordinates and the viewBox windows
   * it, so panning and zooming never re-run the Sankey layout. The drawing keeps
   * a floor width, which is what makes the controls worth having: a narrow
   * container would otherwise squeeze the labels until they were unreadable.
   */
  const drawWidth = Math.max(width, MIN_DRAW_WIDTH);
  const limit = useMemo(() => ({ w: drawWidth, h: height }), [drawWidth, height]);
  const currentView = view ?? fitView(limit);
  const viewBox = `${currentView.x} ${currentView.y} ${currentView.w} ${currentView.h}`;
  /** Zoom as a percentage, for the control readout. */
  const zoomPercent = Math.round((limit.w / currentView.w) * 100);
  const canZoomIn = currentView.w > limit.w / MAX_SCALE + 0.01;
  const canZoomOut = currentView.w < limit.w / MIN_SCALE - 0.01;

  const setView = useCallback((next: ViewBox | null) => setViewState(next), []);

  // Refs mirror the values the native listeners below read, so those never close
  // over a stale render. Synced in an effect rather than during render, which
  // React rightly forbids.
  const viewRef = useRef(currentView);
  const limitRef = useRef(limit);
  useEffect(() => {
    viewRef.current = currentView;
  }, [currentView]);
  useEffect(() => {
    limitRef.current = limit;
  }, [limit]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    lastX: number;
    lastY: number;
    lastSpread: number;
    /** Where the press started, to tell a drag from a click. */
    downX?: number;
    downY?: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Client pixels to drawing units, through whatever the viewBox is showing. */
  const toDrawing = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!rect || rect.width === 0) return { x: 0, y: 0 };
    return {
      x: v.x + ((clientX - rect.left) / rect.width) * v.w,
      y: v.y + ((clientY - rect.top) / rect.height) * v.h,
    };
  }, []);

  /** Scale from client pixels to drawing units, for panning by a delta. */
  const pxScale = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    // Before layout there is no meaningful mapping; identity keeps a stray
    // gesture from throwing.
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 1, y: 1 };
    return { x: v.w / rect.width, y: v.h / rect.height };
  }, []);

  const zoomBy = useCallback((factor: number, focus?: { x: number; y: number }) => {
    const v = viewRef.current;
    const point = focus ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    setViewState(zoomView(v, factor, point, limitRef.current));
  }, []);

  /*
   * The wheel listener is native because React registers `wheel` passively, and a
   * passive handler cannot preventDefault - so the page would scroll away
   * underneath the chart instead of zooming it.
   */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor =
        event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      zoomBy(factor, toDrawing(event.clientX, event.clientY));
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toDrawing, zoomBy]);

  /*
   * A resize re-lays out the diagram, so a zoom chosen for the old size is
   * meaningless and is dropped. Derived during render rather than in an effect:
   * this is correcting stale state, not synchronising with anything outside
   * React, and doing it in an effect would cost a second render pass.
   */
  const [lastSize, setLastSize] = useState(`${drawWidth}x${height}`);
  if (lastSize !== `${drawWidth}x${height}`) {
    setLastSize(`${drawWidth}x${height}`);
    if (view !== null) setViewState(null);
  }

  /*
   * Share is measured against income, because "this is 40% of what came in" is
   * the question a reader has. It means the shares add up to more than 100% in a
   * month that overspent, which is the honest answer rather than a rescaling to
   * hide it. Spending is the fallback so a month with no earnings still says
   * something useful.
   */
  const shareBase = graph.totals.income > 0 ? graph.totals.income : graph.totals.spending;
  const shareLabel = graph.totals.income > 0 ? "income" : "spending";

  const layout = useMemo<Layout | null>(() => {
    if (links.length === 0) return null;
    return {
      nodes: nodes.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    } as Layout;
  }, [nodes, links]);

  if (layout === null) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        <p>No money moved in {periodLabel}.</p>
        <p className="mt-1 text-neutral-400">
          Income and spending both show up here once a transaction is assigned to
          a bucket.
        </p>
      </div>
    );
  }

  const innerWidth = Math.max(drawWidth - MARGIN.left - MARGIN.right, 80);
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  /** Node ids one hover away, in each direction, for the arrow keys. */
  const ordered = layout.nodes.map((node) => node.id);

  const activeNode = activeId === null ? null : nodeById.get(activeId) ?? null;

  const toggleExpanded = (id: string) => {
    const node = nodeById.get(id);
    // Only buckets with something to split. A synthetic node, or a bucket whose
    // transactions all carry one category, would open onto a single row.
    if (!node || !node.breakdown || node.breakdown.length < 2) return;
    setExpandedId((current) => (current === id ? null : id));
  };

  const expandedNode = expandedId === null ? null : nodeById.get(expandedId) ?? null;

  const isDimmed = (node: SankeyNode<NodeDatum, LinkDatum>): boolean => {
    if (activeNode === null) return false;
    if (node.id === activeNode.id) return false;
    return !layout.links.some(
      (link) =>
        (link.source as SankeyNode<NodeDatum, LinkDatum>).id === activeNode.id &&
        (link.target as SankeyNode<NodeDatum, LinkDatum>).id === node.id,
    );
  };

  const isLinkDimmed = (link: SankeyLink<NodeDatum, LinkDatum>): boolean => {
    if (activeNode === null) return false;
    const source = link.source as SankeyNode<NodeDatum, LinkDatum>;
    const target = link.target as SankeyNode<NodeDatum, LinkDatum>;
    return source.id !== activeNode.id && target.id !== activeNode.id;
  };

  const nodeColor = (node: SankeyNodeSpec): string => {
    switch (node.kind) {
      case "income":
        return INCOME_FILL;
      case "deficit":
        return DEFICIT_FILL;
      case "leftover":
        return LEFTOVER_FILL;
      default:
        return SPENDING_FILL;
    }
  };

  const summary = [
    `Cash flow for ${periodLabel}.`,
    `Income ${formatCurrency(graph.totals.income)}.`,
    `Spending ${formatCurrency(graph.totals.spending)}.`,
    graph.totals.remaining >= 0
      ? `${formatCurrency(graph.totals.remaining)} remaining.`
      : `${formatCurrency(Math.abs(graph.totals.remaining))} more spent than earned.`,
    "Up and down arrows read each item, left and right pan, plus and minus zoom, and zero fits the whole diagram.",
    "Spending bars can be opened with Enter to show the categories inside them.",
  ].join(" ");

  /** How far one arrow-key press pans, as a fraction of the window. */
  const panStepPx = Math.max(currentView.w * 0.15, 24);

  /**
   * The SVG always keeps the drawing's aspect ratio, so the scale from drawing
   * units to container pixels is one number per axis and nothing has to be read
   * back off the DOM.
   */
  const displayHeight = Math.round(width * (height / drawWidth));
  const toPixels = (x: number, y: number): { left: number; top: number } => ({
    left: (x - currentView.x) * (width / currentView.w),
    top: (y - currentView.y) * (displayHeight / currentView.h),
  });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        {/*
          Spelled out rather than left to be discovered. The bars look like plain
          rectangles, so without this nothing suggests they open.
        */}
        {graph.nodes.some((node) => (node.breakdown?.length ?? 0) > 1) ? (
          <span className="text-neutral-500">
            Click a spending bar to see what is inside it
          </span>
        ) : (
          <span />
        )}
        <div className="flex items-center justify-end gap-1">
        <Control
          label="Zoom out"
          disabled={!canZoomOut}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
        >
          &minus;
        </Control>
        <span className="w-12 text-center tabular-nums text-neutral-500">
          {zoomPercent}%
        </span>
        <Control
          label="Zoom in"
          disabled={!canZoomIn}
          onClick={() => zoomBy(ZOOM_STEP)}
        >
          +
        </Control>
        <Control
          label="Fit the whole diagram"
          disabled={view === null}
          onClick={() => setView(null)}
        >
          Fit
        </Control>
        </div>
      </div>

    <div ref={ref} className="relative w-full">
      <svg
        ref={svgRef}
        width={width}
        height={displayHeight}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={summary}
        tabIndex={0}
        /*
         * `none` so a touch drag pans the diagram instead of scrolling the page
         * out from under it. Without it a finger on a chart always scrolls.
         */
        style={{ touchAction: "none" }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setActiveId(null);
            setExpandedId(null);
            return;
          }

          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoomBy(ZOOM_STEP);
            return;
          }
          if (event.key === "-" || event.key === "_") {
            event.preventDefault();
            zoomBy(1 / ZOOM_STEP);
            return;
          }
          if (event.key === "0") {
            event.preventDefault();
            setView(null);
            return;
          }

          /*
           * Vertical arrows step through the items - it is a vertical list of
           * bars, so that is the natural direction. Horizontal arrows pan, which
           * keeps the two gestures from fighting over the same keys.
           */
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (activeId !== null) toggleExpanded(activeId);
            return;
          }

          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActiveId((current) => {
              const at = current === null ? 0 : ordered.indexOf(current);
              const next = (at + step + ordered.length) % ordered.length;
              return ordered[next] ?? null;
            });
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const dx = event.key === "ArrowRight" ? -panStepPx : panStepPx;
            setViewState((current) =>
              panView(current ?? fitView(limitRef.current), dx, 0, limitRef.current),
            );
          }
        }}
        onBlur={() => setActiveId(null)}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.pointerType === "mouse") return;
          /*
           * Capture is taken later, on first movement, and that ordering is the
           * whole reason clicking a bar works at all.
           *
           * While an element holds pointer capture it also receives the
           * compatibility mouse events - including `click` - no matter what is
           * underneath. Capturing here meant every click on the diagram was
           * retargeted to this wrapper, so the bars' own click handlers never ran
           * and the drill-down silently did nothing.
           *
           * So: track the pointer, and only capture once it has actually moved.
           * A press that turns into a drag still captures (below, past the
           * threshold) and still pans; a press that turns into nothing never
           * captures, so the click reaches the bar.
           */
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          gesture.current = {
            lastX: event.clientX,
            lastY: event.clientY,
            lastSpread: spreadOf(pointers.current),
            downX: event.clientX,
            downY: event.clientY,
          };
        }}
        onPointerMove={(event) => {
          const held = pointers.current;
          if (!held.has(event.pointerId)) return;
          held.set(event.pointerId, { x: event.clientX, y: event.clientY });

          const g = gesture.current;
          if (!g) return;

          const scale = pxScale();

          /*
           * Two fingers means a pinch. Zooming on the ratio of the distance
           * between them and panning on the midpoint of it is the whole gesture,
           * and it comes out of the same pointer events as dragging.
           */
          /*
           * Past the slop threshold this is a drag, not a press: take capture now
           * so the gesture survives the pointer leaving the element, and mark it
           * so the pointerup at the end is not also read as a click.
           */
          if (
            !draggedRef.current &&
            Math.hypot(
              event.clientX - (g.downX ?? event.clientX),
              event.clientY - (g.downY ?? event.clientY),
            ) > DRAG_SLOP_PX
          ) {
            draggedRef.current = true;
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }

          if (held.size >= 2) {
            const points = [...held.values()];
            const spread = spreadOf(held);
            if (g.lastSpread > 0 && spread > 0) {
              const centre = toDrawing(
                (points[0]!.x + points[1]!.x) / 2,
                (points[0]!.y + points[1]!.y) / 2,
              );
              const factor = spread / g.lastSpread;
              setViewState((current) =>
                zoomView(current ?? fitView(limitRef.current), factor, centre, limitRef.current),
              );
            }
            g.lastSpread = spread;
            g.lastX = (points[0]!.x + points[1]!.x) / 2;
            g.lastY = (points[0]!.y + points[1]!.y) / 2;
            return;
          }

          const dx = (event.clientX - g.lastX) * scale.x;
          const dy = (event.clientY - g.lastY) * scale.y;
          g.lastX = event.clientX;
          g.lastY = event.clientY;
          if (dx === 0 && dy === 0) return;
          draggedRef.current = true;
          setViewState((current) =>
            panView(current ?? fitView(limitRef.current), -dx, -dy, limitRef.current),
          );
        }}
        onPointerUp={(event) => {
          /*
           * A press that never became a drag is a click on whatever was under it.
           * Resolved here rather than with an onClick on the bar, because this
           * element is the one guaranteed to receive the event - the bar's own
           * handler only would if nothing had captured the pointer, which is
           * exactly the condition that used to break it.
           */
          if (!draggedRef.current) {
            const hit = (event.target as Element | null)?.closest?.(
              "[data-sankey-node]",
            );
            const id = hit?.getAttribute("data-sankey-node");
            if (id) toggleExpanded(id);
          }

          pointers.current.delete(event.pointerId);
          if (pointers.current.size === 0) {
            gesture.current = null;
            draggedRef.current = false;
            setDragging(false);
          }
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          gesture.current = null;
          setDragging(false);
        }}
        className={`text-neutral-400 outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:text-neutral-500 ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <Sankey
          root={layout}
          nodeId={(node) => node.id}
          nodeWidth={12}
          nodePadding={NODE_PADDING}
          nodeAlign={sankeyJustify}
          extent={[
            [MARGIN.left, MARGIN.top],
            [MARGIN.left + innerWidth, MARGIN.top + innerHeight],
          ]}
        >
          {({ graph: computed, createPath }) => {
            applyMinimumThickness(
              computed.nodes as unknown as Parameters<typeof applyMinimumThickness>[0],
              computed.links as unknown as Parameters<typeof applyMinimumThickness>[1],
              MIN_BAR_PX,
            );
            return (
            <g>
              {computed.links.map((link, index) => {
                const source = link.source as SankeyNode<NodeDatum, LinkDatum>;
                const target = link.target as SankeyNode<NodeDatum, LinkDatum>;
                const key = `${source.id}->${target.id}-${index}`;
                const dimmed = isLinkDimmed(link);

return (
                    <path
                      key={key}
                      d={createPath(link) ?? undefined}
                      /*
                       * Stroked, not filled. `sankeyLinkHorizontal` emits only the
                       * ribbon's centreline - one open curve, no closing edge - so
                       * filling it paints a zero-area shape and every ribbon
                       * collapses to an antialiased hairline. Its thickness is
                       * carried by `stroke-width`.
                       */
                      fill="none"
                      stroke={nodeColor(target)}
                      strokeOpacity={dimmed ? 0.06 : 0.4}
                      strokeWidth={link.width ?? 0}
                      strokeLinecap="butt"
                      onMouseEnter={() => setActiveId(target.id)}
                      onMouseLeave={() => setActiveId(null)}
                    >
                    {/*
                      A native tooltip, so hovering a ribbon still says something
                      when the pointer is over the link rather than the node.
                      A template string, not JSX children: React refuses an array
                      of children inside an SVG <title>.
                    */}
                    <title>{`${target.label}: ${formatCurrency(link.value)}`}</title>
                  </path>
                );
              })}

              {computed.nodes.map((node) => {
                const spec = node as SankeyNodeSpec;
                const dimmed = isDimmed(node);
                const y0 = node.y0 ?? 0;
                const y1 = node.y1 ?? 0;
                const right = node.x0 !== undefined && node.x1 !== undefined;

                const canExpand = (spec.breakdown?.length ?? 0) > 1;
                const isExpanded = expandedId === node.id;

                return (
                  <g
                    key={node.id}
                    onMouseEnter={() => setActiveId(node.id)}
                    onMouseLeave={() => setActiveId(null)}
                    /*
                      A <g> has no focus of its own, so keyboard users would
                      otherwise never reach a bar. role/tabIndex turn it into a
                      control; arrow keys already move between bars, Enter opens.
                    */
                    role={canExpand ? "button" : undefined}
                    tabIndex={canExpand ? 0 : undefined}
                    aria-expanded={canExpand ? isExpanded : undefined}
                    aria-label={
                      canExpand
                        ? `${spec.label}, ${formatCurrency(spec.amount)}. Show what is in it.`
                        : undefined
                    }
                    style={{ cursor: canExpand ? "pointer" : undefined }}
                    /*
                      The wrapper resolves presses via this attribute rather than
                      an onClick here, so that a drag that starts on a bar cannot
                      also open it.
                    */
                    data-sankey-node={node.id}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      toggleExpanded(node.id);
                    }}
                    onFocus={() => setActiveId(node.id)}
                  >
                    <rect
                      x={node.x0}
                      y={y0}
                      width={(node.x1 ?? 0) - (node.x0 ?? 0)}
                      height={Math.max(y1 - y0, 1)}
                      fill={nodeColor(spec)}
                      fillOpacity={dimmed ? 0.3 : 1}
                      rx={2}
                    />
                    {/*
                      A wider invisible target than the bar itself. The bars are
                      `nodeWidth` across - about 12px - and the ones worth opening
                      are often the shortest, so the visible rectangle is a poor
                      thing to require a precise press on.
                    */}
                    {canExpand ? (
                      <rect
                        data-sankey-hit=""
                        x={(node.x0 ?? 0) - 8}
                        y={y0 - 3}
                        width={(node.x1 ?? 0) - (node.x0 ?? 0) + 16}
                        height={Math.max(y1 - y0, 1) + 6}
                        fill="transparent"
                        pointerEvents="all"
                      />
                    ) : null}
                    {/*
                      A hairline outline rather than a colour change, so "which bar
                      am I looking at" survives for anyone who cannot rely on the
                      fill alone.
                    */}
                    {isExpanded ? (
                      <rect
                        x={(node.x0 ?? 0) - 2}
                        y={y0 - 2}
                        width={(node.x1 ?? 0) - (node.x0 ?? 0) + 4}
                        height={Math.max(y1 - y0, 1) + 4}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        className="text-neutral-500 dark:text-neutral-300"
                        rx={3}
                      />
                    ) : null}
                    {/*
                      One line of text per bar. A bar tall enough for its own
                      second line gets the amount underneath; a short one gets it
                      inline as a tspan, because a floored bar and its neighbour
                      are only ~19px apart and two stacked lines would collide.
                    */}
                    <text
                      x={right
                        ? (node.x1 ?? 0) + 8
                        : (node.x0 ?? 0) - 8}
                      y={(y0 + y1) / 2}
                      textAnchor={right ? "start" : "end"}
                      dominantBaseline="middle"
                      fontSize={11}
                      fill="currentColor"
                      className={`fill-neutral-600 dark:fill-neutral-300 ${
                        dimmed ? "opacity-40" : ""
                      }`}
                    >
                      {spec.label}
                      {y1 - y0 >= TWO_LINE_LABEL_PX ? null : (
                        <tspan
                          fontSize={10}
                          className={`tabular-nums fill-neutral-500 dark:fill-neutral-400 ${
                            dimmed ? "opacity-30" : ""
                          }`}
                        >
                          {` · ${formatCurrency(spec.amount, { compact: true })}`}
                        </tspan>
                      )}
                    </text>
                    {y1 - y0 >= TWO_LINE_LABEL_PX ? (
                      <text
                        x={right
                          ? (node.x1 ?? 0) + 8
                          : (node.x0 ?? 0) - 8}
                        y={(y0 + y1) / 2 + 12}
                        textAnchor={right ? "start" : "end"}
                        dominantBaseline="middle"
                        fontSize={10}
                        fill="currentColor"
                        className={`tabular-nums fill-neutral-500 dark:fill-neutral-400 ${
                          dimmed ? "opacity-30" : ""
                        }`}
                      >
                        {formatCurrency(spec.amount, { compact: true })}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
            );
          }}
        </Sankey>
      </svg>

      {/*
        The drill-down. A bucket is what you budget in, but a category is what you
        actually buy, so a single bar cannot tell you whether a bucket needs
        splitting - only what is inside it can. Clicking the bar answers that
        without re-drawing the diagram, which matters because the ribbon widths are
        proportional: reshaping one node would resize every other bar.
      */}
      {expandedNode?.breakdown && expandedNode.breakdown.length > 1 ? (
        <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {expandedNode.label}
            </p>
            <button
              type="button"
              onClick={() => setExpandedId(null)}
              className="text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              Close
            </button>
          </div>
          <p className="text-xs text-neutral-500">
            {formatCurrency(expandedNode.amount)} across{" "}
            {expandedNode.breakdown.length} categories
            {expandedNode.budgeted
              ? `, against ${formatCurrency(expandedNode.budgeted)} budgeted`
              : null}
          </p>

          <ul className="mt-2 space-y-1">
            {expandedNode.breakdown.map((row) => {
              const share =
                expandedNode.amount > 0 ? row.amount / expandedNode.amount : 0;
              return (
                <li key={row.category} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">
                    {humanizeCategory(row.category)}
                  </span>
                  <span
                    aria-hidden
                    className="h-1.5 shrink-0 rounded-full bg-indigo-400 dark:bg-indigo-500"
                    style={{ width: `${Math.max(share * 88, 1)}px` }}
                  />
                  <span className="w-10 shrink-0 text-right tabular-nums text-neutral-500">
                    {Math.round(share * 100)}%
                  </span>
                  <span className="w-20 shrink-0 text-right tabular-nums text-neutral-900 dark:text-neutral-100">
                    {formatCurrency(row.amount)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {activeNode === null ? null : (
        <TooltipWithBounds
          unstyled
          applyPositionStyle
          /*
           * The tooltip is an HTML overlay, so it does not scale with the
           * viewBox. Position has to be mapped back out of drawing units into
           * container pixels, or it drifts away from the bar it describes the
           * moment the chart is zoomed.
           */
          left={toPixels((activeNode.x1 ?? 0) + 12, 0).left}
          top={toPixels(0, ((activeNode.y0 ?? 0) + (activeNode.y1 ?? 0)) / 2).top}
          className="pointer-events-none max-w-56 rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            {activeNode.label}
          </p>
          <p className="tabular-nums text-neutral-600 dark:text-neutral-300">
            {formatCurrency(activeNode.amount)}
          </p>
          {shareBase > 0 ? (
            <p className="tabular-nums text-neutral-500 dark:text-neutral-400">
              {Math.round((activeNode.amount / shareBase) * 100)}% of {shareLabel}
            </p>
          ) : null}
          {/*
            Budgeted is only meaningful for spending, and only over a month - a
            year-to-date window compares twelve months of spend against one
            month's limit unless the query has already scaled it.
          */}
          {activeNode.kind === "spending" && activeNode.budgeted ? (
            <p className="tabular-nums text-neutral-500 dark:text-neutral-400">
              of {formatCurrency(activeNode.budgeted)} budgeted
            </p>
          ) : null}
        </TooltipWithBounds>
      )}
    </div>
    </div>
  );
}

/** Distance between the first two tracked pointers, for a pinch. */
function spreadOf(pointers: Map<number, { x: number; y: number }>): number {
  const points = [...pointers.values()];
  if (points.length < 2) return 0;
  return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
}

/**
 * A zoom control.
 *
 * A real <button>, because the chart's zoom has to work without a mouse: a
 * wheel-only control is unusable on a phone and unreachable by keyboard.
 */
function Control({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="min-w-7 rounded border border-neutral-200 px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {children}
    </button>
  );
}