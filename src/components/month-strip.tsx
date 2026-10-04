"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { stripScrollTarget, stripSnapPosition } from "@/lib/month-strip";
import type { MonthPoint } from "@/lib/queries";

/**
 * Month picker: the selected year's twelve months in one horizontally scrolling
 * strip, with the year dropdown above it.
 *
 * This replaced a rolling six-month window flanked by arrows. Three things were
 * wrong with that:
 *
 *  - **Paging moved two things at once.** The arrows shifted the window *and* the
 *    selected month, so the figures below always followed. Paging that changes what
 *    you are looking at is a reasonable default, but it means a strip can never be
 *    scrolled to look around without also navigating.
 *  - **Six of twelve months were unreachable without paging.** September was
 *    visible and October was not, on a page whose whole subject is a month.
 *  - **The window had its own URL parameters** (`wYear`/`wMonth`), so the strip's
 *    position was a second piece of state that could disagree with the month whose
 *    figures were on screen.
 *
 * Now the strip is a pure function of the year, every month is one click away, and
 * scrolling it cannot change the selection. The year sits above and to the right,
 * where the eye goes after reading a month name.
 *
 * Two choices kept from the original:
 *
 *  - **The selection lives in the URL** (`?year=&month=`), so a reload or a shared
 *    link lands on the same month. Local state would desync the strip from the
 *    figures further down.
 *  - **Future months are not links.** They cannot have data, and offering them would
 *    be offering an empty page. They are still drawn, so the year reads as a whole
 *    and you can see how much of it is behind you.
 */

/** Widest a month tile gets, so the strip scrolls predictably on any screen. */
const TILE_WIDTH_PX = 72;

