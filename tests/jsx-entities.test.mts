import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * HTML entities must not hide inside JS string literals.
 *
 * JSX decodes `&larr;`, `&middot;` and friends only in *children* position. The
 * moment one moves inside a `{...}` expression it becomes an ordinary string and
 * JSX passes it through untouched, so the entity renders as the literal text
 * "&larr;" instead of the character.
 *
 * This shipped. The bucket page's back link read
 * `{range ? "\u2190 Cash flow" : "&larr; Budgets"}` — both branches meant to show an
 * arrow, one written with an escape and one with an entity, and the page rendered
 * the entity in plain sight. Nothing caught it: the type is `string` either way,
 * eslint has no rule for it, and the build faithfully compiles a correct string that
 * happens to contain an ampersand. It was only wrong when a human looked.
 *
 * Fixing it invites the mirror mistake — writing the entity where JSX text *would*
 * have worked — so the check is on the entity, not on the symptom.
 *
 * ## Why this scans rather than pattern-matches
 *
 * A regex cannot tell this apart from correct code. On
 * `{months > 1 ? " (x)" : ""} &middot;{" "}` the entity is correctly in children
 * position, but it sits *between* two separate string literals, and a naive
 * "quote ... entity ... quote" match happily spans the `}` and `{` between them and
 * reports a false positive. So this walks the string properly: it finds real quoted
 * runs, and requires the run's interior to contain no braces. A genuine
 * `"&larr; Budgets"` has no braces inside and is caught; two strings either side of
 * some JSX has braces in the way and is not.
 *
 * Comments are stripped first, or this file and any explanation of the bug would
 * report themselves.
 */

/** `&name;`, `&#NN;` or `&#xNN;` - the shapes a JSX decoder would have handled. */
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#\d{1,5}|#[xX][0-9a-fA-F]{1,5});/;

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...tsxFiles(path));
    else if (entry.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** Remove block and line comments, preserving line numbering. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, lead: string) => lead);
}

const QUOTES = new Set(['"', "'", "`"]);

/** Quoted runs on a line whose interior holds no braces. */
function braceFreeStringRuns(line: string): string[] {
  const runs: string[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const quote = line[i]!;
    if (!QUOTES.has(quote)) continue;
    let interior = "";
    let j = i + 1;
    for (; j < line.length; j += 1) {
      const char = line[j]!;
      if (char === "\\") {
        interior += char + (line[j + 1] ?? "");
        j += 1;
        continue;
      }
      if (char === quote) break;
      interior += char;
    }
    if (j >= line.length) continue; // unterminated: not a run
    // Braces inside mean this is not one self-contained string - it is code with
    // strings in it, which is exactly the false positive to avoid.
    if (!/[{}]/.test(interior)) runs.push(interior);
    i = j;
  }
  return runs;
}

const files = tsxFiles("src");

test("the scan actually found the components", () => {
  assert.ok(files.length > 10, `expected the app's components, found ${files.length}`);
});

test("the scanner does not flag an entity that is correctly in JSX children", () => {
  /*
   * The exact shape that produced a false positive while this rule was a regex.
   * If this ever fails, the check has become too noisy to be trusted and will be
   * ignored - which is worse than not having it.
   */
  const line = '{months > 1 ? ` (${months} months)` : ""} &middot;{" "}';
  const offenders = braceFreeStringRuns(line).filter((run) => ENTITY.test(run));
  assert.deepEqual(offenders, []);
});

test("the scanner does catch an entity inside a ternary branch", () => {
  const line = '{range ? "\\u2190 Cash flow" : "&larr; Budgets"}';
  const offenders = braceFreeStringRuns(line).filter((run) => ENTITY.test(run));
  assert.deepEqual(offenders, ["&larr; Budgets"]);
});

const offenders: string[] = [];
for (const file of files) {
  const source = stripComments(readFileSync(file, "utf8"));
  source.split("\n").forEach((line, index) => {
    for (const run of braceFreeStringRuns(line)) {
      if (ENTITY.test(run)) {
        offenders.push(`${file}:${index + 1}  "${run}"`);
        break;
      }
    }
  });
}

test("no HTML entity is hidden inside a JS string literal", () => {
  assert.deepEqual(
    offenders,
    [],
    "these render the entity as literal text; use the escape (\\u2190) instead:\n" +
      offenders.join("\n"),
  );
});

test("the back link that shipped broken is clean", () => {
  const page = stripComments(readFileSync("src/app/(app)/budgets/[id]/page.tsx", "utf8"));
  assert.doesNotMatch(page, /&larr;/);
  assert.match(page, /\\u2190/, "and the escape is used instead");
});
