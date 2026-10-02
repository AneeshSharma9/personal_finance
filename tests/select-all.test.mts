import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { selectAll, selectAllProps } from "@/lib/select-all";

/**
 * Select-all, applied across the app.
 *
 * The handler itself is trivial; what is worth guarding is the *coverage*, because
 * the failure mode is silent - a field without it simply behaves like every field
 * did before, and nothing anywhere reports that. So these tests assert which
 * components carry it and, more usefully, that the fields which must NOT have it
 * still do not.
 */

/** Every input in the app, classified by whether it should select all. */
const SHOULD_SELECT = [
  "src/components/budget-editor.tsx",
  "src/components/budget-worksheet-form.tsx",
  "src/components/loan-actions.tsx",
  "src/components/manual-loans.tsx",
  "src/components/merge-buckets.tsx",
  "src/components/rules-editor.tsx",
  "src/components/unlink-controls.tsx",
];

/**
 * Deliberately excluded, with the reason. These are the cases that look like they
 * should be included and are not.
 */
const SHOULD_NOT_SELECT = {
  "src/components/login-form.tsx": ["password"],
  "src/app/(app)/transactions/page.tsx": ["search"],
};

const read = (path: string): string => readFileSync(path, "utf8");

test("selectAll selects the field's whole contents", () => {
  let called = 0;
  selectAll({ currentTarget: { select: () => { called += 1; } } as unknown as HTMLInputElement });
  assert.equal(called, 1, "and only once");
});

test("both handlers are the same function", () => {
  /*
   * If these ever diverge, one path silently stops selecting: `onFocus` covers
   * arriving by keyboard and `onClick` by mouse. Keeping them one function is what
   * makes that impossible rather than merely unlikely.
   */
  assert.equal(selectAllProps.onFocus, selectAll);
  assert.equal(selectAllProps.onClick, selectAll);
  assert.deepEqual(Object.keys(selectAllProps).sort(), ["onClick", "onFocus"]);
});

test("every overwrite-whole-field component carries the helper", () => {
  for (const path of SHOULD_SELECT) {
    const source = read(path);
    assert.ok(
      source.includes('from "@/lib/select-all"'),
      `${path} should import selectAllProps`,
    );
    const spreads = source.match(/\{\.\.\.selectAllProps\}/g) ?? [];
    assert.ok(spreads.length > 0, `${path} should spread it onto a field`);
  }
});

test("no component defines its own copy of the handler", () => {
  // One definition, in the lib. A second copy is how the two start drifting.
  const offenders: string[] = [];
  for (const file of readdirSync("src/components")) {
    if (!file.endsWith(".tsx")) continue;
    const source = read(`src/components/${file}`);
    if (/function selectAll\b/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "selectAll should only be defined once, in select-all.ts");
});

test("the excluded fields are still excluded", () => {
  for (const [path, why] of Object.entries(SHOULD_NOT_SELECT)) {
    const source = read(path);
    assert.ok(
      !source.includes("selectAllProps"),
      `${path} must not select all - ${why}`,
    );
  }
});

test("checkboxes and radios never select all", () => {
  /*
   * Spreading the props onto one is harmless at runtime - there is no text to
   * select - but it is noise that reads as intent, so it is kept out.
   */
  for (const path of SHOULD_SELECT) {
    const source = read(path);
    const inputs = source.split("<input").slice(1);
    for (const chunk of inputs) {
      if (/type="(checkbox|radio)"/.test(chunk.slice(0, 400))) {
        assert.ok(
          !chunk.slice(0, 200).includes("selectAllProps"),
          `${path} spreads select all onto a checkbox or radio`,
        );
      }
    }
  }
});