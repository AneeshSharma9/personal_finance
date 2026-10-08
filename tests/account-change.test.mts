import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BEGINNING_OF_TIME,
  CHANGE_PERIODS,
  CHANGE_PERIODS_WITH_WINDOW,
  changePeriodFrom,
  changePeriodWindow,
  DEFAULT_CHANGE_PERIOD,
  parseChangePeriod,
  parseChartPeriod,
  resolveAccountChange,
  splitByLiability,
  type AccountChangeRow,
} from "@/lib/change-period";
import { seriesChange } from "@/lib/series";

/**
 * Which reading an account's change is measured against, and what the list says
 * when there isn't one.
 *
 * The rows here are what the nightly job writes: one reading per account per
 * day, nothing before the app existed. So every edge case below is one this app
 * actually hits on day one, day two, and after a weekend the cron missed.
 */

const period = (id: string) => {
  const found = CHANGE_PERIODS.find((entry) => entry.id === id);
  assert.ok(found, `unknown period ${id}`);
  return found;
};

function row(overrides: Partial<AccountChangeRow> = {}): AccountChangeRow {
  return {
    accountId: 1,
    name: "Checking",
    // Same as `name` unless a test renames the account: the unrenamed case is
    // what makes `plaidName` a field rather than something to derive.
    plaidName: "Checking",
    institutionName: "Bank",
    mask: "1234",
    type: "depository",
    latest: { date: "2026-10-05", value: 1200 },
    previous: { date: "2026-10-04", value: 1000 },
    windowStart: { date: "2026-10-01", value: 800 },
    ...overrides,
  };
}

test("the previous-day period measures against the reading before the newest", () => {
  const resolved = resolveAccountChange(row(), period("1d"));
  assert.equal(resolved.from?.date, "2026-10-04");
  assert.equal(resolved.change, 200);
});

test("the previous-day period ignores the window entirely", () => {
  /*
   * The window reaches back 30 days but the answer is still the day before.
   * Otherwise "Previous day" would quietly become "the whole window" for any
   * account with an early snapshot in it.
   */
  const resolved = resolveAccountChange(row(), period("1d"));
  assert.notEqual(resolved.from?.date, "2026-10-01");
});

test("a windowed period measures against the oldest reading inside it", () => {
  const resolved = resolveAccountChange(row(), period("1m"));
  assert.equal(resolved.from?.date, "2026-10-01");
  assert.equal(resolved.change, 400);
});

test("all time means the whole record", () => {
  const resolved = resolveAccountChange(row(), period("all"));
  assert.equal(resolved.from?.date, "2026-10-01");
  assert.equal(resolved.change, 400);
});

test("an account linked yesterday has no previous day", () => {
  // One reading. Reporting $0.00 would say it was measured twice and stood still.
  const fresh = row({ previous: null, windowStart: null });
  const resolved = resolveAccountChange(fresh, period("1d"));
  assert.equal(resolved.change, null);
  assert.equal(resolved.from, null);
  assert.equal(resolved.good, null);
});

test("an account with nothing recorded at all is a null change, not a zero", () => {
  const blank = row({ latest: null, previous: null, windowStart: null });
  for (const id of ["1d", "1m", "all"]) {
    const resolved = resolveAccountChange(blank, period(id));
    assert.equal(resolved.change, null, `${id} should have nothing to report`);
  }
});

test("a window holding one reading falls back to the nearest real comparison", () => {
  /*
   * A one-day window over a daily series contains exactly one reading, so
   * measuring windowStart against latest is always $0.00 - which reads as "nothing
   * moved" rather than "we only know one figure". `previous` is the nearest
   * genuine comparison, and the row names its date so the span is visible.
   */
  const narrow = row({ windowStart: { date: "2026-10-05", value: 1200 } });
  const resolved = resolveAccountChange(narrow, period("1d"));
  assert.equal(resolved.from?.date, "2026-10-04");
  assert.equal(resolved.change, 200);
});

