import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeIsGood,
  seriesChange,
  seriesChangeAt,
  type SeriesPoint,
} from "@/lib/series";

/**
 * Which reading a change is measured against.
 *
 * This is the arithmetic behind the figure under every chart and every row of
 * the account breakdown, and it is the thing that decides whether the dashboard
 * says "net worth fell $400 today" or "net worth rose $2,100 since the day
 * before yesterday". Both were once the same number, and which one you get is
 * decided here rather than in the component.
 */

/** Ascending by date, as the snapshot queries guarantee. */
const series: SeriesPoint[] = [
  { date: "2026-10-01", value: 21000 },
  { date: "2026-10-03", value: 20900 },
  { date: "2026-10-05", value: 21400 },
];

test("the period basis measures from the oldest reading on record", () => {
  const change = seriesChange(series, "period");
  assert.equal(change?.from.date, "2026-10-01");
  assert.equal(change?.to.date, "2026-10-05");
  assert.equal(change?.change, 400);
});

test("the day basis measures from the reading before the newest one", () => {
  const change = seriesChange(series, "day");
  assert.equal(change?.from.date, "2026-10-03");
  assert.equal(change?.to.date, "2026-10-05");
  assert.equal(change?.change, 500);
});

test("the two bases disagree whenever the series moved more than once", () => {
  // The point of having both: a year of drift plus one bad night is not the same
  // number as the bad night, and the dashboard asks for the second one.
  const period = seriesChange(series, "period")?.change;
  const day = seriesChange(series, "day")?.change;
  assert.notEqual(period, day);
});

test("a gap in the readings spans the gap rather than reporting nothing", () => {
  /*
   * The 2nd was never recorded - a failed cron, most likely. "Since yesterday"
   * is a guess about the calendar; "since the reading before the newest one" is
   * a fact about the data, and it spans the two days that are actually
   * recorded.
   */
  const dates = series.map((point) => point.date);
  assert.ok(!dates.includes("2026-10-02"));
  assert.equal(seriesChange(series, "day")?.from.date, "2026-10-03");
});

test("no comparison yields null rather than a flat zero", () => {
  // One point: nothing before it. $0.00 would claim it was measured twice and
  // did not move, which is a much stronger claim than "there is nothing yet".
  const single = [series[0]!];
  assert.equal(seriesChange(single, "period"), null);
  assert.equal(seriesChange(single, "day"), null);
  assert.equal(seriesChange([], "period"), null);
  assert.equal(seriesChange([], "day"), null);
});

test("the day basis has no answer for the first reading", () => {
  assert.equal(seriesChangeAt(series, 0, "day"), null);
  // ...but the period basis does, once there is a second point.
  assert.equal(seriesChangeAt(series, 0, "period"), null);
  assert.equal(seriesChangeAt(series, 1, "period")?.change, -100);
});

test("with exactly two readings both bases are the same comparison", () => {
  const two = [series[1]!, series[2]!];
  assert.equal(seriesChange(two, "day")?.change, 500);
  assert.equal(seriesChange(two, "period")?.change, 500);
});

test("an index outside the series has no change", () => {
  assert.equal(seriesChangeAt(series, -1), null);
  assert.equal(seriesChangeAt(series, series.length), null);
});

test("a series that never moved reports zero, not null", () => {
  // The distinction that matters: two identical readings really did measure no
  // movement, which is a result. One reading is not.
  const flat: SeriesPoint[] = [
    { date: "2026-10-01", value: 100 },
    { date: "2026-10-02", value: 100 },
  ];
  assert.equal(seriesChange(flat, "day")?.change, 0);
});

test("a rising balance is bad news on a card or a loan", () => {
  // Balances on those accounts count up as money owed, so the sign of the change
  // inverts. This is the same rule TrendChart's risingIsGood carries, and getting
  // it wrong paints a debt reduction red.
  assert.equal(changeIsGood(500, "depository"), true);
  assert.equal(changeIsGood(-500, "depository"), false);
  assert.equal(changeIsGood(500, "investment"), true);
  assert.equal(changeIsGood(500, "credit"), false);
  assert.equal(changeIsGood(-500, "credit"), true);
  assert.equal(changeIsGood(500, "loan"), false);
  assert.equal(changeIsGood(-500, "loan"), true);
});

test("no movement is neither good nor bad news", () => {
  /*
   * Null, not `false`. The one-liner this replaces - `change > 0 !== isLiability`
   * - reports a flat checking account as bad news and a flat credit card as good,
   * which are both nonsense: nothing happened.
   */
  assert.equal(changeIsGood(0, "depository"), null);
  assert.equal(changeIsGood(0, "credit"), null);
});