import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  accountDisplayName,
  accountNameHint,
  isRenamedName,
} from "@/lib/account-name";

/**
 * Naming an account, and the one thing that would quietly break it.
 *
 * The rule under test is that the user's name for an account survives. It looks
 * like a display concern and it is not: `accounts.name` is Plaid's, and
 * `syncAccounts` puts it in the upsert's `set` map, so a rename written to
 * `name` is reverted by the next sync - a manual one, one triggered by a page
 * load, or the nightly cron. The rename therefore lives in its own column and is
 * applied at read time, which is why the assertions below are as much about the
 * absence of `nameOverride` in the sync as about the naming functions.
 *
 * The read-path assertions are here for the same reason: `getAccountChanges` is
 * raw SQL rather than a Drizzle query, so it is the one place an override can be
 * quietly dropped, and the accounts page would go back to showing bank names in
 * the breakdown while every other surface showed the nickname.
 */

const read = (path: string): string => readFileSync(path, "utf8");

const SYNC = "src/lib/plaid/sync.ts";
const ACCOUNTS_API = "src/app/api/accounts/[id]/route.ts";
const QUERIES = "src/lib/queries.ts";

test("an account with no nickname is called what the bank calls it", () => {
  const account = { name: "Chase Total Checking", nameOverride: null };
  assert.equal(accountDisplayName(account), "Chase Total Checking");
});

test("a nickname replaces the bank's name on screen", () => {
  const account = { name: "Chase Total Checking", nameOverride: "Everyday" };
  assert.equal(accountDisplayName(account), "Everyday");
});

test("an empty nickname is no nickname, not a blank label", () => {
  /*
   * `PATCH /api/accounts/[id]` normalises a blank field to null rather than
   * storing it, so this cannot happen through the app. It matters anyway because
   * `??` is the wrong operator here: `"" ?? name` is `""`, which would render an
   * account with no visible name and no way to tell it apart from a broken row.
   */
  const account = { name: "Chase Total Checking", nameOverride: "" };
  assert.equal(accountDisplayName(account), "");
  assert.equal(isRenamedName("", "Chase Total Checking"), true);
});

test("nothing is offered to reveal when the account was not renamed", () => {
  assert.equal(accountNameHint("Checking", "Checking"), null);
});

test("a renamed account can still be checked against the bank's name", () => {
  /*
   * Only the bank's name is in the hint, because the nickname is already the
   * text on screen - repeating it would make the tooltip longer for nothing.
   */
  const hint = accountNameHint("Everyday", "Chase Total Checking");
  assert.ok(hint, "a renamed account should produce a hint");
  assert.match(hint, /Chase Total Checking/);
});

test("a nickname identical to the bank's name reads as unrenamed", () => {
  /*
   * Nothing stops someone typing the name that was already there. Treating that
   * as renamed would add an empty hint and a pointless "Bank calls this" detail
   * to the account page for no gain, so the two are compared rather than null
   * alone being trusted.
   */
  assert.equal(isRenamedName("Checking", "Checking"), false);
  assert.equal(accountNameHint("Checking", "Checking"), null);
});

test("the sync never writes the nickname", () => {
  const source = read(SYNC);

  /*
   * Scoped to the upsert's `set` map rather than the whole file. The insert
   * half deliberately does not carry `nameOverride` either - a new row starts
   * unrenamed - but what matters is that the update half leaves the existing
   * value alone, and a whole-file check would also flag the column definition.
   */
  const setMap = source.match(/set: fromExcluded\(\{([\s\S]*?)\}\)/);
  assert.ok(setMap, "the account upsert should still use fromExcluded");

  assert.doesNotMatch(
    setMap[1]!,
    /nameOverride/,
    "a nameOverride in the upsert's set map reverts every rename on the next sync",
  );
  assert.match(
    setMap[1]!,
    /name:/,
    "Plaid's own name is still refreshed, which is what the rename sits beside",
  );
});

test("the rename is written as an override, never as the name", () => {
  const source = read(ACCOUNTS_API);
  assert.match(
    source,
    /\.set\(\{\s*nameOverride/,
    "PATCH must target name_override",
  );
  assert.doesNotMatch(
    source,
    /\.set\(\{[^}]*\bname:/,
    "writing accounts.name would be reverted by the next sync",
  );
});

test("the change breakdown resolves the nickname too", () => {
  const source = read(QUERIES);
  /*
   * This one is raw SQL rather than Drizzle, so nothing else would notice if it
   * kept selecting `a.name`: every other surface would show the nickname and the
   * breakdown on the same page would not.
   */
  assert.match(
    source,
    /a\.name_override/,
    "getAccountChanges should read the override",
  );
  assert.match(
    source,
    /row\.name_override \?\? row\.name/,
    "and fall back to the bank's name when there is none",
  );
});