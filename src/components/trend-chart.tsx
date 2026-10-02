"use client";

import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { GridRows } from "@visx/grid";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, LinePath } from "@visx/shape";
import { TooltipWithBounds } from "@visx/tooltip";
import { useId, useState } from "react";

import { formatCurrency, formatDate } from "@/lib/format";
import { nearestIndex, type SeriesPoint } from "@/lib/series";
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
 * Draws from a SINGLE point as well as from many. A freshly deployed app has one
 * reading, and showing an empty box for a whole day reads as broken. One point
 * is plotted as a lone marker with no line or fill, because a line through one
 * point asserts a direction the data does not contain.
 *
 * Hover and keyboard both drive the same `activeIndex`, so the tooltip is
 * reachable without a mouse and there is only one code path to position it.
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
}: {
  points: SeriesPoint[];
  label: string;
  risingIsGood?: boolean;
}) {
  const gradientId = useId();
  const { ref, width } = useMeasuredWidth(680);

  /** Index of the point being inspected, or null for none. */
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <p className="text-sm text-neutral-500">Nothing recorded yet.</p>
    );
  }

  const height = 260;
  const margin = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerWidth = Math.max(width - margin.left - margin.right, 1);
  const innerHeight = height - margin.top - margin.bottom;

  const dates = points.map((p) => new Date(`${p.date}T00:00:00Z`));
  /*
   * A zero-width time domain maps everything to the middle of the range, which is
   * exactly where a lone point belongs - no special case needed for one point.
   */
  const xScale = scaleTime({
    domain: [dates[0], dates[dates.length - 1]],
    range: [0, innerWidth],
  });

  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  /*
   * Padded so a flat line does not sit on the axis, and so a single point has
   * somewhere to be. The span is 0 whenever there is one point, or when nothing
   * has moved, so this is not an edge case.
   */
  const span = rawMax - rawMin;
  const pad = span === 0 ? Math.max(Math.abs(rawMax) * 0.1, 1) : span * 0.1;
  const yScale = scaleLinear({
    domain: [rawMin - pad, rawMax + pad],
    range: [innerHeight, 0],
  });

  const first = points[0];
  const last = points[points.length - 1];
  const single = points.length === 1;
  const change = last.value - first.value;
  // One point means change 0, which is not "flat" - it is "no comparison yet".
  const rose = change > 0;
  const good = rose === risingIsGood;
  // Tailwind 400 rather than 500: calmer against the neutral cards, and legible
  // in both themes without a dark-mode variant.
  const stroke = single ? "#818cf8" : good ? "#4ade80" : "#f87171";

  const active = activeIndex === null ? null : points[activeIndex];
  const activeDate = activeIndex === null ? null : dates[activeIndex];
  const activeX = activeDate === null ? 0 : xScale(activeDate) ?? 0;
  const activeY = active === null ? 0 : yScale(active.value) ?? 0;

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={
          single
            ? `One ${label.toLowerCase()} reading: ${formatCurrency(last.value)} on ${last.date}`
            : `${label} from ${first.date} to ${last.date}, currently ${formatCurrency(
                last.value,
              )}. Use the left and right arrow keys to read each day.`
        }
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
        onMouseMove={(event) => {
          const point = localPoint(event);
          if (!point) return;
          const date = xScale.invert(point.x - margin.left);
          if (!date) return;
          setActiveIndex(nearestIndex(points, date));
        }}
        onMouseLeave={() => setActiveIndex(null)}
        className="text-neutral-400 outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:text-neutral-500"
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

          {single ? null : (
            <AreaClosed<SeriesPoint>
              data={points}
              x={(p) => xScale(new Date(`${p.date}T00:00:00Z`)) ?? 0}
              y={(p) => yScale(p.value) ?? 0}
              yScale={yScale}
              curve={curveMonotoneX}
              fill={`url(#${gradientId})`}
            />
          )}

          {single ? null : (
            <LinePath<SeriesPoint>
              data={points}
              x={(p) => xScale(new Date(`${p.date}T00:00:00Z`)) ?? 0}
              y={(p) => yScale(p.value) ?? 0}
              curve={curveMonotoneX}
              stroke={stroke}
              strokeWidth={2}
            />
          )}

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
            Change is measured from the first snapshot, which is the same basis
            as the total under the chart. A single point has nothing to compare
            against, so it is omitted rather than shown as a flat $0.00.
          */}
          {single ? null : (
            <p
              className={`tabular-nums ${
                good ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
              }`}
            >
              {active.value - first.value >= 0 ? "+" : ""}
              {formatCurrency(active.value - first.value)} since{" "}
              {formatDate(first.date)}
            </p>
          )}
        </TooltipWithBounds>
      )}

      {single ? (
        <p className="mt-1 text-sm text-neutral-500">
          One reading, from {last.date}. A trend appears once there is a second
          one.
        </p>
      ) : (
        <p className="mt-1 text-sm">
          <span className={good ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
            {change >= 0 ? "+" : ""}
            {formatCurrency(change)}
          </span>{" "}
          <span className="text-neutral-500">over this period</span>
        </p>
      )}
    </div>
  );
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