test("a window with no readings at all falls back to the previous reading", () => {
  // The cron has been down for a week. "30 days" cannot be answered from data
  // that does not exist, so it answers the nearest question it can and says so.
  const stale = row({ windowStart: null });
  const resolved = resolveAccountChange(stale, period("1m"));
  assert.equal(resolved.from?.date, "2026-10-04");
  assert.equal(resolved.change, 200);
});

test("a card's rising balance is bad news, its falling balance good", () => {
  const card = (previous: number, latest: number) =>
    resolveAccountChange(
      row({ type: "credit", previous: { date: "2026-10-04", value: previous }, latest: { date: "2026-10-05", value: latest } }),
      period("1d"),
    );

  assert.equal(card(500, 900).good, false);
  assert.equal(card(900, 500).good, true);
  assert.equal(card(500, 500).good, null);
});

test("credit cards and loans are split out as liabilities", () => {
  /*
   * The sign of a change only means something inside a group: a card's balance
   * rising is debt growing, while savings rising is money growing. Interleaving
   * them in one ranked list reads as a contradiction, which is why the breakdown
   * renders two lists rather than one.
   */
  const rows = [
    resolveAccountChange(row({ accountId: 1, type: "depository" }), period("1d")),
    resolveAccountChange(row({ accountId: 2, type: "investment" }), period("1d")),
    resolveAccountChange(row({ accountId: 3, type: "credit" }), period("1d")),
    resolveAccountChange(row({ accountId: 4, type: "loan" }), period("1d")),
  ];

  const { assets, liabilities } = splitByLiability(rows);
  assert.deepEqual(
    assets.map((entry) => entry.accountId),
    [1, 2],
  );
  assert.deepEqual(
    liabilities.map((entry) => entry.accountId),
    [3, 4],
  );
});

test("an account of an unlisted type counts as an asset", () => {
  // `other` accounts are neither assets nor liabilities by name, and the historic
  // behaviour is to count them with the assets. Anything not a known liability is.
  const rows = [
    resolveAccountChange(row({ accountId: 1, type: "other" }), period("1d")),
  ];
  assert.deepEqual(splitByLiability(rows).liabilities, []);
  assert.equal(splitByLiability(rows).assets.length, 1);
});

test("the default period is the previous day", () => {
  /*
   * Asserted as a literal rather than against `DEFAULT_CHANGE_PERIOD`, because
   * every other test here compares against that constant - which would keep
   * passing if the default silently changed to anything at all, including the
   * whole record it used to be.
   */
  assert.equal(DEFAULT_CHANGE_PERIOD.id, "1d");
  assert.equal(DEFAULT_CHANGE_PERIOD.basis, "day");
  assert.equal(parseChangePeriod(undefined).id, "1d");
});

test("an unrecognised or missing period falls back to the default", () => {
  assert.equal(parseChangePeriod(undefined).id, DEFAULT_CHANGE_PERIOD.id);
  assert.equal(parseChangePeriod("yesterday").id, DEFAULT_CHANGE_PERIOD.id);
  assert.equal(parseChangePeriod(42).id, DEFAULT_CHANGE_PERIOD.id);
  // A repeated parameter takes the first, like every other searchParam here.
  assert.equal(parseChangePeriod(["1m", "1w"]).id, "1m");
});

test("a known period is honoured", () => {
  assert.equal(parseChangePeriod("1m").id, "1m");
  assert.equal(parseChangePeriod("1d").basis, "day");
});

test("the whole record asks for no lower bound", () => {
  assert.equal(changePeriodFrom(period("all")), BEGINNING_OF_TIME);
});

test("a windowed period reaches back from today, not from the last reading", () => {
  /*
   * Anchoring to the newest snapshot narrows the window without saying so: with
   * the last snapshot three days old, "30 days" would quietly cover 27.
   */
  const today = new Date("2026-10-05T09:00:00Z");
  assert.equal(changePeriodFrom(period("1m"), today), "2026-09-05");
  assert.equal(changePeriodFrom(period("1w"), today), "2026-09-28");
});

