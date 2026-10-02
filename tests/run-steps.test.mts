import assert from "node:assert/strict";
import { test } from "node:test";

import { runSteps } from "@/lib/run-steps";

/**
 * The cron's two steps have different failure characters, and the order between
 * them is load-bearing.
 *
 * The daily job syncs Plaid and then snapshots balances. Reversed, it would file
 * today's net-worth reading using whatever balances the last page load left
 * behind - a silent, plausible-looking, permanently one-day-stale chart. And if a
 * Plaid outage aborted the run, the day would have no snapshot at all, which is
 * strictly worse than a snapshot of the last known balances.
 */

test("steps run in the order given, not concurrently", async () => {
  const order: string[] = [];

  await runSteps([
    {
      name: "sync",
      run: async () => {
        order.push("sync:start");
        // A real Plaid sync is many awaited round trips. Yield between steps so a
        // concurrent implementation would visibly interleave.
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("sync:end");
      },
    },
    {
      name: "snapshot",
      run: async () => {
        order.push("snapshot:start");
        order.push("snapshot:end");
      },
    },
  ]);

  assert.deepEqual(order, [
    "sync:start",
    "sync:end",
    "snapshot:start",
    "snapshot:end",
  ]);
});

test("a failing step does not stop the ones after it", async () => {
  let snapshotRan = false;

  const results = await runSteps([
    {
      name: "sync",
      run: async () => {
        throw new Error("Plaid is down");
      },
    },
    {
      name: "snapshot",
      run: async () => {
        snapshotRan = true;
      },
    },
  ]);

  assert.equal(snapshotRan, true, "the snapshot must still land");
  assert.deepEqual(results, [
    { name: "sync", ok: false, error: "Plaid is down" },
    { name: "snapshot", ok: true },
  ]);
});

test("every step is attempted even when the first one throws", async () => {
  const ran: string[] = [];

  const results = await runSteps([
    { name: "a", run: async () => void ran.push("a") },
    {
      name: "b",
      run: async () => {
        throw new Error("boom");
      },
    },
    { name: "c", run: async () => void ran.push("c") },
  ]);

  assert.deepEqual(ran, ["a", "c"]);
  assert.equal(results.filter((step) => !step.ok).length, 1);
  assert.equal(results[1]?.error, "boom");
});

test("a non-Error throw is still reported rather than swallowed", async () => {
  const results = await runSteps([
    {
      name: "sync",
      run: async () => {
        throw "a bare string";
      },
    },
  ]);

  assert.equal(results[0]?.ok, false);
  assert.ok(results[0]?.error, "a message must be present so the log is useful");
});

test("no steps is a valid run", async () => {
  assert.deepEqual(await runSteps([]), []);
});