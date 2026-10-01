"use client";

import { useId } from "react";

import type { NetWorthPoint } from "@/lib/queries";
import { formatCurrency } from "@/lib/format";

/**
 * Net worth history as an inline SVG line chart.
 *
 * Hand-rolled rather than a charting library: it's one series, the app is
 * single-user, and this avoids a dependency in the bundle. Prices come from
 * Plaid's last update, so this is a coarse trend, not a live valuation.
 */
export function NetWorthChart({ points }: { points: NetWorthPoint[] }) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <p className="text-sm text-neutral-500">
        Not enough snapshots yet to chart a trend.
      </p>
    );
  }

  const width = 600;
  const height = 200;
  const padding = { top: 12, right: 12, bottom: 24, left: 12 };

  const values = points.map((p) => p.netWorth);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);

  // Pad the range so a flat line doesn't sit on the axis, and avoid a
  // divide-by-zero when min === max.
  const span = rawMax - rawMin;
  const pad = span === 0 ? Math.max(Math.abs(rawMax) * 0.1, 1) : span * 0.1;
  const min = rawMin - pad;
  const max = rawMax + pad;

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const x = (index: number) =>
    padding.left + (index / (points.length - 1)) * plotWidth;

  const y = (value: number) =>
    padding.top + plotHeight - ((value - min) / (max - min)) * plotHeight;

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.netWorth).toFixed(1)}`)
    .join(" ");

  const area = `${line} L${x(points.length - 1).toFixed(1)},${(
    padding.top + plotHeight
  ).toFixed(1)} L${x(0).toFixed(1)},${(padding.top + plotHeight).toFixed(1)} Z`;

  const first = points[0];
  const last = points[points.length - 1];
  const change = last.netWorth - first.netWorth;
  const gained = change >= 0;

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-48 w-full"
        role="img"
        aria-label={`Net worth from ${first.date} to ${last.date}, currently ${formatCurrency(
          last.netWorth,
        )}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={gained ? "#22c55e" : "#ef4444"} stopOpacity="0.25" />
            <stop offset="100%" stopColor={gained ? "#22c55e" : "#ef4444"} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Zero line, so a net-worth figure below zero reads correctly. */}
        {min < 0 && max > 0 ? (
          <line
            x1={padding.left}
            y1={y(0)}
            x2={width - padding.right}
            y2={y(0)}
            stroke="currentColor"
            strokeOpacity="0.2"
            strokeDasharray="4 4"
          />
        ) : null}

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke={gained ? "#22c55e" : "#ef4444"}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx={x(points.length - 1)} cy={y(last.netWorth)} r="3" fill={gained ? "#22c55e" : "#ef4444"} />

        <text x={padding.left} y={height - 6} fontSize="10" fill="currentColor" opacity="0.5">
          {first.date}
        </text>
        <text
          x={width - padding.right}
          y={height - 6}
          fontSize="10"
          fill="currentColor"
          opacity="0.5"
          textAnchor="end"
        >
          {last.date}
        </text>
      </svg>

      <p className="mt-1 text-sm">
        <span className={gained ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}>
          {change >= 0 ? "+" : ""}
          {formatCurrency(change)}
        </span>{" "}
        <span className="text-neutral-500">over this period</span>
      </p>
    </div>
  );
}