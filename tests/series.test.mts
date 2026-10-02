import assert from "node:assert/strict";
import { test } from "node:test";

import { nearestIndex } from "@/lib/series";
import type { NetWorthPoint } from "@/lib/queries";

/**
 * The arithmetic behind the tooltip: given a pointer position, which recorded
 * day is nearest.
 *
 * This is the part that can be quietly wrong. A bad result does not crash - it
 * shows the wrong number with the wrong date, which is the worst possible
 * failure for a figure the user might act on.
 */

const point = (date: string, netWorth: number): NetWorthPoint => ({
  date,
  assets: netWorth,
  liabilities: 0,
  netWorth,
});

/** Ascending by date, as getNetWorthHistory guarantees. */
const series: NetWorthPoint[] = [
  point("2026-09-28", 21000),
  point("2026-09-30", 21100),
  point("2026-10-02", 21191.94),
  point("2026-10-05", 21300),
];

/**
 * A pointer position, at an explicit time of day.
 *
 * The time is load-bearing, not decoration. Snapshots are stored at midnight, so
 * "2026-10-01" means 2026-10-01T00:00Z. A pointer at midday on the 1st is half a
 * day from the 2nd and a day and a half from the 30th, so it snaps to the 2nd -
 * while a pointer at midnight on the 1st sits exactly between them. Anchoring
 * every case to a fixed noon silently turns half of these into the wrong
 * assertion, which is how the first draft of this file got three of them wrong.
 */
const at = (iso: string, time = "00:00") => new Date(`${iso}T${time}:00Z`);

test("no points means no index", () => {
  assert.equal(nearestIndex([], at("2026-10-02")), -1);
});

test("one point is always the answer", () => {
  const single = [point("2026-10-02", 21191.94)];
  assert.equal(nearestIndex(single, at("2020-01-01")), 0);
  assert.equal(nearestIndex(single, at("2030-01-01")), 0);
});

test("a pointer past either end clamps to the end", () => {
  // Hanging off either end is routine - the plot has margins, so a pointer can
  // easily sit outside the first and last points.
  assert.equal(nearestIndex(series, at("2026-01-01")), 0);
  assert.equal(nearestIndex(series, at("2027-01-01")), series.length - 1);
});

test("a pointer on a recorded day resolves to that day", () => {
  assert.equal(nearestIndex(series, at("2026-09-28")), 0);
  assert.equal(nearestIndex(series, at("2026-09-30")), 1);
  assert.equal(nearestIndex(series, at("2026-10-02")), 2);
  assert.equal(nearestIndex(series, at("2026-10-05")), 3);
});

test("a pointer between two days snaps to the nearer one", () => {
  assert.equal(
    nearestIndex(series, at("2026-09-29", "12:00")),
    1,
    "half a day from the 30th, a day and a half from the 28th",
  );
  assert.equal(
    nearestIndex(series, at("2026-10-01", "12:00")),
    2,
    "half a day from the 2nd, a day and a half from the 30th",
  );
  assert.equal(
    nearestIndex(series, at("2026-10-03")),
    2,
    "a day from the 2nd, two from the 5th",
  );
  assert.equal(
    nearestIndex(series, at("2026-10-04")),
    3,
    "a day from the 5th, two from the 2nd",
  );
});

test("an exact tie resolves to the earlier day", () => {
  // Midnight on the 29th is the midpoint of the 28th-30th gap; midnight on the
  // 1st is the midpoint of the 30th-2nd gap. Documented, not incidental: an
  // arbitrary but stable choice beats one that flips as the pointer moves.
  assert.equal(nearestIndex(series, at("2026-09-29")), 0);
  assert.equal(nearestIndex(series, at("2026-10-01")), 1);
  assert.equal(
    nearestIndex(series, at("2026-10-03", "12:00")),
    2,
    "midpoint of the 2nd-5th gap",
  );
});

test("gaps between snapshots are handled, not interpolated", () => {
  /*
   * 29 and 30 September, and anything between the 2nd and the 5th, were never
   * recorded. A pointer in a gap must resolve to a day that exists rather than
   * inventing one - a tooltip reading "$21,140" for a day with no snapshot would
   * be a figure the user might act on.
   */
  assert.ok(series.every((p) => p.date !== "2026-09-29"));
  assert.ok(series.every((p) => p.date !== "2026-10-01"));
  for (const target of ["2026-09-29", "2026-10-01", "2026-10-03", "2026-10-04"]) {
    const index = nearestIndex(series, at(target));
    assert.ok(series[index] !== undefined, `${target} resolves to a recorded day`);
  }
});

test("every pointer across the range resolves to a real index", () => {
  // Brute force over a dense sweep: the binary search must never return -1 or
  // step outside the series, whichever side of a gap the pointer lands on.
  const start = Date.parse("2026-09-20T00:00:00Z");
  const end = Date.parse("2026-10-20T00:00:00Z");
  for (let t = start; t <= end; t += 3_600_000) {
    const index = nearestIndex(series, new Date(t));
    assert.ok(
      index >= 0 && index < series.length,
      `index ${index} in range at ${t}`,
    );
  }
});

test("a single-day series does not divide by zero", () => {
  // The degenerate case behind the original hand-rolled chart: a one-point series
  // has no gap to bisect.
  const one = [point("2026-10-02", 21191.94)];
  for (const target of ["2026-01-01", "2026-10-02", "2026-12-31"]) {
    assert.equal(nearestIndex(one, at(target)), 0);
  }
});
