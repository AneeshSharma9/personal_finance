import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The client/server boundary around rule matching.
 *
 * This was a real build failure, not a hypothetical one. `rules-editor.tsx` is a
 * client component and imported `summariseMatches` from the module holding
 * `transactionsForRule`, which imports `matchesStoredRule` from `rules.ts` — and
 * `rules.ts` begins with `import "server-only"`.
 *
 * The important part is what the checks said. `tsc` passed, `eslint` passed, and all
 * 232 tests passed. Only `next build` failed, with fourteen errors, because type
 * erasure means a *type* import is free while a *value* import drags the whole
 * chain into the browser bundle. Nothing in the fast feedback loop can see this, so
 * it is worth a test that reads the import graph.
 */

const read = (path: string): string => readFileSync(path, "utf8");

const CLIENT_COMPONENT = "src/components/rules-editor.tsx";
/**
 * Module *specifiers*, not paths: the import graph is written in these, and
 * comparing a path against a specifier would fail for the right reason and the
 * wrong message.
 */
const ENGINE = "@/lib/rules";
const MATCHING = "@/lib/rule-matches";
const CLIENT_SAFE_TYPES = "@/lib/rule-match-types";

const localImports = (path: string): string[] =>
  [...read(path).matchAll(/from "(@\/[^"]+)"/g)].map((match) => match[1]!);

test("the rules editor never reaches the server-only chain", () => {
  const imports = localImports(CLIENT_COMPONENT);
  for (const forbidden of [ENGINE, MATCHING]) {
    assert.ok(
      !imports.includes(forbidden),
      `${CLIENT_COMPONENT} imports ${forbidden}, which depends on "server-only"`,
    );
  }
});

test("the editor gets its types from the client-safe module", () => {
  const source = read(CLIENT_COMPONENT);
  assert.ok(
    source.includes(`import type { RuleMatches } from "${CLIENT_SAFE_TYPES}"`),
    "types are erased, so importing them across the boundary is free",
  );
});

test("the client-safe modules have no path to the engine", () => {
  /*
   * `rule-match-types.ts` must import nothing at all, or a later convenience import
   * would quietly reintroduce the whole problem one file away from where it was
   * fixed.
   */
  assert.deepEqual(
    localImports("src/lib/rule-match-types.ts"),
    [],
    "rule-match-types.ts should import nothing",
  );

  // The summary needs the type and nothing else.
  assert.deepEqual(
    localImports("src/lib/rule-match-summary.ts"),
    [CLIENT_SAFE_TYPES],
    "the summary should depend on the types and nothing else",
  );
});

test("the matcher still uses the engine's own function", () => {
  const imports = localImports("src/lib/rule-matches.ts");
  assert.ok(
    imports.includes(ENGINE),
    "otherwise the count on the rules page is a second implementation, free to drift",
  );
  assert.ok(
    read("src/lib/rule-matches.ts").includes("matchesStoredRule"),
    "and it should be calling the shared matcher, not its own logic",
  );
});

test("the server-only marker is where it should be", () => {
  // Matched as an import, not a substring: both files *mention* server-only in
  // their doc comments, which is precisely why a substring check is useless here.
  assert.ok(
    /^import "server-only";/m.test(read("src/lib/rules.ts")),
    "the engine must stay server-only; that is what caught this",
  );
  assert.ok(
    !/^import "server-only";/m.test(read("src/lib/rule-match-types.ts")),
    "and the client-facing module must not claim to be either",
  );
});