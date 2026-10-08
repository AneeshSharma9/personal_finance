"use client";

import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { GridRows } from "@visx/grid";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, LinePath } from "@visx/shape";
import { TooltipWithBounds } from "@visx/tooltip";
import { useEffect, useId, useRef, useState } from "react";

import { formatCurrency, formatDate } from "@/lib/format";
import {
  nearestIndex,
  seriesChangeAt,
  type ChangeBasis,
  type SeriesPoint,
} from "@/lib/series";
import { useMeasuredWidth } from "@/lib/use-measured-width";

/**
 * A single line over time, on visx.
 *
 * One component for every chart in the app - net worth, an account's balance, a
 * loan paying down - because they differ only in the label and whether a rising
 * line is good news. It was a net-worth chart once; generalising it is cheaper
 * than writing the same tooltip and keyboard handling twice.
 *
 * Built from visx's individual packages rather than the `visx` umbrella, so only
 * the scales, shapes, axes and tooltip this chart actually uses get pulled in.
 *
 * Draws from TWO points as well as from many, which is the floor: a line through
 * one point asserts a direction the data does not contain, and a change for a
 * series with a single reading is not a change. Below two it renders a "No graph
 * data available" panel instead - see the early return for why that replaced the
 * lone marker it used to draw.
 *
 * Pointer, hover and keyboard all drive the same `activeIndex`, so the tooltip is
 * reachable by finger and by keyboard as well as by mouse, and there is only one
 * code path to position it.
 *
 * On touch the series is scrubbed by dragging a finger across it. That needs
 * **pointer** events rather than mouse ones: `onMouseMove` does fire for a dragged
 * finger on most browsers, but only once the browser has decided the drag is not a
 * scroll, and on a chart in a vertically scrolling page it usually is - so the
 * tooltip never appeared at all on a phone. `touch-pan-y` on the svg is what makes
 * that decision explicit: the browser keeps vertical panning for itself, and
 * horizontal movement is ours to read.
 */
