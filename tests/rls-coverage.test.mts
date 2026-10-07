import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Every table in `public` must be behind Row-Level Security.
 *
 * This is a real breach, not a hypothetical. Every table was created through Drizzle
 * without RLS, and Supabase grants `anon` and `authenticated` full table access by
 * default - so with the project URL and the anon key (which ships in the browser
 * bundle, so it is public) PostgREST served the entire database. Verified against
 * the live project before the fix: `GET /rest/v1/transactions` returned HTTP 200
 * and all 358 rows to an unauthenticated caller, the same for `users`, `loans` and
 * `loan_payments`, with UPDATE and DELETE available too. After `0016_enable_rls`
 * the same request returns 401.
 *
 * The app never needed that access - Supabase is used for auth only, and every
 * table is read through Drizzle as the table owner, which bypasses RLS - so the fix
 * is RLS on with no policies, plus revoking the grants.
 *
 * Asserted against the schema and the migrations rather than a live database,
 * because the thing being guarded is a *relationship*: a table added to the schema
 * without a migration line. `tsc`, `eslint` and the other 350 tests all pass with
 * a table like that, and Supabase finds it weeks later by email.
 */

const SCHEMA = "src/db/schema.ts";
const MIGRATIONS = "drizzle";

/** Table names as declared in the schema. */
function schemaTables(): string[] {
  const source = readFileSync(SCHEMA, "utf8");
  return [...source.matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map((match) => match[1]!);
}

/** Every migration's SQL, concatenated: coverage is cumulative, as in Postgres. */
function allMigrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) => readFileSync(join(MIGRATIONS, entry), "utf8"))
    .join("\n");
}

test("every table in the schema has RLS enabled by a migration", () => {
  const sql = allMigrationSql();
  const unprotected = schemaTables().filter(
    (table) =>
      !new RegExp(
        `ALTER TABLE\\s+"public"\\."${table}"\\s+ENABLE ROW LEVEL SECURITY`,
      ).test(sql),
  );

  assert.deepEqual(
    unprotected,
    [],
    "these tables are reachable through PostgREST with the public anon key; " +
      'add ALTER TABLE "public"."<table>" ENABLE ROW LEVEL SECURITY to a migration',
  );
});

test("RLS on is backed by revoking the grants, not just by the policy check", () => {
  /*
   * RLS with no policies is already deny-by-default, so this is the belt to its
   * braces: the grants are what Supabase's "table publicly accessible" check reads,
   * and leaving them means a future `DISABLE ROW LEVEL SECURITY` - or a table
   * recreated by `drizzle-kit push` - is exploitable again with no code change.
   */
  const sql = allMigrationSql();
  const stillGranted = schemaTables().filter(
    (table) =>
      !new RegExp(
        `REVOKE ALL ON TABLE\\s+"public"\\."${table}"\\s+FROM\\s+"anon"`,
      ).test(sql),
  );

  assert.deepEqual(
    stillGranted,
    [],
    "add REVOKE ALL ON TABLE \"public\".\"<table>\" FROM \"anon\" to a migration",
  );

  const authenticated = schemaTables().filter(
    (table) =>
      !new RegExp(
        `REVOKE ALL ON TABLE\\s+"public"\\."${table}"\\s+FROM\\s+"authenticated"`,
      ).test(sql),
  );

  assert.deepEqual(
    authenticated,
    [],
    "add REVOKE ALL ON TABLE \"public\".\"<table>\" FROM \"authenticated\" to a migration",
  );
});

test("no table uses FORCE ROW LEVEL SECURITY, which would lock the app out", () => {
  /*
   * FORCE applies RLS to the table owner as well, and the owner is how the app
   * reaches its data - Drizzle connects as `postgres`, the table owner, not as a
   * PostgREST role. With no policies, FORCE means the app reads nothing and every
   * page 500s. It is a one-word mistake with a very confusing symptom, so it is
   * worth a check rather than a comment.
   */
  const sql = allMigrationSql();
  const forced = [
    ...sql.matchAll(
      /ALTER TABLE\s+"public"\."([a-z_]+)"\s+FORCE ROW LEVEL SECURITY/g,
    ),
  ].map((match) => match[1]!);

  assert.deepEqual(forced, [], "FORCE RLS would deny the app's own connection");
});

test("the schema has tables to check, so an empty result means a broken regex", () => {
  /*
   * Every assertion above is "nothing is unprotected". If `schemaTables()` silently
   * returned an empty list - a refactor of the schema file, a renamed helper - they
   * would all pass while checking nothing at all. The tests are only meaningful
   * while the set they compare against is non-empty and matches the database's 17.
   */
  const tables = schemaTables();
  assert.ok(tables.length > 0, "no tables found in the schema");
  assert.equal(new Set(tables).size, tables.length, "table names are unique");
  assert.ok(
    tables.includes("transactions") && tables.includes("users"),
    "the two tables that leaked are the ones being guarded",
  );
});