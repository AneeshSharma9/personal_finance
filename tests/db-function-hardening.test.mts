import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Every function in `public` must pin its `search_path`.
 *
 * Supabase's advisor flagged `apply_loan_payment_to_balance` as
 * `function_search_path_mutable` (WARN, `function_search_path_mutable`). It is a
 * trigger that moves a loan's balance, and it referred to `loans` unqualified, so
 * it resolved the table against whatever the caller's path happened to be. A
 * `loans` table earlier on that path would have received the balance update: the
 * payment would look posted while the loan never moved, and `last_accrued_at`
 * would stop being the thing interest accrues from.
 *
 * Not exploitable in this app as configured - `anon` and `authenticated` have no
 * CREATE anywhere and cannot add a schema - but that is a property of the current
 * grants rather than of the function, and it is the kind of gap that becomes real
 * the moment someone enables something.
 *
 * Checked per *final* definition rather than per `CREATE`: migration `0004`
 * created the function without a pinned path and `0017` replaced it with one, so
 * "every CREATE has a pinned path" would fail on correct history. What matters is
 * the definition a database ends up with.
 */

const MIGRATIONS = "drizzle";

/**
 * The last `CREATE [OR REPLACE] FUNCTION <name>` in the migration history.
 *
 * Each entry is the whole statement, so a test can assert on what the function ends
 * up as rather than on the line it was introduced on.
 */
function latestFunctionDefinitions(): Map<string, string> {
  const sql = readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) => readFileSync(join(MIGRATIONS, entry), "utf8"))
    .join("\n");

  // `LANGUAGE plpgsql` is mandatory, so it is a reliable end-of-definition marker.
  const statements = sql.split(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  const latest = new Map<string, string>();
  for (const statement of statements.slice(1)) {
    const name = statement.match(/^\s*(?:public\.)?"?([a-z_]+)"?\s*\(/i)?.[1];
    if (name) latest.set(name, statement);
  }
  return latest;
}

test("every function in the migrations ends up with a pinned search_path", () => {
  const unpinned = [...latestFunctionDefinitions()]
    .filter(([, definition]) => !/SET\s+search_path/i.test(definition))
    .map(([name]) => name);

  assert.deepEqual(
    unpinned,
    [],
    "these functions resolve table names against the caller's search_path; add " +
      "SET search_path = '' and qualify the names they use",
  );
});

test("the balance trigger pins an empty search_path, not a usable one", () => {
  /*
   * `SET search_path = public` would satisfy the linter while leaving `pg_temp`
   * reachable in a session that sets it - a temp table named `loans` is exactly
   * the hijack. Only the empty value cannot be widened by whoever deploys the next
   * migration, so it is asserted specifically rather than by the looser check
   * above.
   */
  const definition = latestFunctionDefinitions().get("apply_loan_payment_to_balance");
  assert.ok(definition, "the function should exist in the migration history");

  const pinned = definition.match(/SET\s+search_path\s*=\s*'([^']*)'/i);
  assert.ok(pinned, "the function must pin a search_path");
  assert.equal(
    pinned[1]!.trim(),
    "",
    "an empty search_path is the only value that cannot be widened later",
  );
});

test("the balance trigger qualifies the table it updates", () => {
  /*
   * An empty search_path means every name the function uses has to be qualified,
   * so this is what keeps the empty pin from turning into a runtime error the
   * first time somebody records a loan payment.
   */
  const definition = latestFunctionDefinitions().get("apply_loan_payment_to_balance")!;
  const updates = [...definition.matchAll(/UPDATE\s+([a-z_.]+)/gi)].map((m) => m[1]!);

  assert.ok(updates.length > 0, "the function should update something");
  for (const target of updates) {
    assert.ok(
      target.startsWith("public."),
      `"${target}" is unqualified and would not resolve with search_path = ''`,
    );
  }
});

test("the function list is non-empty, so an empty result means a broken regex", () => {
  /*
   * The tests above are all "nothing is unpinned". If the extraction silently
   * returned an empty map they would pass while checking nothing - the same trap
   * as a list-comprehension assertion that cannot fail.
   */
  const names = [...latestFunctionDefinitions().keys()];
  assert.ok(names.length > 0, "no functions found in the migrations");
  assert.ok(names.includes("apply_loan_payment_to_balance"));
});