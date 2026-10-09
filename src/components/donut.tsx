import { formatCurrency } from "@/lib/format";
import { amountFor } from "@/lib/mask";

/**
 * A donut of what you own against what you owe, with net worth in the middle.
 *
 * A donut earns its place here and almost nowhere else: this is the one question
 * that is genuinely part-to-whole — how the total is made up — and the centre
 * gives the arithmetic away, so nobody has to add five slices in their head. For
 * comparing values against each other, a bar list reads faster (see BarList).
 *
 * Drawn with `stroke-dasharray` on a circle rather than arc paths. Each slice is
 * the same circle with a different dash length and offset, so there is no path
 * maths to get wrong at the seam, and it stays a single element per slice.
 *
 * Colour is identity, not decoration: the caller picks a fixed colour per
 * category so cash is the same colour every time it appears. Assigning colours by
 * rank would repaint the chart whenever the ordering changed.
 */
export function Donut({
  slices,
  centerValue,
  centerLabel,
  hidden = false,
}: {
  slices: { key: string; label: string; value: number; color: string }[];
  /** The figure the slices add up to, e.g. net worth. */
  centerValue: number;
  centerLabel: string;
  /**
   * Mask the centre figure, the legend and the accessible names.
   *
   * The arcs keep their proportions, which is the same line the trend chart draws:
   * what is masked is the numbers, not the shape. A share of the whole is not a
   * balance, but it is a balance once you know the total - and the centre figure
   * is the total.
   */
  hidden?: boolean;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const money = (value: number, compact = false) =>
    amountFor(formatCurrency(value, { compact }), hidden);

  if (total === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Nothing to break down yet.
      </p>
    );
  }

  const size = 168;
  const stroke = 26;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Round to whole pixels so the seams do not show as hairlines of background.
  const gap = slices.length > 1 ? 1.5 : 0;

  /*
   * Dash geometry, computed in its own pass rather than by advancing a counter
   * inside the JSX map: reassigning a variable partway through render is what
   * React's compiler rules are there to stop, and this is the same work without
   * the mutable state.
   */
  const arcs = slices.reduce<{ slice: (typeof slices)[number]; length: number; offset: number }[]>(
    (accumulated, slice) => {
      const previous = accumulated.at(-1);
      const start = previous ? previous.offset + previous.length + gap : 0;
      accumulated.push({
        slice,
        length: Math.max((slice.value / total) * circumference - gap, 0),
        offset: start,
      });
      return accumulated;
    },
    [],
  );

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-40 w-40 shrink-0"
        role="img"
        aria-label={`${centerLabel}: ${slices
          .map((slice) => `${slice.label} ${money(slice.value)}`)
          .join(", ")}`}
      >
        {/* Rotate so the first slice starts at 12 o'clock, not 3. */}
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {arcs.map((arc) => (
            <circle
              key={arc.slice.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={arc.slice.color}
              strokeWidth={stroke}
              strokeDasharray={`${arc.length} ${circumference - arc.length}`}
              strokeDashoffset={-arc.offset}
            />
          ))}
        </g>
        <text
          x={size / 2}
          y={size / 2 - 2}
          textAnchor="middle"
          className="fill-neutral-900 text-[15px] font-semibold dark:fill-neutral-100"
        >
          {money(centerValue, true)}
        </text>
        <text
          x={size / 2}
          y={size / 2 + 14}
          textAnchor="middle"
          className="fill-neutral-500 text-[10px]"
        >
          {centerLabel}
        </text>
      </svg>

      <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
        {slices
          .filter((slice) => slice.value > 0)
          .map((slice) => (
            <li key={slice.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: slice.color }}
              />
              <span className="min-w-0 flex-1 truncate">{slice.label}</span>
              <span className="shrink-0 tabular-nums text-neutral-600 dark:text-neutral-400">
                {money(slice.value)}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Fixed palette, indexed by position.
 *
 * Deliberately not generated: these are the same five categories every time, so
 * pinning them keeps cash indigo and debt red on every render and on every
 * device.
 *
 * Tailwind's **400** shades rather than the 500s, which were too bright against
 * a page that is otherwise neutral greys. At 400 they sit around 70% lightness,
 * which is also the one band that reads against both a white card and the dark
 * one - so nothing here needs a dark-mode variant.
 */
export const DONUT_COLOURS = {
  cash: "#818cf8",
  investments: "#4ade80",
  other: "#22d3ee",
  creditCards: "#fbbf24",
  loans: "#f87171",
} as const;