export function MonthStrip({
  months,
  selected,
  years,
  currentYear,
  currentMonth,
}: {
  /** All twelve months of `selected.year`, ascending. */
  months: MonthPoint[];
  selected: { year: number; month: number };
  /** Years that have data, ascending. */
  years: number[];
  currentYear: number;
  /** 1-12. */
  currentMonth: number;
}) {
  const router = useRouter();

  /*
   * Months are a single index so "is this in the future" is one comparison, with no
   * December-to-January special case. Everything here is 1-based.
   */
  const currentIndex = currentYear * 12 + (currentMonth - 1);
  const selectedIndex = selected.year * 12 + (selected.month - 1);

  /*
   * Scroll the chosen month into view on load and whenever the selection changes,
   * so a link to, say, March does not open with March off-screen to the right.
   *
   * `nearest` rather than `start`: a phone shows about three tiles, and aligning
   * the selection to the left edge would hide everything before it. The browser
   * scrolls the minimum needed to make the tile visible.
   */
  const scroller = useRef<HTMLElement | null>(null);
  const selectedRef = useRef<HTMLLIElement | null>(null);

  /*
   * Distance between the first two tiles, measured rather than assumed.
   *
   * Used to round a scroll position onto a tile boundary, so it has to be the real
   * rendered stride and not `TILE_WIDTH_PX + gap`. If the two ever disagree the
   * rounding drifts and the strip settles between tiles.
   */
  const stride = useCallback((): number => {
    const el = scroller.current;
    const tiles = el?.querySelectorAll("li");
    if (!tiles || tiles.length < 2) return 0;
    return tiles[1]!.offsetLeft - tiles[0]!.offsetLeft;
  }, []);

  /**
   * Settle onto a tile boundary after the user stops dragging.
   *
   * Knows nothing about the selected month. It did once, and refused to settle on a
   * boundary that clipped it — which meant that after any drag long enough to push
   * the selected month towards an edge, the strip sprang back to it on release. Free
   * scrolling has to stay free; selection is the reveal's job.
   */
  const settleStrip = useCallback(
    (animate: boolean) => {
      const el = scroller.current;
      const step = stride();
      if (!el || step <= 0) return;

      const next = stripSnapPosition({
        left: el.scrollLeft,
        viewWidth: el.clientWidth,
        contentWidth: el.scrollWidth,
        stride: step,
      });
      if (Math.abs(next - el.scrollLeft) < 1) return;

      if (animate) {
        el.scrollTo({ left: next, behavior: "smooth" });
      } else {
        el.scrollLeft = next;
      }
    },
    [stride],
  );

  /**
   * Bring the selected month fully into view, flush against whichever edge it is
   * nearest.
   *
   * `scrollIntoView({ inline: "nearest" })` did nearly this, but only "nearly": it
   * scrolls the minimum distance to make the tile visible and then lets the browser
   * reconcile that with scroll-snap, so the tile landed a few pixels off a boundary
   * and the snap pulled it back - which is how October and November ended up half
   * cut off.
   *
   * Geometry comes from getBoundingClientRect rather than `offsetLeft`, because the
   * fade wrapper is the nearest positioned ancestor, so `offsetLeft` would be
   * relative to the wrapper while `scrollLeft` is relative to the scroller. Those
   * coincide today by accident rather than by construction.
   */
  const revealMonth = useCallback(() => {
    const el = scroller.current;
    const tile = selectedRef.current;
    if (!el || !tile) return;

    const step = stride();
    const next = stripScrollTarget({
      tileLeft:
        el.scrollLeft + (tile.getBoundingClientRect().left - el.getBoundingClientRect().left),
      tileWidth: tile.offsetWidth,
      currentScroll: el.scrollLeft,
      viewWidth: el.clientWidth,
      contentWidth: el.scrollWidth,
      stride: step,
    });
    if (Math.abs(next - el.scrollLeft) < 1) return;
    el.scrollLeft = next;
  }, [stride]);

  /*
   * Instant rather than animated: this runs right after a navigation, where Next
   * restores scroll on its own schedule, and a tween would be competing with it.
   */
  useEffect(() => {
    // Marked before the move, so the scroll event it causes is recognised as ours
    // and does not schedule a settle that would undo it.
    programmatic.current = true;
    revealMonth();
  }, [selectedIndex, months, revealMonth]);

  /*
   * Settle onto a tile after the user stops scrolling.
   *
   * This is the job `snap-mandatory` was doing badly. Debounced rather than
   * immediate, so it fires once at the end of a drag or fling instead of chasing
   * every frame - and 140ms is long enough to outlast iOS momentum scrolling,
   * which keeps firing scroll events after the finger has lifted.
   */
  /*
   * Set while the strip is being moved by the reveal rather than by the user.
   *
   * This is the real fix for the December bug, and it belongs here rather than in
   * `settleStrip`. The reveal assigns `scrollLeft`, that fires a scroll event like
   * any other, and the settle then rounded the reveal's own position back to a tile
   * boundary — undoing it. December is the only tile that reveals off-boundary (it
   * is the only one that can need the strip at `maxScroll`, which is never a multiple
   * of the stride), so it was the only one visibly affected.
   *
   * The alternative was to make the settle selection-aware, which "fixed" December
   * and broke dragging: the strip sprang back to the selected month on every
   * release. Suppressing the settle for programmatic scrolls fixes the cause and
   * leaves a drag alone.
   */
  const programmatic = useRef(false);

  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSettle = useCallback(() => {
    if (settle.current !== null) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      settle.current = null;
      settleStrip(true);
    }, 140);
  }, [settleStrip]);

  useEffect(() => () => {
    if (settle.current !== null) clearTimeout(settle.current);
  }, []);

  /*
   * Which edges have more of the year past them, so the fades only appear where
   * there is genuinely something to scroll to.
   *
   * Measured rather than assumed, because the answer changes with the viewport: at
   * a width where all twelve tiles fit there is nothing to scroll and neither fade
   * should show, and hiding them on resize is the difference between a hint and
   * two permanent smudges at the ends of a row.
   *
   * `scroll` events do not fire for every way the position can change - a trackpad
   * fling, a keyboard PageUp, or `scrollIntoView` above all settle without one -
   * so the edges are recomputed on scroll, on resize, and whenever the strip's
   * content changes. A ResizeObserver covers the container, because it is the
   * window resizing (not the content) that flips an overflowing strip into a
   * fitting one.
   */
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // A pixel of slack: fractional scroll offsets are common on trackpads and a
    // strict comparison makes the fade flicker on the last pixel.
    const slack = 1;
    setEdges({
      start: el.scrollLeft > slack,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - slack,
    });
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;

    measure();
    /*
     * One listener doing both jobs: the fades follow every scroll, the settle is
     * debounced inside `scheduleSettle`.
     */
    const onScroll = () => {
      measure();
      /*
       * One event of a programmatic scroll, then back to normal. A smooth settle
       * fires a stream of events and the first clears the flag, but the settle it
       * schedules is a no-op because the position is already on a boundary — so
       * there is no loop.
       */
      if (programmatic.current) {
        programmatic.current = false;
        return;
      }
      scheduleSettle();
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The content can change length without the container resizing - the year
    // changes, so does the number of tiles worth measuring.
    for (const child of Array.from(el.children)) observer.observe(child);

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [measure, scheduleSettle, months, selected.year]);

  return (
    <div className="space-y-2">
      {/*
        Year above the strip, right-aligned: the month name is read first, then the
        year it belongs to. `ml-auto` rather than `justify-end` so the label and
        select stay together on the right instead of drifting apart.
      */}
      <div className="flex items-center justify-end gap-2 text-xs text-neutral-500">
        <label htmlFor="budget-year" className="flex items-center gap-2">
          Year
          <select
            id="budget-year"
            value={selected.year}
            /*
              A native select so it also works as a plain form control; the jump
              needs client state, hence the onChange handler.
            */
            onChange={(event) => {
              const year = Number(event.target.value);
              /*
               * Land on the last month of that year that could have data, so
               * choosing 2025 opens December rather than a month you then have to
               * page forward from. For the current year that is this month.
               */
              const month = year === currentYear ? currentMonth : 12;
              router.push(`/budgets?year=${year}&month=${month}`);
            }}
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
          >
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/*
        The scroller. `overscroll-x-contain` stops a flick at the end of the year
        from scrolling the page behind it - which is the thing that makes a
        horizontal strip feel broken on a phone.

        No CSS scroll-snap here, deliberately. `snap-mandatory` with `snap-start`
        looks like the obvious way to do this and it cannot work: a tile can only
        snap flush to the *start* edge, so the last tiles' snap positions fall
        beyond `maxScroll` and are simply unreachable. Twelve tiles of 72px with an
        8px gap is 952px of content, and at every container width narrow enough to
        scroll at all, December's snap point sits past the end. Mandatory snapping
        then has no valid target for it and leaves the tile wherever the programmatic
        scroll happened to leave it - half cut off, which is exactly what it did.

        So the snapping is done in JS, where the position can be computed and
        checked against the scroll range instead of hoped for.

        `pb-1` leaves room for the focus ring on the first and last tiles, which
        `overflow-x-auto` would otherwise clip.

        `scrollbar-hidden` (globals.css) drops the bar but keeps scrolling. The
        strip being clipped at the edge is what signals there is more of the year
        to see, which is why this works without one - and why removing the arrows
        earlier did not need a replacement affordance.
      */}
      {/*
        `relative` on the wrapper, not the nav: the nav is the scroll container, so
        an absolutely positioned child of it would scroll away with the tiles
        instead of staying pinned to the edge. The fades belong to the frame around
        the strip.
      */}
      <div className="relative">
        <nav
          ref={scroller}
          aria-label="Budget month"
          className="scrollbar-hidden overflow-x-auto overscroll-x-contain pb-1"
        >
          <ul className="flex w-max gap-2">
            {months.map((point) => {
              const index = point.year * 12 + (point.month - 1);
              const isSelected = index === selectedIndex;
              const isCurrent =
                point.year === currentYear && point.month === currentMonth;
              const isFuture = index > currentIndex;
              const empty = point.spent === 0 && point.income === 0;

              const body = (
                <>
                  <span className="flex h-12 items-end justify-center gap-1.5">
                    {empty ? (
                      <span
                        aria-hidden
                        className="h-px w-3 bg-neutral-300 dark:bg-neutral-700"
                      />
                    ) : (
                      <>
                        {/* Spending: solid. */}
                        <span
                          aria-hidden
                          className="w-2.5 rounded-t-full bg-neutral-800 dark:bg-white"
                          style={{
                            height: `${barHeight(point.spent, maxValue(months))}%`,
                          }}
                        />
                        {/* Income: outlined, so the pair reads as a unit. */}
                        <span
                          aria-hidden
                          className="w-2.5 rounded-t-full border-2 border-dashed border-neutral-400 dark:border-neutral-600"
                          style={{
                            height: `${barHeight(point.income, maxValue(months))}%`,
                          }}
                        />
                      </>
                    )}
                  </span>
                  <span className="text-xs font-medium">{monthLabel(point)}</span>
                  {/* Mark today, so "now" is identifiable without reading every
                      label - and so it is still visible when a future month is
                      selected and the highlight has moved off it. */}
                  {isCurrent ? (
                    <span
                      aria-label="Current month"
                      className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-600"
                    />
                  ) : null}
                </>
              );

              const shell = `flex shrink-0 flex-col items-center gap-1 rounded-lg border-2 px-2 py-2.5 transition ${
                isSelected
                  ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-800"
                  : isFuture
                    ? "border-neutral-100 opacity-40 dark:border-neutral-900"
                    : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              }`;

              return (
                <li
                  key={`${point.year}-${point.month}`}
                  ref={isSelected ? selectedRef : undefined}
                  style={{ width: TILE_WIDTH_PX }}
                >
                  {isFuture ? (
                    /*
                      Not a link. A future month cannot have transactions, so this
                      would be a link to a guaranteed-empty page. It is still rendered
                      so the year reads as a whole, and dimmed to say why it is inert.
                    */
                    <span
                      aria-disabled
                      title={`${monthLabel(point)} has not happened yet`}
                      className={`${shell} cursor-default`}
                    >
                      {body}
                    </span>
                  ) : (
                    <Link
                      href={`/budgets?year=${point.year}&month=${point.month}`}
                      aria-current={isSelected ? "page" : undefined}
                      title={`${monthLabel(point)} ${point.year}${
                        point.spent > 0 ? ` · spent ${Math.round(point.spent)}` : ""
                      }${
                        point.income > 0
                          ? ` · income ${Math.round(point.income)}`
                          : ""
                      }`}
                      className={shell}
                    >
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        {/*
          Decorative only. Each shows solely on the side that has more of the year
          past it, so at either end of the year exactly one is visible and a strip
          wide enough to hold everything shows neither.
        */}
        <div aria-hidden className={edges.start ? "fade-edge fade-edge-start" : undefined} />
        <div aria-hidden className={edges.end ? "fade-edge fade-edge-end" : undefined} />
      </div>
    </div>
  );
}

/**
 * Bar height as a percentage of the container.
 *
 * Floored at 6% so a month with small spending against a large one still shows a
 * visible bar; without that a real month looks like an empty one.
 */
function barHeight(value: number, max: number): number {
  if (value <= 0) return 0;
  return Math.max(6, Math.min(100, (value / max) * 100));
}

/** Short month name for a point, e.g. "Sep". */
function monthLabel(point: { year: number; month: number }): string {
  return new Date(Date.UTC(point.year, point.month - 1, 1)).toLocaleDateString(
    "en-US",
    { month: "short", timeZone: "UTC" },
  );
}

/** One scale across the year, so months are comparable. */
function maxValue(months: MonthPoint[]): number {
  return Math.max(1, ...months.flatMap((m) => [m.spent, m.income]));
}