export function TrendChart({
  points,
  /** What the line measures, for the accessible name. */
  label,
  /**
   * Whether a rising line is good news. True for net worth and a savings
   * balance; false for a credit card, where a higher balance is worse.
   */
  risingIsGood = true,
  /**
   * What the change figure under the chart is measured against.
   *
   * `period` (the default) measures from the oldest reading on record, which is
   * the same basis as the chart's own window. `day` measures from the reading
   * before the newest one, which is the only basis that means anything when the
   * question is "what moved overnight" - the dashboard asks that on every visit.
   *
   * It moves the reported figure and the tooltip, but deliberately not the
   * line's colour: a net-worth line painted red because one bad Tuesday landed
   * would be alarming and wrong, so the stroke stays on the period basis. On the
   * default basis the two are the same number anyway.
   */
  changeBasis = "period",
}: {
  points: SeriesPoint[];
  label: string;
  risingIsGood?: boolean;
  changeBasis?: ChangeBasis;
}) {
  const gradientId = useId();
  const { ref, width } = useMeasuredWidth(680);

  /** Index of the point being inspected, or null for none. */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  /*
   * Whether a non-mouse pointer is currently pressed on the chart. A ref, because
   * it is read on every `pointermove` of a drag: as state it would re-render the
   * whole series sixty times a second purely to learn that the finger is still
   * down.
   */
  const dragging = useRef(false);

  /*
   * The chart's own element, so a press anywhere else on the page can dismiss a
   * touch selection. See the effect below for why that is needed.
   */
  const chartRef = useRef<HTMLDivElement | null>(null);

  /**
   * Snap the inspected point to the recorded day nearest a pointer position.
   *
   * The event is passed rather than a coordinate because `localPoint` needs the
   * target element to resolve the position, and it reads `clientX`/`clientY`
   * directly - a pointer event satisfies that without any adaptation.
   */
  function inspect(event: React.PointerEvent<SVGSVGElement>) {
    const point = localPoint(event);
    if (!point) return;
    const date = xScale.invert(point.x - margin.left);
    if (!date) return;
    setActiveIndex(nearestIndex(points, date));
  }

  /*
   * Dismiss a touch selection on the next press anywhere else on the page.
   *
   * Releasing the finger deliberately does NOT clear it, because that is how you
   * say "I have read that" - and a finger covering the tooltip is exactly when you
   * want to read it. So the tooltip has to outlive the gesture, which leaves
   * something on screen with nothing to dismiss it, and the honest dismissal is
   * "tap anywhere else", the same contract a popover has.
   *
   * Without this, `pointerleave` would have to do it - and for touch the browser
   * fires `pointerleave` the moment the finger lifts, since the touch pointer stops
   * existing. So the obvious implementation clears the selection on release, which
   * makes scrubbing to a point and reading it impossible.
   */
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (dragging.current) return;
      if (chartRef.current?.contains(event.target as Node)) return;
      setActiveIndex(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  /*
   * Fewer than two readings is a message, not a chart.
   *
   * It used to draw a lone marker with no line and caption it "one reading" - on
   * the grounds that a line through one point asserts a direction the data does
   * not contain, which stays true. But it was the wrong trade: with a period
   * selector, one point is a *normal* outcome rather than a first-day edge case,
   * and it happens on every period the data does not reach into. A bare dot with
   * no line and a caption below it reads as a chart that failed to draw, which is
   * the one thing it must not do. Saying so outright is both more honest and more
   * legible than a dot pretending to be a graph.
   *
   * Two readings is the floor rather than a preference, because it is the smallest
   * number that can show a movement - and showing a change for a series that has
   * none is exactly the failure `seriesChange` returning null exists to prevent.
   */
  if (points.length < 2) {
    return (
      <div
        ref={ref}
        className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700"
      >
        <p className="font-medium text-neutral-700 dark:text-neutral-300">
          No graph data available
        </p>
        <p className="mt-1">
          {points.length === 0
            ? "Nothing was recorded in this period."
            : `One reading, ${formatDate(points[0]!.date)}. A graph needs two.`}
        </p>
      </div>
    );
  }

  const height = 260;
  const margin = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerWidth = Math.max(width - margin.left - margin.right, 1);
  const innerHeight = height - margin.top - margin.bottom;

  const dates = points.map((p) => new Date(`${p.date}T00:00:00Z`));
  /*
   * Two points on the same day would give a zero-width domain and collapse
   * everything to the middle. That cannot happen: one reading per account per day
   * is enforced by a unique index, and two net-worth snapshots a day apart are
   * distinct dates by construction.
   */
  const xScale = scaleTime({
    domain: [dates[0], dates[dates.length - 1]],
    range: [0, innerWidth],
  });

  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  /*
   * Padded so a flat line does not sit on the axis. The span is 0 whenever nothing
   * has moved - two readings of the same value, which is a common case for an
   * untouched savings account - so this is not an edge case.
   */
  const span = rawMax - rawMin;
  const pad = span === 0 ? Math.max(Math.abs(rawMax) * 0.1, 1) : span * 0.1;
  const yScale = scaleLinear({
    domain: [rawMin - pad, rawMax + pad],
    range: [innerHeight, 0],
  });

  const last = points[points.length - 1];
  const first = points[0];
  /*
   * Two changes, not one. The line's colour follows the trend the line actually
   * draws - the whole window - while the reported figure follows `changeBasis`,
   * which is whatever the page was asked for.
   */
  const trend = seriesChangeAt(points, points.length - 1, "period");
  const reported = seriesChangeAt(points, points.length - 1, changeBasis);
  const trendTone = tone(trend?.change, risingIsGood);
  // Tailwind 400 rather than 500: calmer against the neutral cards, and legible
  // in both themes without a dark-mode variant.
  const stroke = STROKE[trendTone];
  // The reported figure is judged the same way, or the number and its colour
  // would disagree about the same measurement.
  const reportedTone =
    reported === null ? trendTone : tone(reported.change, risingIsGood);

  const active = activeIndex === null ? null : points[activeIndex];
  const activeDate = activeIndex === null ? null : dates[activeIndex];
  const activeX = activeDate === null ? 0 : xScale(activeDate) ?? 0;
  const activeY = active === null ? 0 : yScale(active.value) ?? 0;
  /*
   * The inspected point's own change, on the same basis as the figure under the
   * chart. Computed against the point *before* it on the `day` basis, so walking
   * the series with the arrow keys reads day by day rather than repeating the
   * total nine hundred times.
   */
  const activeChange =
    activeIndex === null ? null : seriesChangeAt(points, activeIndex, changeBasis);

  return (
    <div ref={mergeRefs(ref, chartRef)} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${label} from ${first.date} to ${last.date}, currently ${formatCurrency(
          last.value,
        )}. Use the left and right arrow keys to read each day.`}
        // Focusable so the series can be read without a mouse. The hover
        // behaviour below is mirrored onto the keyboard for the same reason.
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setActiveIndex(null);
            return;
          }
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowRight" ? 1 : -1;
          setActiveIndex((current) => {
            const next = current === null ? points.length - 1 : current + step;
            // Clamp rather than wrap: walking off either end of a time series is
            // a dead end, not a loop.
            return Math.min(Math.max(next, 0), points.length - 1);
          });
        }}
onBlur={() => setActiveIndex(null)}
        onPointerDown={(event) => {
          // Captured so a drag that wanders off the chart keeps tracking. Without
          // it the selection freezes where the finger crossed the edge, which on a
          // narrow phone is most of the width from where the user is touching.
          event.currentTarget.setPointerCapture(event.pointerId);
          if (event.pointerType !== "mouse") dragging.current = true;
          inspect(event);
        }}
        onPointerMove={(event) => {
          // A mouse inspects on hover; anything else only while pressed, so a finger
          // resting on the page after a scroll cannot leave a tooltip parked here.
          if (event.pointerType === "mouse" || dragging.current) inspect(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragging.current = false;
          // Deliberately leaves the selection in place for touch. Releasing is how
          // you say "I have read that", and a finger is covering the tooltip at
          // exactly the moment you want to read it - so clearing here would make
          // scrubbing to a point and reading it impossible.
        }}
        onPointerCancel={() => {
          // The browser took the gesture over for a scroll, so it never happened.
          dragging.current = false;
          setActiveIndex(null);
        }}
        onPointerLeave={() => {
          // Mouse only. Touch is dismissed by the document listener above, because
          // `pointerleave` fires the moment a finger lifts.
          if (!dragging.current) setActiveIndex(null);
        }}
        className="text-neutral-400 outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 touch-pan-y dark:text-neutral-500"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        <Group left={margin.left} top={margin.top}>
          <GridRows
            scale={yScale}
            width={innerWidth}
            numTicks={4}
            stroke="currentColor"
            strokeOpacity={0.15}
          />

          {/* Zero line, so a net-worth figure below zero reads correctly. */}
          {yScale.domain()[0] < 0 && yScale.domain()[1] > 0 ? (
            <line
              x1={0}
              x2={innerWidth}
              y1={yScale(0)}
              y2={yScale(0)}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="4 4"
            />
          ) : null}

          <AreaClosed<SeriesPoint>
            data={points}
            x={(p) => xScale(new Date(`${p.date}T00:00:00Z`)) ?? 0}
            y={(p) => yScale(p.value) ?? 0}
            yScale={yScale}
            curve={curveMonotoneX}
            fill={`url(#${gradientId})`}
          />

          <LinePath<SeriesPoint>
            data={points}
            x={(p) => xScale(new Date(`${p.date}T00:00:00Z`)) ?? 0}
            y={(p) => yScale(p.value) ?? 0}
            curve={curveMonotoneX}
            stroke={stroke}
            strokeWidth={2}
          />

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={Math.min(points.length, 6)}
            // Without this visx falls back to its own multi-scale time format,
            // which on a short series produces things like "Sat 03".
            tickFormat={(value) =>
              formatDate((value as Date).toISOString().slice(0, 10))
            }
            stroke="currentColor"
            tickStroke="currentColor"
            tickLabelProps={() => ({
              fill: "currentColor",
              fontSize: 10,
              textAnchor: "middle",
              dy: "0.71em",
            })}
          />
          <AxisLeft
            scale={yScale}
            numTicks={4}
            hideAxisLine
            hideTicks
            tickFormat={(value) => formatCurrency(Number(value), { compact: true })}
            tickLabelProps={() => ({
              fill: "currentColor",
              fontSize: 10,
              textAnchor: "end",
              dx: "-0.5em",
              dy: "0.32em",
            })}
          />

          {/*
            Marker on the latest point, always drawn: it is where the series ends,
            and it is the one figure that is true right now.
          */}
          <circle
            cx={xScale(dates[dates.length - 1]) ?? 0}
            cy={yScale(last.value) ?? 0}
            r={3.5}
            fill={stroke}
          />

          {/* Crosshair and a larger marker for the point being inspected. */}
          {activeDate === null ? null : (
            <>
              <line
                x1={activeX}
                x2={activeX}
                y1={0}
                y2={innerHeight}
                stroke="currentColor"
                strokeOpacity={0.4}
                strokeDasharray="3 3"
              />
              <circle cx={activeX} cy={activeY} r={5} fill={stroke} />
            </>
          )}
        </Group>
      </svg>

      {active === null || activeIndex === null ? null : (
        <TooltipWithBounds
          // visx's default tooltip is hardcoded white-on-#666 with no dark
          // mode, so it is unstyled and styled here instead.
          unstyled
          applyPositionStyle
          left={activeX + margin.left}
          top={activeY + margin.top}
          className="pointer-events-none rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        >
          <p className="font-medium text-neutral-900 dark:text-neutral-100">
            {formatDate(active.date)}
          </p>
          <p className="tabular-nums text-neutral-600 dark:text-neutral-300">
            {formatCurrency(active.value)}
          </p>
          {/*
            Measured against the reading before the one being inspected, on the
            same basis as the figure under the chart - so both describe the same
            thing. Omitted when there is no such reading: the first point has
            nothing before it, and a flat $0.00 would claim it was measured
            twice.
          */}
          {activeChange === null ? null : (
            <p
              className={`tabular-nums ${
                TONE_CLASS[tone(activeChange.change, risingIsGood)]
              }`}
            >
              {activeChange.change >= 0 ? "+" : ""}
              {formatCurrency(activeChange.change)} since{" "}
              {formatDate(activeChange.from.date)}
            </p>
          )}
        </TooltipWithBounds>
      )}

      {/*
          Null rather than a flat $0.00: `seriesChange` declines to report a change
          it cannot measure, and $0.00 would claim the number was measured twice
          and did not move. Reachable on the day basis with two readings whose
          first has nothing before it.
        */}
      {reported === null ? null : (
        <p className="mt-1 text-sm">
          <span className={TONE_CLASS[reportedTone]}>
            {reported.change >= 0 ? "+" : ""}
            {formatCurrency(reported.change)}
          </span>{" "}
          <span className="text-neutral-500">
            {changeBasis === "day"
              ? `since ${formatDate(reported.from.date)}`
              : "over this period"}
          </span>
        </p>
      )}
    </div>
  );
}

/**
 * Write one ref into two, so the chart can keep its own element handle without
 * replacing the measured-width observer's.
 *
 * `useMeasuredWidth` owns a ref of its own and needs the real node attached, so
 * taking it over would break the width measurement - which is what makes the
 * drawing and the HTML tooltip agree at all. Assigning both instead of either is
 * the only way both work.
 */
function mergeRefs<T>(...refs: (React.Ref<T> | null | undefined)[]) {
  return (value: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    }
  };
}

/** visx has no <g> shorthand in these packages; this keeps the JSX readable. */
function Group({
  left,
  top,
  children,
}: {
  left: number;
  top: number;
  children: React.ReactNode;
}) {
  return (
    <g transform={`translate(${left},${top})`}>{children}</g>
  );
}

type Tone = "good" | "bad" | "flat";

/**
 * Judge a movement, knowing whether a rise is good news.
 *
 * "flat" is its own answer rather than being folded into "bad": a balance that
 * did not move is not a loss, and the comparison `change > 0 === risingIsGood`
 * alone would report exactly that - a flat net worth painted the colour of bad
 * news, which is what this replaced.
 */
function tone(change: number | undefined, risingIsGood: boolean): Tone {
  if (change === undefined || change === 0) return "flat";
  return (change > 0) === risingIsGood ? "good" : "bad";
}

const STROKE: Record<Tone, string> = {
  good: "#4ade80",
  bad: "#f87171",
  flat: "#a3a3a3",
};

const TONE_CLASS: Record<Tone, string> = {
  good: "text-green-700 dark:text-green-400",
  bad: "text-red-700 dark:text-red-400",
  flat: "text-neutral-500",
};