test("the one-day period has no window to compute", () => {
  assert.equal(changePeriodFrom(period("1d")), BEGINNING_OF_TIME);
});

test("a period also decides which points its chart plots", () => {
  /*
   * The selector moves the window as well as the basis, because a period control
   * that left the chart alone would be asking the reader to believe two different
   * things at once.
   *
   * A date, not a count of readings. They look the same while the cron runs every
   * day, and stop being the same the moment it misses one - thirty rows then
   * covers five weeks, while the same window as a date still covers thirty days
   * and just shows fewer points. A label in days can only be honoured by a date.
   */
  const today = new Date("2026-10-05T09:00:00Z");
  assert.equal(changePeriodWindow(period("1m"), today), "2026-09-05");
  assert.equal(changePeriodWindow(period("1w"), today), "2026-09-28");
  assert.equal(changePeriodWindow(period("1y"), today), "2025-10-05");
});

test("all time plots every snapshot", () => {
  // Undefined rather than a floor: an unbounded query says "no bound" honestly,
  // where BEGINNING_OF_TIME says it with a magic date.
  assert.equal(changePeriodWindow(period("all")), undefined);
});

test("every period offered on a chart page bounds that chart", () => {
  /*
   * Each offered option must actually move the graph, because an option that does
   * not is a control that lies about what it selected. "Previous day" was once
   * excluded from the chart pages for failing this - on the reasoning that a
   * one-day window holds a single reading - which turned out to be wrong; see the
   * next test.
   */
  assert.ok(CHANGE_PERIODS_WITH_WINDOW.length > 1);
  for (const entry of CHANGE_PERIODS_WITH_WINDOW) {
    if (entry.days === null && entry.basis === "period") {
      // "All time": unbounded is what it means.
      assert.equal(entry.id, "all");
      assert.equal(changePeriodWindow(entry), undefined);
      continue;
    }
    assert.notEqual(
      changePeriodWindow(entry),
      undefined,
      `${entry.id} would leave the chart untouched`,
    );
  }
});

test("the day basis is offered on chart pages too", () => {
  // It used to be filtered out of CHANGE_PERIODS_WITH_WINDOW. The reason given
  // was that a one-day window is a single reading - true only if the floor were
  // today, and it is yesterday, so daily data yields yesterday AND today.
  assert.ok(
    CHANGE_PERIODS_WITH_WINDOW.some((entry) => entry.id === "1d"),
    "the option that shows the day-over-day change is the one people reach for",
  );
});

test("the one-day window reaches two days back", () => {
  /*
   * Not one. The day rolls over at UTC midnight (8pm in New York) and the cron
   * writes at 12:34 UTC (8:34am), so a one-day floor held exactly one reading for
   * those twelve and a half hours and the chart showed "No graph data available" on
   * the option most likely to be opened.
   *
   * Two days guarantees two readings at every hour, at the cost of briefly drawing
   * yesterday against the day before while today's row is still pending.
   */
  const today = new Date("2026-10-08T03:00:00Z"); // 11pm EDT Oct 7
  assert.equal(changePeriodWindow(period("1d"), today), "2026-10-06");
});

test("the one-day window always contains two readings", () => {
  /*
   * The property the floor exists for, asserted across the whole day rather than
   * at one instant: whatever hour it is, a daily series leaves two readings inside
   * the window, so the chart always has a line to draw.
   *
   * The cron writes day D's row at 12:34 UTC, so "has today's row landed yet" is
   * the thing that varies.
   */
  const daily = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  const landedAt = (date: string) => new Date(`${date}T12:34:00Z`);

  for (let hour = 0; hour < 24; hour += 1) {
    const now = new Date(`2026-10-08T${String(hour).padStart(2, "0")}:00:00Z`);
    const floor = changePeriodWindow(period("1d"), now)!;
    const rows = daily.filter(
      (date) => date >= floor && now >= landedAt(date),
    );
    assert.ok(
      rows.length >= 2,
      `${String(hour).padStart(2, "0")}:00Z leaves ${rows.length} reading(s)`,
    );
  }
});

