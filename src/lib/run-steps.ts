/**
 * Run named steps in order, where a failure ends one step rather than the run.
 *
 * The daily cron needs this because its two steps have different failure
 * characters. A Plaid outage must not cost us the day's net-worth snapshot:
 * recording the last known balances is strictly better than recording nothing,
 * and the sync is free to retry on the next run because Plaid's sync is
 * cursor-based and therefore idempotent.
 *
 * Order is the contract, not an implementation detail - hence a sequential list
 * rather than a `Promise.all`. The snapshot reads balances that the sync writes,
 * so reordering the two would silently file today's reading using yesterday's
 * numbers, and nothing downstream would ever notice.
 */
export type Step = {
  name: string;
  run: () => Promise<void>;
};

export type StepResult = {
  name: string;
  ok: boolean;
  error?: string;
};

/**
 * Runs every step, in the order given, and reports each one's outcome.
 *
 * A step that throws is recorded as failed and the run continues, so the caller
 * can tell "the sync failed but we snapshotted anyway" apart from "everything
 * ran".
 */
export async function runSteps(
  steps: readonly Step[],
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const step of steps) {
    try {
      await step.run();
      results.push({ name: step.name, ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Step failed for an unknown reason.";
      console.error(`[steps] "${step.name}" failed: ${message}`);
      results.push({ name: step.name, ok: false, error: message });
    }
  }

  return results;
}