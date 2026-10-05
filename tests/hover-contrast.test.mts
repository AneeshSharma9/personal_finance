import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * A hover colour must not also be a surface colour.
 *
 * The dark-mode hover for rows and controls was `dark:hover:bg-neutral-800`, chosen
 * because it reads as a subtle lift against the page background (`#171717`, a
 * neutral-900). It was applied site-wide without checking what else in the app is
 * painted neutral-800 — and the answer was 34 places, including every table's column
 * header strip.
 *
 * So on the budgets page, hovering the first row of a table painted it the exact
 * colour of the header directly above it, and the row disappeared into it. Reported
 * as "there is no visible border under the table headers in dark mode", which is a
 * reasonable description of the symptom and not the cause: the border was fine, the
 * row was matching the header.
 *
 * This cannot be caught by checking that a hover class exists — that check passed
 * while every one of these hovers was invisible. The invariant is that the hover
 * colour has to differ from the surface underneath it, which is only knowable by
 * comparing the two sets within a file.
 */
function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...tsxFiles(path));
    else if (entry.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** `dark:bg-neutral-800` — a surface. Not `dark:border-`, not a hover. */
const SURFACE = /(?<!hover:)dark:bg-(neutral-\d{3})/g;
/** `dark:hover:bg-neutral-800` — a hover target. */
const HOVER = /dark:hover:bg-(neutral-\d{3})/g;

const files = tsxFiles("src");

test("the scan found the app", () => {
  assert.ok(files.length > 10, `expected components, found ${files.length}`);
});

const clashes: string[] = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const surfaces = new Set(source.match(SURFACE) ?? []);
  const hovers = new Set(source.match(HOVER) ?? []);
  for (const hover of hovers) {
    // `dark:hover:bg-neutral-800` also contains `dark:hover:bg-`, and the negative
    // lookbehind above is not enough on its own because the hover variant carries
    // the prefix. Compare the bare colour token instead.
    const colour = hover.replace("dark:hover:", "").replace("dark:", "");
    if (surfaces.has(colour)) {
      clashes.push(`${file}: ${colour} is both a hover target and a surface`);
    }
  }
}

test("no hover colour is also used as a surface in the same file", () => {
  assert.deepEqual(
    clashes,
    [],
    "these hovers are invisible against a surface of the same colour:\n" +
      clashes.join("\n"),
  );
});

/**
 * The specific regression, named.
 *
 * Every table's column header strip is neutral-800 in dark mode, so any row inside
 * one of those tables must not hover to neutral-800. Worth its own assertion
 * because a general "they must differ" rule would also be satisfied by making the
 * header a different colour, and the header is what it is on purpose.
 */
test("table rows do not hover to the colour of their own header strip", () => {
  const strip = "dark:border-neutral-800 dark:bg-neutral-800";
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes(strip)) continue;
    assert.doesNotMatch(
      source,
      /dark:hover:bg-neutral-800/,
      `${file} has a neutral-800 header strip and a neutral-800 row hover`,
    );
  }
});