test("a one-day floor would NOT survive the pre-cron hours", () => {
  /*
   * Why the floor is two days and not one. Same daily series, same hours, floor of
   * yesterday: empty from UTC midnight until the cron fires. This is the failure
   * the extra day buys out of, kept as an assertion so the widening is not mistaken
   * for arbitrary padding later.
   */
  const daily = ["2026-10-06", "2026-10-07", "2026-10-08"];
  const landedAt = (date: string) => new Date(`${date}T12:34:00Z`);

  const empty = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const now = new Date(`2026-10-08T${String(hour).padStart(2, "0")}:00:00Z`);
    const twoDayFloor = "2026-10-06";
    const oneDayFloor = "2026-10-07";
    const rows = daily.filter(
      (date) => date >= oneDayFloor && now >= landedAt(date),
    );
    if (rows.length < 2) empty.push(hour);
    assert.ok(
      daily.filter((d) => d >= twoDayFloor && now >= landedAt(d)).length >= 2,
      `two-day floor must always win at ${hour}:00Z`,
    );
  }

  // 00:00Z through 12:00Z, inclusive: the thirteen hours before the cron.
  assert.deepEqual(empty, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("the one-day window still gives a day-over-day change", () => {
  // Widening the window must not turn the option into "the last two days": the
  // change is taken between the newest reading and the one before it.
  const today = new Date("2026-10-08T09:00:00Z");
  const from = changePeriodWindow(period("1d"), today)!;
  const points = [
    { date: from, value: 1000 },
    { date: "2026-10-07", value: 1100 },
    { date: "2026-10-08", value: 1200 },
  ];
  assert.equal(seriesChange(points, "day")?.change, 100);
  assert.equal(seriesChange(points, "day")?.from.date, "2026-10-07");
  assert.equal(seriesChange(points, "period")?.change, 200);
});

test("parseChartPeriod is the plain parser", () => {
  // It existed only to reject the day basis on chart pages, which turned out to
  // be wrong. Kept as a named export so the call sites read as what they mean and
  // so restoring it would be a deliberate act.
  for (const id of CHANGE_PERIODS.map((entry) => entry.id)) {
    assert.equal(parseChartPeriod(id).id, id, `${id} should resolve to itself`);
  }
  assert.equal(parseChartPeriod(undefined).id, DEFAULT_CHANGE_PERIOD.id);
  assert.equal(parseChartPeriod("garbage").id, DEFAULT_CHANGE_PERIOD.id);
});

test("the net worth chart opens on the same short window", () => {
  /*
   * Worth stating because it is a consequence rather than the point: `parseChartPeriod`
   * shares this default, so `/net-worth` no longer plots a year of history on arrival.
   * A one-day basis plots two readings (`changePeriodWindow` widens it deliberately),
   * which is enough for the day-over-day change and thin for a trend line - so if the
   * long view is wanted by default on that page alone, the default has to stop being
   * shared rather than this assertion being loosened.
   */
  assert.equal(parseChartPeriod(undefined).id, "1d");
  const today = new Date("2026-10-08T09:00:00Z");
  assert.equal(
    changePeriodWindow(parseChartPeriod(undefined), today),
    "2026-10-06",
  );
});

test("the chart window and the change window agree on the same day", () => {
  /*
   * Two functions computing the same bound, so they are asserted against each
   * other rather than each against a literal. If they ever drift, the change is
   * measured across a period the chart does not show - the exact confusion the
   * selector exists to remove.
   */
  const today = new Date("2026-10-05T09:00:00Z");
  for (const id of ["1w", "1m", "3m", "1y"]) {
    assert.equal(
      changePeriodWindow(period(id), today),
      changePeriodFrom(period(id), today),
      `${id} should bound the chart and the change identically`,
    );
  }
});